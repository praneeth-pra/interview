// Settings from the environment (Railway variables). Read once at startup.
import { EMAIL_RE, normEmail } from "./util";

export const PORT = Number(Bun.env.PORT ?? 3000);
export const DATA_DIR = (Bun.env.DATA_DIR ?? "").trim().replace(/\/+$/, "");
export const HOST_NAME = (Bun.env.HOST_NAME ?? "Hi-Techie").trim();
export const EVENT_NAME = (Bun.env.EVENT_NAME ?? "Interview").trim();
export const RESEND_API_KEY = (Bun.env.RESEND_API_KEY ?? "").trim();
export const RESEND_URL = (Bun.env.RESEND_API_URL ?? "https://api.resend.com/emails").trim();
export const EMAIL_FROM = (Bun.env.EMAIL_FROM ?? "").trim() || HOST_NAME.replace(/[<>"]/g, "") + " <interviews@hi-techie.dev>";
export const HOST_EMAILS = (Bun.env.HOST_EMAIL ?? "")
  .split(/[,;\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
export const MEETING_LINK = (Bun.env.MEETING_LINK ?? "").trim();
export const EVENT_LOCATION = (
  Bun.env.EVENT_LOCATION ?? "#775, 2nd floor, 2nd cross, Tulsi theatre road, Marathahalli, Bengaluru, 560037."
).trim();
export const EVENT_DESCRIPTION = (
  Bun.env.EVENT_DESCRIPTION ?? "Only book a slot once you have the interview email from the company."
).trim();
export const PUBLIC_URL = (Bun.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
// One-time cleanup: "Name@YYYY-MM-DD" entries (IST date), comma separated. Matching bookings are deleted on start.
export const REMOVE_BOOKINGS = (Bun.env.REMOVE_BOOKINGS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const TZ = "Asia/Kolkata";
export const IST_OFFSET_MIN = 330; // India has no DST, a fixed offset is exact
export const DAY_START_MIN = Math.round((Number(Bun.env.DAY_START_HOUR) || 9) * 60);
export const DAY_END_MIN = Math.round((Number(Bun.env.DAY_END_HOUR) || 21) * 60);
export const SLOT_STEP_MIN = 30;
export const DURATIONS = [30, 60, 90];
// Candidates can book today plus the next BOOKING_DAYS - 1 days (default 7: today and the next 6 days).
export const DAYS_AHEAD = Math.min(60, Math.max(1, Math.round(Number(Bun.env.BOOKING_DAYS) || 7)));
export const DEFAULT_INTERVIEWERS = ["Praneeth", "Hareesh", "Shiva"];
// Admin sign-in. ADMIN_EMAILS lists the owners; owners can add more admins in the admin page (admins.json).
// Anyone on the list signs in with a 6-digit code sent by email. Sessions are kept on the volume by a hash of the
// cookie, so removing someone from the list signs out all their devices at once.
export const OWNER_EMAILS = [
  ...new Set(
    (Bun.env.ADMIN_EMAILS ?? "")
      .split(/[,;\s]+/)
      .map(normEmail)
      .filter((e) => EMAIL_RE.test(e)),
  ),
];
// Sign-in is always required, even when ADMIN_EMAILS is missing (then only admins added earlier can sign in), so a
// deleted or mistyped variable locks the admin page instead of opening it. ADMIN_OPEN=1 turns sign-in off, for local
// testing only, and only while ADMIN_EMAILS is empty.
export const ADMIN_OPEN = (Bun.env.ADMIN_OPEN ?? "").trim() === "1";
export const LOGIN_ON = OWNER_EMAILS.length > 0 || !ADMIN_OPEN;
// The largest payment receipt (/payment), in MB (default 1). The form doesn't show it; a bigger file gets a clear error.
export const RECEIPT_MAX = Math.round(Math.min(20, Math.max(0.1, Number(Bun.env.RECEIPT_MAX_MB) || 1)) * 1024 * 1024);
// The largest request the server reads: a payment with the largest receipt, with plenty of room to spare.
export const MAX_BODY = Math.max(2 * 1024 * 1024, RECEIPT_MAX + 512 * 1024);
const BACKUP_TO = (Bun.env.BACKUP_EMAIL ?? "")
  .split(/[,;\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);
export const BACKUP_RECIPIENTS = BACKUP_TO.length ? BACKUP_TO : HOST_EMAILS;
export const BACKUP_HOUR = /^\d{1,2}$/.test((Bun.env.BACKUP_HOUR ?? "").trim()) ? Math.min(23, Number(Bun.env.BACKUP_HOUR)) : 2;
export const BACKUP_KEEP = 14;
// The backup email goes out once this many days have passed since the last one.
export const BACKUP_EMAIL_DAYS = 7;
