// Admin sign-in and sign-out.
import { CODE_MINUTES, checkSignInCode, deviceName, dropSessions, sendSignInCode, sessionCookie, sessionOf } from "../auth";
import { LOGIN_ON } from "../config";
import { isAdmin, liveSession, sessionsStore } from "../data";
import { type Srv, json, readJson, underLimit, clientIp } from "../http";
import { saveStore } from "../store";
import { EMAIL_RE, normEmail, sha256 } from "../util";
import { randomBytes } from "node:crypto";

export async function authRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if ((path === "/admin/login/code" || path === "/admin/login") && method === "POST") {
    if (!LOGIN_ON) return json({ ok: true });
    const body = await readJson(req, 1000);
    if (body instanceof Response) return body;
    const email = normEmail(body?.email);
    if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email address." }, 400);
    const ip = clientIp(req, srv);
    if (path === "/admin/login/code") {
      if (!underLimit("code:" + ip, 20, 3600000))
        return json({ error: "Too many codes asked for from this network. Try again in an hour." }, 429);
      const r = await sendSignInCode(email);
      if (r === "wait") return json({ error: "A code was just sent. Wait 30 seconds before asking for another." }, 429);
      if (r === "limit") return json({ error: "Too many codes asked for this email. Try again in an hour." }, 429);
      if (r === "failed") return json({ error: "Couldn't send the email. Try again in a minute." }, 502);
      return json({ ok: true, minutes: CODE_MINUTES });
    }
    if (!underLimit("try:" + ip, 30, 600000)) return json({ error: "Too many tries. Wait 10 minutes and try again." }, 429);
    const r = checkSignInCode(email, String(body?.code ?? "").replace(/\D/g, ""));
    // one answer for every failure, so trying codes can't tell an admin's email from anyone else's
    if (r !== "ok") return json({ error: "That code isn't right or has expired. Check the latest email, or ask for a new code." }, 401);
    if (!isAdmin(email)) return json({ error: "This email isn't on the admin list any more." }, 403);
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    // the newest 20 devices per person stay signed in
    const mine = sessionsStore.data.sessions.filter((v) => v.email === email).sort((x, y) => Date.parse(y.seen) - Date.parse(x.seen));
    const dropIds = new Set(mine.slice(19).map((v) => v.id));
    sessionsStore.data.sessions = sessionsStore.data.sessions.filter((v) => !dropIds.has(v.id) && liveSession(v));
    sessionsStore.data.sessions.push({ id: sha256(token), email, created: now, seen: now, device: deviceName(req) });
    try {
      await saveStore(sessionsStore);
    } catch {
      return json({ error: "Couldn't sign in. Try again." }, 500);
    }
    console.log("admin sign-in: " + email + " (" + deviceName(req) + ")");
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(token, 400 * 86400) });
  }
  if (path === "/admin/logout" && method === "POST") {
    const me = LOGIN_ON ? sessionOf(req) : null;
    if (me) await dropSessions((v) => v.id !== me.id).catch(() => {});
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  return null;
}
