// Everything the app keeps: the types and the file store for each kind of data.
import { DEFAULT_INTERVIEWERS, LOGIN_ON, OWNER_EMAILS } from "./config";
import { fileStore, loadStore, type FileStore } from "./store";
import { DAY_MS, EMAIL_RE, normEmail } from "./util";

export type Booking = {
  id: string;
  name: string;
  email: string;
  company: string;
  round: string;
  start: string;
  end: string;
  duration: number;
  createdAt: string;
  cancelled: boolean;
  cancelledAt: string;
  source?: "calendly" | "admin";
  seq?: number;
  rescheduledAt?: string;
  cancelReason?: string;
  cancelledBy?: "candidate" | "host";
  prevStart?: string;
  prevEnd?: string;
  rescheduledBy?: "candidate" | "host";
  // set by an admin after the start time when the interview didn't take place
  missed?: "noshow" | "other";
  missedAt?: string;
  // the round's result, set by an admin from the booking panel; no value means Scheduled
  outcome?: "cleared" | "rejected" | "hold";
  outcomeAt?: string;
};
export const activeBookings = () => bookingsStore.data.bookings.filter((b) => !b.cancelled);
export const bookingsStore = fileStore<{ bookings: Booking[] }>(
  "bookings.json",
  () => ({ bookings: [] }),
  (x) => ({ bookings: Array.isArray(x?.bookings) ? x.bookings : [] }),
);
export const ivStore = fileStore<{ names: string[]; assign: Record<string, string> }>(
  "interviewers.json",
  () => ({ names: [...DEFAULT_INTERVIEWERS], assign: {} }),
  (x) => {
    const names = Array.isArray(x?.names)
      ? x.names
          .filter((n: unknown) => typeof n === "string" && n.trim())
          .map((n: string) => n.trim().slice(0, 30))
          .slice(0, 12)
      : [...DEFAULT_INTERVIEWERS];
    const assign: Record<string, string> = {};
    for (const [k, v] of Object.entries(x?.assign ?? {})) if (typeof v === "string" && v.trim()) assign[k] = v.trim().slice(0, 30);
    return { names, assign };
  },
);
// Results the admin marks per candidate and company in Analytics ("Update results"), keyed by a normalised candidate name.
type PersonResults = { results: Record<string, string>; updated: string };
const RESULT_VALUES = new Set(["cleared", "notcleared", "hold", "offer", "withdrew"]);
function normResults(v: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [c, r] of Object.entries(v ?? {})) if (c && c.length <= 120 && typeof r === "string" && RESULT_VALUES.has(r)) out[c] = r;
  return out;
}
// Company names an admin said are the same company (analytics "Same company as…"): lower-cased name → name it joins.
function normJoins(v: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [from, to] of Object.entries(v ?? {})) {
    const f = from.trim().toLowerCase();
    const t = typeof to === "string" ? to.trim().toLowerCase() : "";
    if (f && t && f !== t && f.length <= 120 && t.length <= 120) out[f] = t;
  }
  return out;
}
export const resultsStore = fileStore<{ people: Record<string, PersonResults>; joins: Record<string, string> }>(
  "results.json",
  () => ({ people: {}, joins: {} }),
  (x) => {
    const people: Record<string, PersonResults> = {};
    for (const [k, v] of Object.entries(x?.people ?? {})) {
      if (!k || k.length > 200) continue;
      const results = normResults((v as any)?.results);
      if (Object.keys(results).length) people[k] = { results, updated: String((v as any)?.updated ?? "") };
    }
    return { people, joins: normJoins(x?.joins) };
  },
);
export const allowStore = fileStore<{ enabled: boolean; emails: string[] }>(
  "allowlist.json",
  () => ({ enabled: false, emails: [] }),
  (x) => ({
    enabled: x?.enabled === true,
    emails: [...new Set<string>((Array.isArray(x?.emails) ? x.emails : []).map(normEmail).filter((e: string) => EMAIL_RE.test(e)))],
  }),
);
export const emailAllowed = (email: string) => !allowStore.data.enabled || allowStore.data.emails.includes(normEmail(email));
export const adminsStore = fileStore<{ emails: string[] }>(
  "admins.json",
  () => ({ emails: [] }),
  (x) => ({
    emails: [...new Set<string>((Array.isArray(x?.emails) ? x.emails : []).map(normEmail).filter((e: string) => EMAIL_RE.test(e)))].slice(
      0,
      50,
    ),
  }),
);
export type Session = { id: string; email: string; created: string; seen: string; device: string };
export const sessionsStore = fileStore<{ sessions: Session[] }>(
  "sessions.json",
  () => ({ sessions: [] }),
  (x) => ({
    sessions: Array.isArray(x?.sessions)
      ? x.sessions.filter((v: any) => v && typeof v.id === "string" && typeof v.email === "string" && typeof v.seen === "string")
      : [],
  }),
);
export const isAdmin = (email: string) => OWNER_EMAILS.includes(email) || adminsStore.data.emails.includes(email);
// Enquiries and payments are for the owners (ADMIN_EMAILS) only, not for the admins they add. With sign-in off (local
// testing) everyone is an owner.
export const isOwner = (email: string) => !LOGIN_ON || OWNER_EMAILS.includes(email);
const SESSION_DAYS = 60; // signed out after this many days without opening the admin
export const liveSession = (v: Session) => isAdmin(v.email) && Date.parse(v.seen) + SESSION_DAYS * DAY_MS > Date.now();
// Enquiries from the public /enquiry page. The details are in enquiries.json; each resume is a file in DATA_DIR/resumes
// (kept in memory when there is no data folder).
export type Enquiry = {
  id: string;
  name: string;
  email: string;
  phone: string;
  tech: string;
  experience: string;
  createdAt: string;
  resume: { file: string; name: string; type: string; size: number };
};
// seen: when each admin (by email; "" when sign-in is off) last opened the Enquiries tab, for the unread count
export const enquiriesStore = fileStore<{ enquiries: Enquiry[]; seen: Record<string, string> }>(
  "enquiries.json",
  () => ({ enquiries: [], seen: {} }),
  (x) => ({
    enquiries: Array.isArray(x?.enquiries) ? x.enquiries.filter((v: any) => v && typeof v.id === "string" && v.resume) : [],
    seen: Object.fromEntries(Object.entries(x?.seen ?? {}).filter(([, v]) => typeof v === "string")) as Record<string, string>,
  }),
);
// Payments from the public /payment page. The details are in payments.json; each receipt is a file in DATA_DIR/receipts
// (kept in memory when there is no data folder).
export const INSTALLMENTS = { advance: "Advance", "1": "1st installment", "2": "2nd installment", "3": "3rd installment" } as const;
export type Installment = keyof typeof INSTALLMENTS;
export type Payment = {
  id: string;
  name: string;
  email: string;
  amount: number; // in rupees
  installment?: Installment; // which part of the fee it is; missing on payments from before it was asked
  // what the server read on the receipt: the typed amount is on it, or nothing readable (an admin checks it by eye)
  check?: "verified" | "unread";
  // the owner's decision, final once made: confirmed payments count in the totals, discarded ones are kept but set
  // aside. No value means it is waiting for a decision.
  decision?: "confirmed" | "discarded";
  decidedAt?: string;
  decidedBy?: string;
  createdAt: string;
  receipt: { file: string; name: string; type: string; size: number };
};
export const paymentsStore = fileStore<{ payments: Payment[] }>(
  "payments.json",
  () => ({ payments: [] }),
  (x) => ({
    payments: Array.isArray(x?.payments) ? x.payments.filter((v: any) => v && typeof v.id === "string" && v.receipt) : [],
  }),
);
export const secretStore = fileStore<{ key: string }>(
  "secret.json",
  () => ({ key: "" }),
  (x) => ({ key: typeof x?.key === "string" ? x.key : "" }),
);
// ---- Browser notifications (Web Push) for admins -----------------------------------------
// Keys and device subscriptions live in push.json on the volume. Notifications go straight from
// this server to the browser push services (Apple, Google, Mozilla, Microsoft); nothing else is involved.
// email: the admin who turned alerts on for the device ("" before it was recorded, or with sign-in off)
export type PushSub = { endpoint: string; p256dh: string; auth: string; label: string; addedAt: string; email?: string };
export const pushStore = fileStore<{ pub: string; priv: string; subs: PushSub[] }>(
  "push.json",
  () => ({ pub: "", priv: "", subs: [] }),
  (x) => ({
    pub: typeof x?.pub === "string" ? x.pub : "",
    priv: typeof x?.priv === "string" ? x.priv : "",
    subs: Array.isArray(x?.subs)
      ? x.subs.filter((v: any) => v && typeof v.endpoint === "string" && typeof v.p256dh === "string" && typeof v.auth === "string")
      : [],
  }),
);
export const backupStateStore = fileStore<{ saved: string; emailed: string }>(
  "backup-state.json",
  () => ({ saved: "", emailed: "" }),
  (x) => ({
    saved: typeof x?.saved === "string" ? x.saved : "",
    emailed: typeof x?.emailed === "string" ? x.emailed : "",
  }),
);
// Loads every store except backup-state.json, which the backup job loads once the server is listening.
export async function loadStores() {
  const all: FileStore<any>[] = [
    bookingsStore,
    ivStore,
    allowStore,
    secretStore,
    pushStore,
    resultsStore,
    adminsStore,
    enquiriesStore,
    paymentsStore,
    sessionsStore,
  ];
  for (const s of all) await loadStore(s);
}
