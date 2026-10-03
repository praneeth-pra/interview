// Admin sign-in with emailed codes, and the sessions it creates.
import { HOST_NAME, OWNER_EMAILS, RESEND_API_KEY } from "./config";
import { type Session, adminsStore, isAdmin, liveSession, sessionsStore } from "./data";
import { emailBody, sendEmail } from "./email";
import { json, saveOrUndo } from "./http";
import { closeEndedStreams } from "./live";
import { saveStore } from "./store";
import { EMAIL_RE, normEmail, safeEq, sha256 } from "./util";
import { randomInt } from "node:crypto";

const SESSION_COOKIE = "bf_admin";
// Lax, not Strict: a link to the admin page from an email or a chat app should open it signed in. Other sites still
// can't use the session: a Lax cookie goes only with top-level page visits, and changes need JSON POSTs.
export const sessionCookie = (token: string, maxAge: number) =>
  SESSION_COOKIE + "=" + token + "; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
export function sessionOf(req: Request): Session | null {
  const m = (req.headers.get("cookie") ?? "").match(/(?:^|;\s*)bf_admin=([a-f0-9]{64})/);
  if (!m) return null;
  const id = sha256(m[1]);
  const found = sessionsStore.data.sessions.find((v) => v.id === id);
  if (!found || !liveSession(found)) return null;
  // keep active devices signed in; write at most a few times a day
  if (Date.now() - Date.parse(found.seen) > 6 * 3600000) {
    found.seen = new Date().toISOString();
    saveStore(sessionsStore).catch(() => {});
  }
  return found;
}
export function dropSessions(keep: (v: Session) => boolean) {
  const before = sessionsStore.data.sessions.length;
  sessionsStore.data.sessions = sessionsStore.data.sessions.filter((v) => keep(v) && liveSession(v));
  closeEndedStreams();
  return sessionsStore.data.sessions.length !== before ? saveStore(sessionsStore) : Promise.resolve();
}
export function deviceName(req: Request) {
  const ua = req.headers.get("user-agent") ?? "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : "Browser";
  const app = /EdgA?\//.test(ua)
    ? "Edge"
    : /CriOS|Chrome\//.test(ua)
      ? "Chrome"
      : /FxiOS|Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : "";
  return app ? os + " · " + app : os;
}
// Emailed codes (signing in, deleting an onboarding form) live in memory for 10 minutes; five wrong tries end a code.
// Asking for a sign-in code is limited per email (one code every 30 seconds, five an hour) and per network address,
// the same whether or not the email is an admin.
export const CODE_MINUTES = 10;
const pendingCodes = new Map<string, { hash: string; exp: number; tries: number }>();
const codeAsks = new Map<string, number[]>();
const codeHash = (key: string, code: string) => sha256(key + ":" + code);
// A new 6-digit code for key (an email, or what it unlocks), replacing any earlier one.
export function newCode(key: string) {
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  pendingCodes.set(key, { hash: codeHash(key, code), exp: Date.now() + CODE_MINUTES * 60000, tries: 0 });
  return code;
}
export function checkCode(key: string, code: string): "ok" | "wrong" | "expired" | "tries" {
  const p = pendingCodes.get(key);
  if (!p || p.exp < Date.now()) {
    pendingCodes.delete(key);
    return "expired";
  }
  if (p.tries >= 5) {
    pendingCodes.delete(key);
    return "tries";
  }
  if (!safeEq(codeHash(key, code), p.hash)) {
    p.tries++;
    return "wrong";
  }
  pendingCodes.delete(key);
  return "ok";
}
export async function sendSignInCode(email: string): Promise<"ok" | "wait" | "limit" | "failed"> {
  const now = Date.now();
  const asks = (codeAsks.get(email) ?? []).filter((t) => t > now - 3600000);
  if (asks.length && now - asks[asks.length - 1] < 30000) return "wait";
  if (asks.length >= 5) return "limit";
  asks.push(now);
  codeAsks.set(email, asks);
  if (!isAdmin(email)) return "ok";
  const code = newCode(email);
  if (!RESEND_API_KEY) {
    console.log("sign-in code for " + email + ": " + code + " (email is off, so it is only shown here)");
    return "ok";
  }
  const body = emailBody({
    heading: "Your sign-in code",
    intro: "Enter this code on the " + HOST_NAME + " admin sign-in page. It works for " + CODE_MINUTES + " minutes.",
    rows: [["Code", code]],
    note: "If you didn't try to sign in, you can ignore this email. Nobody can sign in without the code.",
  });
  // the subject shows the code in the phone's notification; sendEmail logs only the part before the colon
  return (await sendEmail({ to: [email], subject: "Sign-in code: " + code, ...body })) ? "ok" : "failed";
}
export const checkSignInCode = checkCode;
export const adminsView = (me: string) => ({ owners: [...OWNER_EMAILS].sort(), emails: [...adminsStore.data.emails].sort(), me });
// POST /admin/api/admins from an owner: the full list of added admins. Owners (ADMIN_EMAILS) stay whatever the list says;
// anyone taken off it is signed out on every device.
export async function setAdmins(list: unknown, me: string): Promise<Response> {
  if (!Array.isArray(list) || list.length > 50) return json({ error: "You can have up to 50 admins." }, 400);
  const emails = [...new Set<string>(list.map(normEmail))];
  const bad = emails.find((e) => !EMAIL_RE.test(e) || e.length > 200);
  if (bad !== undefined) return json({ error: (bad || "An empty entry") + " isn't a valid email address." }, 400);
  const prev = adminsStore.data.emails;
  adminsStore.data.emails = emails.filter((e) => !OWNER_EMAILS.includes(e));
  const failed = await saveOrUndo(adminsStore, () => (adminsStore.data.emails = prev));
  if (failed) return failed;
  await dropSessions((v) => isAdmin(v.email)).catch(() => {});
  return json(adminsView(me));
}
