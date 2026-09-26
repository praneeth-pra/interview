// Admin sign-in with emailed codes, and the sessions it creates.
import { HOST_NAME, OWNER_EMAILS, RESEND_API_KEY } from "./config";
import { type Session, adminsStore, isAdmin, liveSession, sessionsStore } from "./data";
import { emailBody, sendEmail } from "./email";
import { closeEndedStreams } from "./live";
import { saveStore } from "./store";
import { safeEq, sha256 } from "./util";
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
// Sign-in codes live in memory for 10 minutes; five wrong tries end a code. Asking is limited per email (one code
// every 30 seconds, five an hour) and per network address, the same whether or not the email is an admin.
export const CODE_MINUTES = 10;
const pendingCodes = new Map<string, { hash: string; exp: number; tries: number }>();
const codeAsks = new Map<string, number[]>();
const codeHash = (email: string, code: string) => sha256(email + ":" + code);
export async function sendSignInCode(email: string): Promise<"ok" | "wait" | "limit" | "failed"> {
  const now = Date.now();
  const asks = (codeAsks.get(email) ?? []).filter((t) => t > now - 3600000);
  if (asks.length && now - asks[asks.length - 1] < 30000) return "wait";
  if (asks.length >= 5) return "limit";
  asks.push(now);
  codeAsks.set(email, asks);
  if (!isAdmin(email)) return "ok";
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  pendingCodes.set(email, { hash: codeHash(email, code), exp: now + CODE_MINUTES * 60000, tries: 0 });
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
export function checkSignInCode(email: string, code: string): "ok" | "wrong" | "expired" | "tries" {
  const p = pendingCodes.get(email);
  if (!p || p.exp < Date.now()) {
    pendingCodes.delete(email);
    return "expired";
  }
  if (p.tries >= 5) {
    pendingCodes.delete(email);
    return "tries";
  }
  if (!safeEq(codeHash(email, code), p.hash)) {
    p.tries++;
    return "wrong";
  }
  pendingCodes.delete(email);
  return "ok";
}
export const adminsView = (me: string) => ({ owners: [...OWNER_EMAILS].sort(), emails: [...adminsStore.data.emails].sort(), me });
