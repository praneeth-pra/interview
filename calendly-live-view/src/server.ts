import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, hkdfSync, randomBytes, randomInt, sign as cryptoSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { asset, assetList, compressed, encode, readData, respond, template } from "./assets";
import { deflateSync } from "node:zlib";
import { sameCompany } from "./same-company";
const KNOWN_COMPANIES: string[] = JSON.parse(readData("companies.json"));
const ICON = encode(readFileSync(join(import.meta.dir, "../public/icon.png")), "image/png");
for (const a of assetList()) console.log("asset " + a.url + " (" + a.raw + " bytes, " + a.br + " compressed)");
const PORT = Number(Bun.env.PORT ?? 3000);
const DATA_DIR = (Bun.env.DATA_DIR ?? "").trim().replace(/\/+$/, "");
const HOST_NAME = (Bun.env.HOST_NAME ?? "Hi-Techie").trim();
const EVENT_NAME = (Bun.env.EVENT_NAME ?? "Interview").trim();
const RESEND_API_KEY = (Bun.env.RESEND_API_KEY ?? "").trim();
const RESEND_URL = (Bun.env.RESEND_API_URL ?? "https://api.resend.com/emails").trim();
const EMAIL_FROM = (Bun.env.EMAIL_FROM ?? "").trim() || HOST_NAME.replace(/[<>"]/g, "") + " <interviews@hi-techie.dev>";
const HOST_EMAILS = (Bun.env.HOST_EMAIL ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
const MEETING_LINK = (Bun.env.MEETING_LINK ?? "").trim();
const EVENT_LOCATION = (Bun.env.EVENT_LOCATION ?? "#775, 2nd floor, 2nd cross, Tulsi theatre road, Marathahalli, Bengaluru, 560037.").trim();
const EVENT_DESCRIPTION = (Bun.env.EVENT_DESCRIPTION ?? "Please block the time only if the interview mail is received.").trim();
const PUBLIC_URL = (Bun.env.PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
// One-time cleanup: "Name@YYYY-MM-DD" entries (IST date), comma separated. Matching bookings are deleted on start.
const REMOVE_BOOKINGS = (Bun.env.REMOVE_BOOKINGS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TZ = "Asia/Kolkata";
const IST_OFFSET_MIN = 330; // India has no DST, a fixed offset is exact
const DAY_START_MIN = Math.round((Number(Bun.env.DAY_START_HOUR) || 9) * 60);
const DAY_END_MIN = Math.round((Number(Bun.env.DAY_END_HOUR) || 21) * 60);
const SLOT_STEP_MIN = 30;
const DURATIONS = [30, 60, 90];
// Candidates can book today plus the next BOOKING_DAYS - 1 days (default 7: today and the next 6 days).
const DAYS_AHEAD = Math.min(60, Math.max(1, Math.round(Number(Bun.env.BOOKING_DAYS) || 7)));
const DEFAULT_INTERVIEWERS = ["Praneeth", "Hareesh", "Shiva"];
type Booking = {
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
};
type FileStore<T> = { file: string; data: T; ok: boolean; chain: Promise<void>; norm: (x: any) => T };
function fileStore<T>(file: string, empty: () => T, norm: (x: any) => T): FileStore<T> {
return { file, data: empty(), ok: false, chain: Promise.resolve(), norm };
}
const bookingsStore = fileStore<{ bookings: Booking[] }>(
"bookings.json",
() => ({ bookings: [] }),
(x) => ({ bookings: Array.isArray(x?.bookings) ? x.bookings : [] }),
);
const ivStore = fileStore<{ names: string[]; assign: Record<string, string> }>(
"interviewers.json",
() => ({ names: [...DEFAULT_INTERVIEWERS], assign: {} }),
(x) => {
const names = Array.isArray(x?.names)
? x.names.filter((n: unknown) => typeof n === "string" && n.trim()).map((n: string) => n.trim().slice(0, 30)).slice(0, 12)
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
const resultsStore = fileStore<{ people: Record<string, PersonResults>; joins: Record<string, string> }>(
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const allowStore = fileStore<{ enabled: boolean; emails: string[] }>(
"allowlist.json",
() => ({ enabled: false, emails: [] }),
(x) => ({
enabled: x?.enabled === true,
emails: [...new Set<string>((Array.isArray(x?.emails) ? x.emails : []).map(normEmail).filter((e: string) => EMAIL_RE.test(e)))],
}),
);
const emailAllowed = (email: string) => !allowStore.data.enabled || allowStore.data.emails.includes(normEmail(email));
// Admin sign-in. ADMIN_EMAILS (the owners) turns it on; owners can add more admins in the admin page (admins.json).
// Anyone on the list signs in with a 6-digit code sent by email. Sessions are kept on the volume by a hash of the
// cookie, so removing someone from the list signs out all their devices at once.
const OWNER_EMAILS = [...new Set((Bun.env.ADMIN_EMAILS ?? "").split(/[,;\s]+/).map(normEmail).filter((e) => EMAIL_RE.test(e)))];
const LOGIN_ON = OWNER_EMAILS.length > 0;
const adminsStore = fileStore<{ emails: string[] }>(
"admins.json",
() => ({ emails: [] }),
(x) => ({ emails: [...new Set<string>((Array.isArray(x?.emails) ? x.emails : []).map(normEmail).filter((e: string) => EMAIL_RE.test(e)))].slice(0, 50) }),
);
type Session = { id: string; email: string; created: string; seen: string; device: string };
const sessionsStore = fileStore<{ sessions: Session[] }>(
"sessions.json",
() => ({ sessions: [] }),
(x) => ({
sessions: Array.isArray(x?.sessions)
? x.sessions.filter((v: any) => v && typeof v.id === "string" && typeof v.email === "string" && typeof v.seen === "string")
: [],
}),
);
const isAdmin = (email: string) => OWNER_EMAILS.includes(email) || adminsStore.data.emails.includes(email);
// Enquiries from the public /enquiry page. The details are in enquiries.json; each resume is a file in DATA_DIR/resumes
// (kept in memory when there is no data folder).
type Enquiry = {
id: string;
name: string;
email: string;
phone: string;
tech: string;
experience: string;
createdAt: string;
resume: { file: string; name: string; type: string; size: number };
};
const enquiriesStore = fileStore<{ enquiries: Enquiry[] }>(
"enquiries.json",
() => ({ enquiries: [] }),
(x) => ({ enquiries: Array.isArray(x?.enquiries) ? x.enquiries.filter((v: any) => v && typeof v.id === "string" && v.resume) : [] }),
);
const RESUME_MAX = 1024 * 1024;
// what the first bytes of each allowed kind of file look like
const RESUME_KINDS = [
{ ext: ".pdf", type: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
{ ext: ".docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b, 0x03, 0x04] },
{ ext: ".doc", type: "application/msword", magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];
const resumesInMemory = new Map<string, Uint8Array>();
async function saveResume(file: string, bytes: Uint8Array) {
if (!DATA_DIR) return void resumesInMemory.set(file, bytes);
await mkdir(DATA_DIR + "/resumes", { recursive: true });
await Bun.write(DATA_DIR + "/resumes/" + file, bytes);
}
async function readResume(file: string): Promise<Uint8Array | null> {
if (!DATA_DIR) return resumesInMemory.get(file) ?? null;
const f = Bun.file(DATA_DIR + "/resumes/" + file);
return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}
async function removeResume(file: string) {
if (!DATA_DIR) return void resumesInMemory.delete(file);
await rm(DATA_DIR + "/resumes/" + file, { force: true });
}
function knownName(email: string) {
const e = normEmail(email);
const groups = new Map<string, { n: number; last: number; spell: Map<string, { n: number; last: number }> }>();
for (const b of bookingsStore.data.bookings) {
if (normEmail(b.email) !== e) continue;
const name = String(b.name ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
if (!name) continue;
const t = Date.parse(b.createdAt) || Date.parse(b.start) || 0;
let g = groups.get(name.toLowerCase());
if (!g) groups.set(name.toLowerCase(), (g = { n: 0, last: 0, spell: new Map() }));
g.n++;
g.last = Math.max(g.last, t);
const sp = g.spell.get(name) ?? { n: 0, last: 0 };
sp.n++;
sp.last = Math.max(sp.last, t);
g.spell.set(name, sp);
}
let best: { n: number; last: number; spell: Map<string, { n: number; last: number }> } | null = null;
for (const g of groups.values()) if (!best || g.n > best.n || (g.n === best.n && g.last > best.last)) best = g;
if (!best) return "";
const cased = (s: string) => (s !== s.toLowerCase() && s !== s.toUpperCase() ? 1 : 0);
return [...best.spell.entries()].sort((x, y) => y[1].n - x[1].n || cased(y[0]) - cased(x[0]) || y[1].last - x[1].last)[0][0];
}
const lookupHits = new Map<string, { n: number; reset: number }>();
function lookupAllowed(ip: string) {
const now = Date.now();
if (lookupHits.size > 5000) for (const [k, v] of lookupHits) if (v.reset < now) lookupHits.delete(k);
const h = lookupHits.get(ip);
if (!h || h.reset < now) {
lookupHits.set(ip, { n: 1, reset: now + 60000 });
return true;
}
return ++h.n <= 30;
}
const secretStore = fileStore<{ key: string }>("secret.json", () => ({ key: "" }), (x) => ({ key: typeof x?.key === "string" ? x.key : "" }));
async function loadStore<T>(s: FileStore<T>) {
if (!DATA_DIR) return console.log("store: memory only (" + s.file + ")");
const path = DATA_DIR + "/" + s.file;
try {
await Bun.write(DATA_DIR + "/.probe", String(Date.now()));
const f = Bun.file(path);
if (await f.exists()) {
try {
s.data = s.norm(JSON.parse(await f.text()));
} catch {
try {
s.data = s.norm(JSON.parse(await Bun.file(path + ".bak").text()));
} catch {}
}
}
s.ok = true;
console.log("store loaded: " + path);
} catch (e) {
console.log("store unavailable (" + s.file + "): " + String(e));
}
}
function saveStore<T>(s: FileStore<T>): Promise<void> {
if (!DATA_DIR || !s.ok) return Promise.resolve();
const path = DATA_DIR + "/" + s.file;
const run = s.chain.then(async () => {
const f = Bun.file(path);
if (await f.exists()) await Bun.write(path + ".bak", f);
await Bun.write(path + ".tmp", JSON.stringify(s.data));
await Bun.write(path, Bun.file(path + ".tmp"));
});
s.chain = run.catch((e) => console.log("save failed (" + s.file + "): " + String(e)));
return run;
}
const pad = (n: number) => String(n).padStart(2, "0");
function istParts(ms: number) {
const t = new Date(ms + IST_OFFSET_MIN * 60000);
return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}
const istToUtcMs = (y: number, mo: number, d: number, min: number) => Date.UTC(y, mo - 1, d, 0, min) - IST_OFFSET_MIN * 60000;
const UUID = /^[0-9a-f-]{36}$/i;
const activeBookings = () => bookingsStore.data.bookings.filter((b) => !b.cancelled);
function overlapsExisting(startMs: number, endMs: number, ignoreId = "") {
return activeBookings().some((b) => b.id !== ignoreId && Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);
}
function slotOk(startMs: number, duration: number) {
if (!(startMs > Date.now()) || startMs % 60000 !== 0) return false;
const p = istParts(startMs);
const min = p.hh * 60 + p.mm;
return min >= DAY_START_MIN && min + duration <= DAY_END_MIN && (min - DAY_START_MIN) % SLOT_STEP_MIN === 0;
}
// Midnight (IST) after the last day candidates may book.
function bookingLimitMs() {
const t = istParts(Date.now());
return istToUtcMs(t.y, t.mo, t.d + DAYS_AHEAD, 0);
}
function slotsFor(y: number, mo: number, d: number, duration: number, ignoreId = "") {
const out: number[] = [];
const now = Date.now();
for (let m = DAY_START_MIN; m + duration <= DAY_END_MIN; m += SLOT_STEP_MIN) {
const s = istToUtcMs(y, mo, d, m);
if (s > now && !overlapsExisting(s, s + duration * 60000, ignoreId)) out.push(s);
}
return out;
}
function bookableDays(duration: number, ignoreId = "") {
const today = istParts(Date.now());
const out: { key: string; open: boolean }[] = [];
for (let i = 0; i < DAYS_AHEAD; i++) {
const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
const [y, mo, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
out.push({ key: y + "-" + pad(mo) + "-" + pad(d), open: slotsFor(y, mo, d, duration, ignoreId).length > 0 });
}
return out;
}
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const JUNK_COMPANY = new Set(["na", "none", "nil", "null", "test", "nothing", "notapplicable", "self", "xyz", "abc", "no", "yes", "other", "fresher", "student", "unemployed", "confidential"]);
function companySuggestions() {
const list = KNOWN_COMPANIES.map((s) => {
const [n, ...a] = s.split("|");
return { n, a, f: 0 };
});
const byKey = new Map<string, (typeof list)[number]>();
for (const c of list) for (const t of [c.n, ...c.a]) if (!byKey.has(compact(t))) byKey.set(compact(t), c);
const typed = new Map<string, { people: Set<string>; spell: Map<string, number> }>();
for (const b of bookingsStore.data.bookings) {
const raw = String(b.company ?? "").replace(/\s+/g, " ").trim();
const k = compact(raw);
if (raw.length < 2 || raw.length > 50 || !k || JUNK_COMPANY.has(k) || /[@<>{}]|https?:|\d{5,}/.test(raw) || raw.split(" ").length > 5) continue;
const known = byKey.get(k);
if (known) {
known.f++;
continue;
}
let g = typed.get(k);
if (!g) typed.set(k, (g = { people: new Set(), spell: new Map() }));
g.people.add(String(b.email || b.name || b.id).toLowerCase());
g.spell.set(raw, (g.spell.get(raw) ?? 0) + 1);
}
for (const g of typed.values()) {
const n = [...g.spell.entries()].sort((x, y) => y[1] - x[1])[0][0];
list.push({ n, a: [], f: g.people.size });
}
return list;
}
function manageToken(id: string) {
return createHmac("sha256", secretStore.data.key).update("manage:" + id).digest("hex").slice(0, 32);
}
function tokenOk(id: string, t: unknown) {
return !!secretStore.data.key && typeof t === "string" && t.length === 32 && safeEq(t, manageToken(id));
}
function baseUrl(req: Request) {
if (PUBLIC_URL) return PUBLIC_URL;
const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
return (/^(localhost|127\.)/.test(host) ? "http://" : "https://") + host;
}
const manageUrl = (base: string, b: Booking) => base + "/b/" + b.id + "?t=" + manageToken(b.id);
const fmtIst = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o }).format(new Date(iso));
const t12 = (iso: string) => fmtIst(iso, { hour: "numeric", minute: "2-digit", hour12: true }).replace(" AM", "am").replace(" PM", "pm");
const whenText = (start: string, end: string) =>
fmtIst(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + ", " + t12(start) + " \u2013 " + t12(end) + " IST";
const dayShort = (iso: string) => fmtIst(iso, { weekday: "short", month: "short", day: "numeric" }) + ", " + t12(iso);
const firstName = (n: string) => (n.split(/[\s,]+/)[0] || "there").slice(0, 40);
const icsEsc = (s: string) => String(s).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");
const icsParam = (s: string) => '"' + String(s).replace(/["\r\n]/g, "") + '"';
const icsTime = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
function icsFold(line: string) {
let out = "";
while (line.length > 74) {
out += line.slice(0, 74) + "\r\n ";
line = line.slice(74);
}
return out + line;
}
function buildIcs(b: Booking, method: "REQUEST" | "CANCEL") {
const from = (EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? EMAIL_FROM).trim();
const desc = [EVENT_NAME + " with " + HOST_NAME, MEETING_LINK && "Join: " + MEETING_LINK, b.company && "Company: " + b.company, b.round && "Round: " + b.round]
.filter(Boolean)
.join("\n");
return (
[
"BEGIN:VCALENDAR", "PRODID:-//booking-form//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", "METHOD:" + method, "BEGIN:VEVENT",
"UID:" + b.id + "@booking-form", "SEQUENCE:" + (b.seq ?? 0), "DTSTAMP:" + icsTime(new Date().toISOString()),
"DTSTART:" + icsTime(b.start), "DTEND:" + icsTime(b.end),
"SUMMARY:" + icsEsc(EVENT_NAME + " with " + HOST_NAME), "DESCRIPTION:" + icsEsc(desc),
...(MEETING_LINK || EVENT_LOCATION ? ["LOCATION:" + icsEsc(MEETING_LINK || EVENT_LOCATION)] : []),
"ORGANIZER;CN=" + icsParam(HOST_NAME) + ":mailto:" + from,
"ATTENDEE;CN=" + icsParam(b.name) + ";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:" + b.email,
"STATUS:" + (method === "CANCEL" ? "CANCELLED" : "CONFIRMED"), "END:VEVENT", "END:VCALENDAR",
].map(icsFold).join("\r\n") + "\r\n"
);
}
type Attachment = { filename: string; content: string; content_type: string };
type Mail = { to: string[]; subject: string; html: string; text: string; ics?: { method: "REQUEST" | "CANCEL"; body: string }; replyTo?: string[]; files?: Attachment[] };
async function sendEmail(m: Mail): Promise<boolean> {
const to = m.to.filter((e) => EMAIL_RE.test(e));
if (!RESEND_API_KEY || !to.length) return false;
const attachments: Attachment[] = [
...(m.ics ? [{ filename: m.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics", content: Buffer.from(m.ics.body).toString("base64"), content_type: "text/calendar; charset=utf-8; method=" + m.ics.method }] : []),
...(m.files ?? []),
];
try {
const r = await fetch(RESEND_URL, {
method: "POST",
headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
body: JSON.stringify({
from: EMAIL_FROM,
to,
subject: m.subject,
html: m.html,
text: m.text,
...(m.replyTo?.length ? { reply_to: m.replyTo } : {}),
...(attachments.length ? { attachments } : {}),
}),
signal: AbortSignal.timeout(15000),
});
if (r.ok) console.log("email sent: " + m.subject.split(":")[0] + " (" + to.length + " recipient" + (to.length === 1 ? "" : "s") + ")");
else console.log("email failed (" + r.status + "): " + (await r.text()).slice(0, 300));
return r.ok;
} catch (e) {
console.log("email failed: " + String(e));
return false;
}
}
function emailBody(o: { heading: string; intro: string; rows: [string, string][]; buttons?: { label: string; href: string; primary?: boolean }[]; note?: string }) {
const e = (s: string) => Bun.escapeHTML(s);
const rows = o.rows.filter((r) => r[1]);
const rowHtml = rows
.map(([k, v]) => `<tr><td style="padding:6px 18px 6px 0;color:#6b6b6b;vertical-align:top;white-space:nowrap">${e(k)}</td><td style="padding:6px 0;color:#1a1a1a;font-weight:600">${e(v)}</td></tr>`)
.join("");
const btns = (o.buttons ?? [])
.map((b) => `<a href="${e(b.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 22px;border-radius:40px;text-decoration:none;font-weight:600;font-size:15px;${b.primary ? "background:#006bff;color:#ffffff" : "border:1px solid #b2b2b2;color:#1a1a1a"}">${e(b.label)}</a>`)
.join("");
const html =
`<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">` +
`<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e6;border-radius:10px;padding:28px">` +
`<h1 style="margin:0 0 8px;font-size:20px">${e(o.heading)}</h1><p style="margin:0 0 20px;color:#555555;font-size:15px;line-height:1.5">${e(o.intro)}</p>` +
`<table role="presentation" style="border-collapse:collapse;font-size:15px;margin:0 0 22px">${rowHtml}</table>` +
(btns ? `<div>${btns}</div>` : "") +
(o.note ? `<p style="margin:16px 0 0;color:#888888;font-size:13px;line-height:1.5">${e(o.note)}</p>` : "") +
`</div></body></html>`;
const text = [o.heading, "", o.intro, "", ...rows.map(([k, v]) => k + ": " + v), "", ...(o.buttons ?? []).map((b) => b.label + ": " + b.href), ...(o.note ? ["", o.note] : [])].join("\n");
return { html, text };
}
const candidateRows = (b: Booking): [string, string][] => [
["What", EVENT_NAME + " with " + HOST_NAME],
["When", whenText(b.start, b.end)],
["Length", b.duration + " minutes"],
["Where", MEETING_LINK || EVENT_LOCATION],
];
const hostRows = (b: Booking): [string, string][] => [
["Candidate", b.name + " <" + b.email + ">"],
["When", whenText(b.start, b.end)],
["Company", b.company],
["Round", b.round],
];
const MANAGE_NOTE = "Please don't forward this email. Its links can change your booking.";
function notifyBooked(b: Booking, base: string) {
const link = manageUrl(base, b);
const c = emailBody({
heading: "Your interview is confirmed",
intro: "Hi " + firstName(b.name) + ", you're booked with " + HOST_NAME + ". The calendar invite is attached.",
rows: candidateRows(b),
buttons: [{ label: "Reschedule", href: link + "&a=reschedule" }, { label: "Cancel", href: link + "&a=cancel" }],
note: MANAGE_NOTE,
});
void sendEmail({ to: [b.email], subject: "Confirmed: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start), ...c, ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") }, replyTo: HOST_EMAILS });
if (!HOST_EMAILS.length) return;
const h = emailBody({ heading: "New booking", intro: b.name + " booked a " + b.duration + " minute " + EVENT_NAME.toLowerCase() + ".", rows: hostRows(b), buttons: [{ label: "Open calendar", href: base + "/admin", primary: true }] });
void sendEmail({ to: HOST_EMAILS, subject: "New booking: " + b.name + " \u2013 " + dayShort(b.start), ...h, ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") }, replyTo: [b.email] });
}
function notifyRescheduled(b: Booking, prevStart: string, prevEnd: string, base: string) {
const link = manageUrl(base, b);
const was: [string, string] = ["Was", whenText(prevStart, prevEnd)];
const c = emailBody({
heading: "Your interview has moved",
intro:
b.rescheduledBy === "host"
? "Hi " + firstName(b.name) + ", " + HOST_NAME + " moved your " + EVENT_NAME.toLowerCase() + " to the time below. The updated invite is attached."
: "Hi " + firstName(b.name) + ", your " + EVENT_NAME.toLowerCase() + " with " + HOST_NAME + " is now at the time below. The updated invite is attached.",
rows: [...candidateRows(b), was],
buttons: [{ label: "Reschedule", href: link + "&a=reschedule" }, { label: "Cancel", href: link + "&a=cancel" }],
note: MANAGE_NOTE,
});
void sendEmail({ to: [b.email], subject: "Updated: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start), ...c, ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") }, replyTo: HOST_EMAILS });
if (!HOST_EMAILS.length) return;
const h = emailBody({ heading: "Booking rescheduled", intro: b.rescheduledBy === "host" ? "You moved " + b.name + "'s " + EVENT_NAME.toLowerCase() + "." : b.name + " moved their " + EVENT_NAME.toLowerCase() + ".", rows: [...hostRows(b), was], buttons: [{ label: "Open calendar", href: base + "/admin", primary: true }] });
void sendEmail({ to: HOST_EMAILS, subject: "Rescheduled: " + b.name + " \u2013 " + dayShort(b.start), ...h, ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") }, replyTo: [b.email] });
}
function notifyCancelled(b: Booking, base: string) {
const byHost = b.cancelledBy === "host";
const c = emailBody({
heading: "Your interview is cancelled",
intro: byHost
? "Hi " + firstName(b.name) + ", " + HOST_NAME + " cancelled your " + EVENT_NAME.toLowerCase() + ". Reply to this email if you have questions."
: "Hi " + firstName(b.name) + ", your " + EVENT_NAME.toLowerCase() + " with " + HOST_NAME + " is cancelled, as you asked.",
rows: [["What", EVENT_NAME + " with " + HOST_NAME], ["When", whenText(b.start, b.end)], ["Reason", byHost ? b.cancelReason ?? "" : ""]],
buttons: [{ label: "Book a new time", href: base + "/", primary: true }],
});
void sendEmail({ to: [b.email], subject: "Cancelled: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start), ...c, ics: { method: "CANCEL", body: buildIcs(b, "CANCEL") }, replyTo: HOST_EMAILS });
if (!HOST_EMAILS.length) return;
const h = emailBody({
heading: "Booking cancelled",
intro: byHost ? "You cancelled " + b.name + "'s " + EVENT_NAME.toLowerCase() + " from the admin calendar." : b.name + " cancelled their " + EVENT_NAME.toLowerCase() + ".",
rows: [...hostRows(b), ["Reason", b.cancelReason ?? ""]],
});
void sendEmail({ to: HOST_EMAILS, subject: "Cancelled: " + b.name + " \u2013 " + dayShort(b.start), ...h, ics: { method: "CANCEL", body: buildIcs(b, "CANCEL") }, replyTo: [b.email] });
}
// ---- Browser notifications (Web Push) for admins -----------------------------------------
// Keys and device subscriptions live in push.json on the volume. Notifications go straight from
// this server to the browser push services (Apple, Google, Mozilla, Microsoft); nothing else is involved.
type PushSub = { endpoint: string; p256dh: string; auth: string; label: string; addedAt: string };
const pushStore = fileStore<{ pub: string; priv: string; subs: PushSub[] }>(
"push.json",
() => ({ pub: "", priv: "", subs: [] }),
(x) => ({
pub: typeof x?.pub === "string" ? x.pub : "",
priv: typeof x?.priv === "string" ? x.priv : "",
subs: Array.isArray(x?.subs) ? x.subs.filter((v: any) => v && typeof v.endpoint === "string" && typeof v.p256dh === "string" && typeof v.auth === "string") : [],
}),
);
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chrome\.google\.com)$/i;
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
function pushEndpointOk(u: string) {
try {
const x = new URL(u);
return x.protocol === "https:" && PUSH_HOSTS.test(x.hostname) && u.length < 1000;
} catch {
return false;
}
}
function vapidJwt(aud: string) {
const pub = Buffer.from(pushStore.data.pub, "base64url");
const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: pushStore.data.priv, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: "jwk" });
const head = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:alerts@hi-techie.dev" })));
return head + "." + body + "." + b64u(cryptoSign("sha256", Buffer.from(head + "." + body), { key, dsaEncoding: "ieee-p1363" }));
}
// RFC 8291 message encryption (aes128gcm), one record.
function encryptPush(sub: PushSub, text: string) {
const uaPub = Buffer.from(sub.p256dh, "base64url");
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const asPub = ecdh.getPublicKey();
const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(uaPub), Buffer.from(sub.auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
const salt = randomBytes(16);
const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
const c = createCipheriv("aes-128-gcm", cek, nonce);
const data = Buffer.concat([c.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), c.final(), c.getAuthTag()]);
const head = Buffer.alloc(21);
salt.copy(head, 0);
head.writeUInt32BE(4096, 16);
head[20] = asPub.length;
return Buffer.concat([head, asPub, data]);
}
async function pushTo(sub: PushSub, msg: object) {
try {
const r = await fetch(sub.endpoint, {
method: "POST",
headers: {
TTL: "86400",
Urgency: "high",
"Content-Encoding": "aes128gcm",
"Content-Type": "application/octet-stream",
Authorization: "vapid t=" + vapidJwt(new URL(sub.endpoint).origin) + ", k=" + pushStore.data.pub,
},
body: encryptPush(sub, JSON.stringify(msg)),
signal: AbortSignal.timeout(10000),
});
if (!r.ok) console.log("push failed (" + r.status + ") for " + sub.label + ": " + (await r.text()).slice(0, 200));
return r.status;
} catch (e) {
console.log("push failed for " + sub.label + ": " + String(e));
return 0;
}
}
async function pushAll(msg: object) {
const subs = [...pushStore.data.subs];
if (!subs.length) return;
const codes = await Promise.all(subs.map((x) => pushTo(x, msg)));
const gone = new Set(subs.filter((_, i) => codes[i] === 404 || codes[i] === 410).map((x) => x.endpoint));
if (gone.size) {
pushStore.data.subs = pushStore.data.subs.filter((x) => !gone.has(x.endpoint));
await saveStore(pushStore).catch(() => {});
}
console.log("push: sent to " + codes.filter((c) => c >= 200 && c < 300).length + " of " + subs.length + " device(s)" + (gone.size ? ", removed " + gone.size + " expired" : ""));
}
function alertAdmins(kind: "booked" | "moved" | "cancelled", b: Booking) {
if (!pushStore.data.subs.length) return;
const who = [b.name, b.company, b.round].map((x) => String(x ?? "").trim()).filter(Boolean).join(" \u00B7 ");
void pushAll({
title: kind === "booked" ? "New booking" : kind === "moved" ? "Booking rescheduled" : "Booking cancelled",
body: who + "\n" + (kind === "moved" ? "Now " : "") + dayShort(b.start) + " (" + b.duration + " min)",
tag: b.id + ":" + kind,
url: "/admin?date=" + new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(b.start)),
});
}
const pushView = () => ({ key: pushStore.data.pub, endpoints: pushStore.data.subs.map((x) => x.endpoint) });
// The service worker shows booking alerts, and makes the home-screen app open instantly and offline: admin pages are
// fetched from the network first (cached copy if offline or slower than 3s; only real admin shells are cached, never the
// sign-in page), fingerprinted /assets/ files come from the cache. Everything else, including the booking page and all
// API calls, goes straight to the network. Signing out empties the cache.
const SW_JS = `var SHELL = "admin-shell-v1", ASSETS = "admin-assets-v1";
self.addEventListener("install", function () { self.skipWaiting() });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== SHELL && k !== ASSETS }).map(function (k) { return caches.delete(k) })) }).then(function () { return self.clients.claim() }));
});
self.addEventListener("message", function (e) {
  if (e.data === "signed-out") e.waitUntil(Promise.all([caches.delete(SHELL), caches.delete(ASSETS)]));
});
var APP_PAGES = { "/admin": 1, "/admin/allowlist": 1, "/admin/analytics": 1 };
self.addEventListener("fetch", function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin) return;
  if (u.pathname.indexOf("/assets/") === 0) {
    e.respondWith(caches.open(ASSETS).then(function (c) {
      return c.match(r).then(function (hit) {
        return hit || fetch(r).then(function (res) {
          if (res.ok && /immutable/.test(res.headers.get("Cache-Control") || "")) {
            c.put(r, res.clone()).then(function () { return c.keys() }).then(function (ks) { ks.slice(0, Math.max(0, ks.length - 40)).forEach(function (k) { c.delete(k) }) });
          }
          return res;
        });
      });
    }));
    return;
  }
  if (r.mode === "navigate" && APP_PAGES[u.pathname]) {
    var fromCache = function () { return caches.open(SHELL).then(function (c) { return c.match(u.pathname) }) };
    var net = fetch(r).then(function (res) {
      if (res.ok && res.headers.get("X-App-Shell")) { var copy = res.clone(); caches.open(SHELL).then(function (c) { c.put(u.pathname, copy) }) }
      return res;
    });
    var slow = new Promise(function (ok) { setTimeout(ok, 3000) }).then(fromCache).then(function (hit) { return hit || net });
    e.respondWith(Promise.race([net, slow]).catch(function () { return fromCache().then(function (hit) { return hit || net }) }));
  }
});
self.addEventListener("push",function(e){var d={};try{d=e.data.json()}catch(x){d={body:e.data?e.data.text():""}}
e.waitUntil(self.registration.showNotification(d.title||"Hi-Techie",{body:d.body||"",tag:d.tag||undefined,renotify:!!d.tag,icon:"/icon.png",badge:"/icon.png",data:{url:d.url||"/admin"}}))});
self.addEventListener("notificationclick",function(e){e.notification.close();var url=(e.notification.data&&e.notification.data.url)||"/admin";
e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(function(ws){for(var i=0;i<ws.length;i++){var w=ws[i];if(new URL(w.url).pathname.indexOf("/admin")===0){if(w.navigate)w.navigate(url).catch(function(){});return w.focus()}}return self.clients.openWindow(url)}))});`;
const enc = new TextEncoder();
// Live admin updates, each with the session that opened it ("" when sign-in is off); a stream whose session has ended
// (signed out, or removed from the admin list) is closed at the next update.
const streams = new Map<ReadableStreamDefaultController, string>();
function closeEndedStreams() {
for (const [c, sid] of streams) {
if (!sid || sessionsStore.data.sessions.some((v) => v.id === sid && liveSession(v))) continue;
streams.delete(c);
try {
c.close();
} catch {}
}
}
const pub = (b: Booking) => ({
id: b.id, name: b.name, email: b.email, company: b.company, round: b.round, start: b.start, end: b.end, duration: b.duration,
createdAt: b.createdAt, source: b.source ?? "", cancelled: b.cancelled, cancelledAt: b.cancelledAt, cancelledBy: b.cancelledBy ?? "",
cancelReason: b.cancelReason ?? "", rescheduledAt: b.rescheduledAt ?? "", rescheduledBy: b.rescheduledBy ?? "", prevStart: b.prevStart ?? "",
missed: b.missed ?? "", missedAt: b.missedAt ?? "",
});
function adminState() {
const since = Date.now() - 30 * 86400000;
const changes = bookingsStore.data.bookings
.filter((b) => (b.cancelled ? Date.parse(b.cancelledAt) > since : Date.parse(b.rescheduledAt ?? "") > since))
.map((b) => ({ ...pub(b), kind: b.cancelled ? "cancelled" : "rescheduled", at: b.cancelled ? b.cancelledAt : b.rescheduledAt }))
.sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))
.slice(0, 40);
return {
ready: true,
build: BUILD,
email: !!RESEND_API_KEY,
hours: { start: DAY_START_MIN, end: DAY_END_MIN },
iv: { names: ivStore.data.names, assign: ivStore.data.assign },
allow: { enabled: allowStore.data.enabled, count: allowStore.data.emails.length },
events: activeBookings().map(pub).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
changes,
};
}
function send(event: string, data: unknown) {
closeEndedStreams();
const chunk = enc.encode("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
for (const c of streams.keys()) {
try {
c.enqueue(chunk);
} catch {
streams.delete(c);
}
}
}
const broadcastState = () => {
if (streams.size) send("state", adminState());
};
setInterval(() => send("tick", {}), 15000);
const SESSION_COOKIE = "bf_admin";
const DAY_MS = 86400000;
const SESSION_DAYS = 60; // signed out after this many days without opening the admin
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
function safeEq(a: string, b: string) {
const x = Buffer.from(a);
const y = Buffer.from(b);
return x.length === y.length && timingSafeEqual(x, y);
}
// Lax, not Strict: a link to the admin page from an email or a chat app should open it signed in. Other sites still
// can't use the session: a Lax cookie goes only with top-level page visits, and changes need JSON POSTs.
const sessionCookie = (token: string, maxAge: number) => SESSION_COOKIE + "=" + token + "; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAge;
const liveSession = (v: Session) => isAdmin(v.email) && Date.parse(v.seen) + SESSION_DAYS * DAY_MS > Date.now();
function sessionOf(req: Request): Session | null {
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
function dropSessions(keep: (v: Session) => boolean) {
const before = sessionsStore.data.sessions.length;
sessionsStore.data.sessions = sessionsStore.data.sessions.filter((v) => keep(v) && liveSession(v));
closeEndedStreams();
return sessionsStore.data.sessions.length !== before ? saveStore(sessionsStore) : Promise.resolve();
}
function deviceName(req: Request) {
const ua = req.headers.get("user-agent") ?? "";
const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "Browser";
const app = /EdgA?\//.test(ua) ? "Edge" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /FxiOS|Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
return app ? os + " · " + app : os;
}
// Sign-in codes live in memory for 10 minutes; five wrong tries end a code. Asking is limited per email (one code
// every 30 seconds, five an hour) and per network address, the same whether or not the email is an admin.
const CODE_MINUTES = 10;
const pendingCodes = new Map<string, { hash: string; exp: number; tries: number }>();
const codeAsks = new Map<string, number[]>();
const hitCounts = new Map<string, { n: number; reset: number }>();
function underLimit(key: string, max: number, windowMs: number) {
const now = Date.now();
if (hitCounts.size > 5000) for (const [k, v] of hitCounts) if (v.reset < now) hitCounts.delete(k);
const h = hitCounts.get(key);
if (!h || h.reset < now) {
hitCounts.set(key, { n: 1, reset: now + windowMs });
return true;
}
return ++h.n <= max;
}
const codeHash = (email: string, code: string) => sha256(email + ":" + code);
async function sendSignInCode(email: string): Promise<"ok" | "wait" | "limit" | "failed"> {
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
function checkSignInCode(email: string, code: string): "ok" | "wrong" | "expired" | "tries" {
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
const adminsView = (me: string) => ({ owners: [...OWNER_EMAILS].sort(), emails: [...adminsStore.data.emails].sort(), me });
const BASE_HEADERS = {
"X-Content-Type-Options": "nosniff",
"Referrer-Policy": "no-referrer",
"X-Frame-Options": "DENY",
"X-Robots-Tag": "noindex, nofollow",
"Strict-Transport-Security": "max-age=31536000",
"Cache-Control": "no-store",
};
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...BASE_HEADERS, ...extra } });
// Scripts and styles are files under /assets, so the policy needs no per-request nonce.
const CSP_BASE = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";
const CSP = {
page: CSP_BASE + "; frame-ancestors 'none'",
admin: CSP_BASE + "; manifest-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'",
frame: CSP_BASE + "; frame-ancestors 'self'",
};
// app: an admin page the home-screen app may keep for offline use (the service worker only caches responses marked so).
type Shell = { body: ReturnType<typeof encode>; csp: string; framed?: boolean; app?: boolean };
const shell = (html: string, csp: string, framed = false, app = false): Shell => ({ body: encode(html, "text/html; charset=utf-8"), csp, framed, app });
function sendShell(req: Request, s: Shell, cache = "private, no-cache") {
return respond(req, s.body, { ...BASE_HEADERS, "Cache-Control": cache, "Content-Security-Policy": s.csp, ...(s.framed ? { "X-Frame-Options": "SAMEORIGIN" } : {}), ...(s.app ? { "X-App-Shell": "1" } : {}) });
}
async function readJson(req: Request, max = 5000): Promise<any | Response> {
if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "Bad request." }, 415);
const raw = await req.text();
if (raw.length > max) return json({ error: "Too large." }, 413);
try {
return JSON.parse(raw);
} catch {
return json({ error: "Bad request." }, 400);
}
}
const allowView = () => ({ enabled: allowStore.data.enabled, emails: [...allowStore.data.emails].sort() });
await loadStore(bookingsStore);
await loadStore(ivStore);
await loadStore(allowStore);
await loadStore(secretStore);
await loadStore(pushStore);
await loadStore(resultsStore);
await loadStore(adminsStore);
await loadStore(enquiriesStore);
await loadStore(sessionsStore);
if (!pushStore.data.pub || !pushStore.data.priv) {
const kp = createECDH("prime256v1");
kp.generateKeys();
pushStore.data.pub = b64u(kp.getPublicKey());
pushStore.data.priv = b64u(kp.getPrivateKey());
await saveStore(pushStore).catch(() => {});
}
if (!secretStore.data.key) {
secretStore.data.key = randomBytes(32).toString("hex");
await saveStore(secretStore).catch(() => {});
}
if (REMOVE_BOOKINGS.length && bookingsStore.ok) {
const istDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));
const rules = REMOVE_BOOKINGS.map((r) => {
const at = r.lastIndexOf("@");
return at > 0 ? { name: r.slice(0, at).trim().toLowerCase(), day: r.slice(at + 1).trim() } : { name: r.trim().toLowerCase(), day: "" };
});
const gone = bookingsStore.data.bookings.filter((b) =>
rules.some((r) => String(b.name ?? "").trim().toLowerCase() === r.name && (!r.day || istDay(b.start) === r.day)),
);
if (gone.length) {
bookingsStore.data.bookings = bookingsStore.data.bookings.filter((b) => !gone.includes(b));
for (const b of gone) delete ivStore.data.assign[b.id];
await saveStore(bookingsStore);
await saveStore(ivStore);
}
console.log("cleanup: removed " + gone.length + " booking(s)" + (gone.length ? ": " + gone.map((b) => b.name + " " + b.start).join(", ") : ""));
}
console.log(RESEND_API_KEY ? "email: on, sending as " + EMAIL_FROM : "email: off (set RESEND_API_KEY to send invites)");
console.log("allowlist: " + (allowStore.data.enabled ? "on" : "off") + ", " + allowStore.data.emails.length + " emails");
console.log(
LOGIN_ON
? "admin sign-in: on, " + (OWNER_EMAILS.length + adminsStore.data.emails.length) + " admin email(s)"
: "admin sign-in: OFF, the admin page is open to anyone (set ADMIN_EMAILS to require sign-in)",
);
if (Bun.env.ADMIN_PASSWORD || Bun.env.ADMIN_LOGIN) console.log("ADMIN_PASSWORD and ADMIN_LOGIN are no longer used: admins sign in with an emailed code (ADMIN_EMAILS)");
console.log("browser alerts: " + pushStore.data.subs.length + " device(s)");
console.log("analytics results: " + Object.keys(resultsStore.data.people).length + " candidate(s)");
const safeJson = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");
const fill = (html: string, vals: Record<string, string>) => html.replace(/__([A-Z]+)__/g, (m, k) => (k in vals ? vals[k] : m));
const HOST_HTML = Bun.escapeHTML(HOST_NAME);
const BOOK_TPL = template("book");
const ADMIN_TPL = template("admin");
// iPhone home-screen apps show a launch image while the page loads, white when there is none. These are plain images in
// the app's background colour, one per iPhone screen size, light and dark, drawn on first request.
const SPLASH_SIZES: [number, number, number][] = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [420, 912, 3], [414, 896, 3], [414, 896, 2], [402, 874, 3], [393, 852, 3],
  [390, 844, 3], [375, 812, 3], [414, 736, 3], [375, 667, 2], [320, 568, 2],
];
const SPLASH_BG = { light: [0xf5, 0xf6, 0xf8], dark: [0x14, 0x14, 0x14] } as const;
const SPLASH_LINKS = SPLASH_SIZES.flatMap(([w, h, r]) =>
  (["light", "dark"] as const).map(
    (s) =>
      `<link rel="apple-touch-startup-image" href="/splash/${w * r}x${h * r}-${s}.png" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${s})">`,
  ),
).join("");
const splashCache = new Map<string, ReturnType<typeof encode>>();
function splashPng(width: number, height: number, [r, g, b]: readonly number[]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
function splash(name: string) {
  const m = name.match(/^(\d+)x(\d+)-(light|dark)\.png$/);
  if (!m || !SPLASH_SIZES.some(([w, h, r]) => w * r === +m[1] && h * r === +m[2])) return null;
  let body = splashCache.get(name);
  if (!body) splashCache.set(name, (body = encode(splashPng(+m[1], +m[2], SPLASH_BG[m[3] as "light" | "dark"]), "image/png")));
  return body;
}
// Changes with every deploy that changes a page. The admin app compares it with the live state and reloads itself when a
// phone kept the previous version open.
const BUILD = Bun.hash(assetList().map((a) => a.url).join(",") + ADMIN_TPL + template("analytics")).toString(36);
const bookHtml = (manage: unknown, preload: string) =>
fill(BOOK_TPL, {
EVENT: Bun.escapeHTML(EVENT_NAME),
HOST: HOST_HTML,
PRELOAD: preload,
BOOT: safeJson({ host: HOST_NAME, event: EVENT_NAME, manage, info: { loc: EVENT_LOCATION, desc: EVENT_DESCRIPTION } }),
});
// The booking page asks for the 30-minute days list as soon as it starts; the preload starts that request with the HTML.
const BOOK_HOME = shell(bookHtml(null, '<link rel="preload" href="/api/days?duration=30" as="fetch" crossorigin>'), CSP.page);
const adminShell = (tab: string) => shell(fill(ADMIN_TPL, { HOST: HOST_HTML, SPLASH: SPLASH_LINKS, BOOT: safeJson({ tab, login: LOGIN_ON, build: BUILD }) }), CSP.admin, false, true);
const ADMIN_CAL = adminShell("cal");
const ADMIN_ALLOW = adminShell("allow");
const ENQUIRY = shell(fill(template("enquiry"), { HOST: HOST_HTML }), CSP.page);
const LOGIN = shell(fill(template("login"), { HOST: HOST_HTML, SPLASH: SPLASH_LINKS }), CSP.page);
const ANALYTICS = shell(template("analytics"), CSP.frame, true, true);
// A manage link carries the candidate's booking, so that page is built per request and never cached.
const bookPage = (req: Request, manage: unknown) => sendShell(req, { body: encode(bookHtml(manage, ""), "text/html; charset=utf-8", true), csp: CSP.page }, "no-store");
function managedBooking(body: any): Booking | Response {
const id = String(body?.id ?? "");
const b = bookingsStore.data.bookings.find((x) => x.id === id);
if (!b || !tokenOk(b.id, body?.t)) return json({ error: "This link isn't valid. Use the link from your confirmation email." }, 403);
if (b.cancelled) return json({ error: "This interview was already cancelled." }, 409);
if (Date.parse(b.start) <= Date.now()) return json({ error: "This interview has already started, so it can't be changed here." }, 409);
return b;
}
async function commit(b: Booking, prev: Booking) {
try {
await saveStore(bookingsStore);
return true;
} catch {
for (const k of Object.keys(b)) if (!(k in prev)) delete (b as any)[k];
Object.assign(b, prev);
return false;
}
}
const saveFailed = () => json({ error: "Couldn't save the change. Try again." }, 500);
// Known company names and aliases ("TCS" and "Tata Consultancy Services"), keyed by compact(), to the name's line in companies.json.
const KNOWN_BY_KEY = new Map<string, number>();
KNOWN_COMPANIES.forEach((line, index) => {
for (const name of line.split("|")) if (!KNOWN_BY_KEY.has(compact(name))) KNOWN_BY_KEY.set(compact(name), index);
});
// A candidate's later rounds keep the company name they gave before, so analytics sees one company: when the new name is
// a near-spelling of an earlier one ("Infosis" after "Infosys") or another name of the same known company ("TCS" after
// "Tata Consultancy Services"), the earlier spelling is saved. A known name is never replaced by an unknown spelling.
function earlierSpelling(email: string, company: string): string {
if (!company) return company;
const key = compact(company);
const known = KNOWN_BY_KEY.get(key);
const earlier = bookingsStore.data.bookings
.filter((b) => b.email.toLowerCase() === email.toLowerCase() && String(b.company ?? "").trim())
.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
.map((b) => String(b.company).trim());
if (earlier.includes(company)) return company;
for (const prev of earlier) {
const prevKnown = KNOWN_BY_KEY.get(compact(prev));
if (known !== undefined && prevKnown === undefined) continue;
if (compact(prev) === key || (known !== undefined && prevKnown === known) || sameCompany(prev, company)) return prev;
}
return company;
}
async function createBooking(body: any, req: Request, source?: "admin"): Promise<Response> {
const name = String(body?.name ?? "").trim().slice(0, 120);
const email = String(body?.email ?? "").trim().slice(0, 200);
const company = String(body?.company ?? "").trim().slice(0, 120);
const round = String(body?.round ?? "").trim().slice(0, 60);
const duration = Number(body?.duration);
const startMs = Number(body?.startMs);
if (!name) return json({ error: "Enter a name." }, 400);
if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
// candidates must say which company the interview is for; the admin form may leave it empty
if (!source && !company) return json({ error: "Enter the company you're interviewing with.", field: "company" }, 400);
if (!source && !emailAllowed(email))
return json({ error: "This email isn't on the invite list. Use the email address your invitation was sent to.", field: "email" }, 403);
if (!DURATIONS.includes(duration) || !Number.isFinite(startMs)) return json({ error: "Bad request." }, 400);
const endMs = startMs + duration * 60000;
if (!slotOk(startMs, duration) || overlapsExisting(startMs, endMs) || (!source && startMs >= bookingLimitMs()))
return json({ error: "That time is no longer available. Pick another time.", retry: true }, 409);
const booking: Booking = {
id: crypto.randomUUID(), name, email, company: earlierSpelling(email, company), round,
start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), duration,
createdAt: new Date().toISOString(), cancelled: false, cancelledAt: "",
...(source ? { source } : {}),
};
bookingsStore.data.bookings.push(booking);
try {
await saveStore(bookingsStore);
} catch {
bookingsStore.data.bookings.pop();
return json({ error: "Couldn't save the booking. Try again." }, 500);
}
broadcastState();
const base = baseUrl(req);
notifyBooked(booking, base);
if (!source) alertAdmins("booked", booking);
return json({ booking: { id: booking.id, name, email, company: booking.company, round, start: booking.start, end: booking.end, duration, manage: manageUrl(base, booking) }, emailed: !!RESEND_API_KEY });
}
async function moveBooking(b: Booking, startMs: number, duration: number, by: "candidate" | "host", req: Request): Promise<Response> {
if (!DURATIONS.includes(duration) || !Number.isFinite(startMs)) return json({ error: "Bad request." }, 400);
if (startMs === Date.parse(b.start) && duration === b.duration) return json({ error: "That's already the interview time. Pick a different time." }, 400);
const endMs = startMs + duration * 60000;
if (!slotOk(startMs, duration) || overlapsExisting(startMs, endMs, b.id) || (by === "candidate" && startMs >= bookingLimitMs()))
return json({ error: "That time is no longer available. Pick another time.", retry: true }, 409);
const prev = { ...b };
Object.assign(b, {
prevStart: b.start, prevEnd: b.end, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), duration,
seq: (b.seq ?? 0) + 1, rescheduledAt: new Date().toISOString(), rescheduledBy: by,
});
// a new time is a new chance: it isn't "didn't happen" any more
delete b.missed;
delete b.missedAt;
if (!(await commit(b, prev))) return saveFailed();
broadcastState();
notifyRescheduled(b, prev.start, prev.end, baseUrl(req));
if (by === "candidate") alertAdmins("moved", b);
return json({ booking: { start: b.start, end: b.end, duration: b.duration }, emailed: !!RESEND_API_KEY });
}
async function cancelBooking(b: Booking, reason: string, by: "candidate" | "host", req: Request): Promise<Response> {
const prev = { ...b };
Object.assign(b, { cancelled: true, cancelledAt: new Date().toISOString(), cancelReason: reason.trim().slice(0, 500), cancelledBy: by, seq: (b.seq ?? 0) + 1 });
if (!(await commit(b, prev))) return saveFailed();
broadcastState();
if (Date.parse(b.start) > Date.now()) {
notifyCancelled(b, baseUrl(req));
if (by === "candidate") alertAdmins("cancelled", b);
}
return json({ ok: true, emailed: !!RESEND_API_KEY });
}
const csvCell = (v: unknown) => {
let s = String(v ?? "");
if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating text as formulas
return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const istDate = (iso: string) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso)) : "");
function bookingsCsvText() {
const now = Date.now();
const iv = ivStore.data.assign;
const d = istDate;
const who = (x?: string) => (x === "host" ? "You" : x === "candidate" ? "Candidate" : "");
const rows = [["Name", "Email", "Company", "Round", "Date", "Start (IST)", "End (IST)", "Length (min)", "Status", "Interview support given by", "Booked on", "Booked via", "Cancelled by", "Cancel reason"]];
for (const b of [...bookingsStore.data.bookings].sort((x, y) => Date.parse(x.start) - Date.parse(y.start)))
rows.push([
b.name, b.email, b.company, b.round, d(b.start), t12(b.start), t12(b.end), String(b.duration),
b.cancelled ? "Cancelled" : b.missed === "noshow" ? "No-show" : b.missed ? "Didn't happen" : Date.parse(b.end) <= now ? "Completed" : Date.parse(b.start) <= now ? "In progress" : "Upcoming",
iv[b.id] ?? "", d(b.createdAt), b.source === "admin" ? "Admin" : b.source === "calendly" ? "Calendly" : "Booking page",
b.cancelled ? who(b.cancelledBy) : "", b.cancelReason ?? "",
]);
return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
const bookingsCsv = () =>
new Response(bookingsCsvText(), {
headers: { ...BASE_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bookings-' + istDate(new Date().toISOString()) + '.csv"' },
});
// ---- Backups ------------------------------------------------------------------------------
// Every day after BACKUP_HOUR (IST, default 2) a full snapshot is written to DATA_DIR/backups (the last 14 are kept),
// and the bookings CSV plus the data (without push.json) are emailed to BACKUP_EMAIL (or HOST_EMAIL).
// backup-state.json records the last day done, so restarts don't send duplicates; a failed email is retried later that day.
const BACKUP_TO = (Bun.env.BACKUP_EMAIL ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
const BACKUP_RECIPIENTS = BACKUP_TO.length ? BACKUP_TO : HOST_EMAILS;
const BACKUP_HOUR = /^\d{1,2}$/.test((Bun.env.BACKUP_HOUR ?? "").trim()) ? Math.min(23, Number(Bun.env.BACKUP_HOUR)) : 2;
const BACKUP_KEEP = 14;
const backupStateStore = fileStore<{ saved: string; emailed: string }>("backup-state.json", () => ({ saved: "", emailed: "" }), (x) => ({
saved: typeof x?.saved === "string" ? x.saved : "",
emailed: typeof x?.emailed === "string" ? x.emailed : "",
}));
// Everything needed to restore. push.json (browser-alert keys) is only in the on-volume snapshots; sessions.json
// (who is signed in) is never copied, so a restore signs everyone out.
function backupData(withPush: boolean) {
return {
app: "booking-form",
version: 1,
createdAt: new Date().toISOString(),
files: {
"bookings.json": bookingsStore.data,
"interviewers.json": ivStore.data,
"allowlist.json": allowStore.data,
"admins.json": adminsStore.data,
"enquiries.json": enquiriesStore.data,
"results.json": resultsStore.data,
"secret.json": secretStore.data,
...(withPush ? { "push.json": pushStore.data } : {}),
},
};
}
async function saveSnapshot(day: string) {
const dir = DATA_DIR + "/backups";
await mkdir(dir, { recursive: true });
await Bun.write(dir + "/" + day + ".json", JSON.stringify(backupData(true)));
const old = (await readdir(dir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -BACKUP_KEEP);
for (const f of old) await rm(dir + "/" + f, { force: true });
}
function emailBackup(day: string) {
const all = bookingsStore.data.bookings;
const upcoming = all.filter((b) => !b.cancelled && Date.parse(b.start) > Date.now()).length;
const body = emailBody({
heading: "Daily backup",
intro: "The " + HOST_NAME + " booking data as of today. Keep this email: the attachments are enough to restore everything.",
rows: [
["Date", day],
["Bookings", all.length + " in total, " + upcoming + " upcoming"],
["Allowed emails", String(allowStore.data.emails.length)],
],
note: "bookings.csv opens in Excel or Google Sheets. backup.json is the full data for restoring (see the project README). It contains candidate details: don't forward it.",
});
return sendEmail({
to: BACKUP_RECIPIENTS,
subject: "Backup: " + HOST_NAME + " bookings \u2013 " + day,
...body,
files: [
{ filename: "bookings-" + day + ".csv", content: Buffer.from(bookingsCsvText()).toString("base64"), content_type: "text/csv; charset=utf-8" },
{ filename: "backup-" + day + ".json", content: Buffer.from(JSON.stringify(backupData(false), null, 1)).toString("base64"), content_type: "application/json" },
],
});
}
let backupRunning = false;
async function runBackup() {
const now = istParts(Date.now());
const day = now.y + "-" + pad(now.mo) + "-" + pad(now.d);
if (backupRunning || !bookingsStore.ok || now.hh < BACKUP_HOUR) return;
const st = backupStateStore.data;
const wantEmail = !!RESEND_API_KEY && BACKUP_RECIPIENTS.length > 0;
if (st.saved === day && (st.emailed === day || !wantEmail)) return;
backupRunning = true;
try {
if (st.saved !== day) {
await saveSnapshot(day);
st.saved = day;
console.log("backup: saved " + DATA_DIR + "/backups/" + day + ".json");
}
if (wantEmail && st.emailed !== day && (await emailBackup(day))) st.emailed = day;
await saveStore(backupStateStore);
if (!wantEmail) console.log("backup: not emailed (set BACKUP_EMAIL and RESEND_API_KEY)");
} catch (e) {
console.log("backup failed: " + String(e));
} finally {
backupRunning = false;
}
}
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
type Srv = { requestIP(r: Request): { address: string } | null; timeout(r: Request, seconds: number): void };
// POST /api/enquiry, a multipart form from the /enquiry page. Five enquiries an hour per network address; a hidden
// "website" field that only bots fill in gets a thank-you and is dropped.
async function receiveEnquiry(req: Request, srv: Srv): Promise<Response> {
const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || srv.requestIP(req)?.address || "unknown";
if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "Bad request." }, 415);
const length = Number(req.headers.get("content-length") ?? NaN);
if (!(length > 0)) return json({ error: "Bad request." }, 411);
if (length > RESUME_MAX + 64 * 1024) return json({ error: "The resume must be under 1 MB." }, 413);
if (!underLimit("enquiry:" + ip, 5, 3600000)) return json({ error: "Too many enquiries from this network. Try again in an hour." }, 429);
let form: FormData;
try {
form = await req.formData();
} catch {
return json({ error: "Bad request." }, 400);
}
const text = (k: string, max: number) => String(form.get(k) ?? "").replace(/\s+/g, " ").trim().slice(0, max);
if (text("website", 200)) return json({ ok: true });
const name = text("name", 100);
const email = normEmail(text("email", 200));
const phone = text("phone", 20);
const tech = text("tech", 100);
const experience = text("experience", 40);
if (name.length < 2) return json({ error: "Enter your full name." }, 400);
if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
const digits = phone.replace(/\D/g, "").length;
if (digits < 10 || digits > 15 || /[^\d\s+()-]/.test(phone)) return json({ error: "Enter a valid phone number." }, 400);
if (tech.length < 2) return json({ error: "Tell us the technology you're looking for." }, 400);
if (!experience) return json({ error: "Choose your years of experience." }, 400);
const resume = form.get("resume");
if (!(resume instanceof Blob) || !resume.size) return json({ error: "Add your resume." }, 400);
if (resume.size > RESUME_MAX) return json({ error: "The resume must be under 1 MB." }, 413);
const bytes = new Uint8Array(await resume.arrayBuffer());
const kind = RESUME_KINDS.find((k) => k.magic.every((b, i) => bytes[i] === b));
if (!kind) return json({ error: "The resume must be a PDF or Word file." }, 400);
const id = crypto.randomUUID();
const original = (resume instanceof File ? resume.name : "").replace(/[\u0000-\u001f"\\/]/g, "").trim().slice(-120) || "resume" + kind.ext;
const entry: Enquiry = {
id, name, email, phone, tech, experience, createdAt: new Date().toISOString(),
resume: { file: id + kind.ext, name: original, type: kind.type, size: bytes.length },
};
try {
await saveResume(entry.resume.file, bytes);
enquiriesStore.data.enquiries.push(entry);
await saveStore(enquiriesStore);
} catch {
enquiriesStore.data.enquiries = enquiriesStore.data.enquiries.filter((v) => v.id !== id);
await removeResume(entry.resume.file).catch(() => {});
return json({ error: "Couldn't save your enquiry. Try again." }, 500);
}
console.log("enquiry received (" + enquiriesStore.data.enquiries.length + " in total)");
if (pushStore.data.subs.length) void pushAll({ title: "New enquiry", body: name + " \u00B7 " + tech + "\n" + experience, tag: "enquiry:" + id, url: "/admin?view=enquiries" });
return json({ ok: true });
}
const enquiryView = (v: Enquiry) => ({
id: v.id, name: v.name, email: v.email, phone: v.phone, tech: v.tech, experience: v.experience, createdAt: v.createdAt,
resume: { name: v.resume.name, size: v.resume.size },
});
async function route(req: Request, srv: Srv): Promise<Response> {
const url = new URL(req.url);
const path = url.pathname;
const method = req.method;
if (path === "/favicon.ico") return new Response(null, { status: 204 });
if (path === "/healthz") return new Response("ok", { headers: BASE_HEADERS });
if (path === "/sw.js") return new Response(SW_JS, { headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
if (path === "/manifest.webmanifest")
return new Response(
JSON.stringify({
name: HOST_NAME + " Admin", short_name: HOST_NAME, start_url: "/admin", scope: "/", display: "standalone",
background_color: "#141414", theme_color: "#141414",
icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" }, { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" }],
}),
{ headers: { ...BASE_HEADERS, "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } },
);
if (path.startsWith("/splash/") && (method === "GET" || method === "HEAD")) {
const body = splash(path.slice(8));
return body ? respond(req, body, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" }) : new Response("Not found", { status: 404, headers: BASE_HEADERS });
}
if (path === "/icon.png" || path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png")
return respond(req, ICON, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" });
if (path.startsWith("/assets/") && (method === "GET" || method === "HEAD")) {
const a = asset(path);
if (!a) return new Response("Not found", { status: 404, headers: BASE_HEADERS });
return respond(req, a.body, { ...BASE_HEADERS, "Cache-Control": a.current ? "public, max-age=31536000, immutable" : "no-cache" });
}
if (path === "/" && method === "GET") return sendShell(req, BOOK_HOME);
if (path === "/enquiry" && method === "GET") return sendShell(req, ENQUIRY);
if ((path === "/enquiry/" || path === "/inquiry" || path === "/enquiries") && method === "GET")
return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/enquiry" } });
if (path === "/api/enquiry" && method === "POST") return receiveEnquiry(req, srv);
const mm = path.match(/^\/b\/([0-9a-f-]{36})$/i);
if (mm && method === "GET") {
const b = bookingsStore.data.bookings.find((x) => x.id === mm[1]);
const t = url.searchParams.get("t") ?? "";
if (!b || !tokenOk(b.id, t)) return bookPage(req, { error: "This link isn't valid. Use the link from your confirmation email, or contact " + HOST_NAME + "." });
return bookPage(req, { id: b.id, t, name: b.name, email: b.email, start: b.start, end: b.end, duration: b.duration, cancelled: b.cancelled, past: Date.parse(b.start) <= Date.now() });
}
const ignoreId = (() => {
const id = url.searchParams.get("ignore") ?? "";
return UUID.test(id) && tokenOk(id, url.searchParams.get("t")) ? id : "";
})();
if (path === "/api/companies" && method === "GET") return json({ companies: companySuggestions() });
if (path === "/api/lookup" && method === "GET") {
const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || srv.requestIP(req)?.address || "unknown";
if (!lookupAllowed(ip)) return json({ name: "" }, 429);
const email = String(url.searchParams.get("email") ?? "").slice(0, 200);
if (!EMAIL_RE.test(normEmail(email)) || !emailAllowed(email)) return json({ name: "" });
return json({ name: knownName(email) });
}
if (path === "/api/days" && method === "GET") {
const duration = Number(url.searchParams.get("duration"));
if (!DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
return json({ days: bookableDays(duration, ignoreId) });
}
if (path === "/api/slots" && method === "GET") {
const key = url.searchParams.get("date") ?? "";
const duration = Number(url.searchParams.get("duration"));
if (!DATE_KEY.test(key) || !DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
const [y, mo, d] = key.split("-").map(Number);
return json({ slots: slotsFor(y, mo, d, duration, ignoreId).filter((s) => s < bookingLimitMs()) });
}
if (path === "/api/book" && method === "POST") {
const body = await readJson(req);
if (body instanceof Response) return body;
return createBooking(body, req);
}
if ((path === "/api/manage/reschedule" || path === "/api/manage/cancel") && method === "POST") {
const body = await readJson(req);
if (body instanceof Response) return body;
const b = managedBooking(body);
if (b instanceof Response) return b;
return path.endsWith("cancel")
? cancelBooking(b, String(body?.reason ?? ""), "candidate", req)
: moveBooking(b, Number(body?.startMs), Number(body?.duration), "candidate", req);
}
if ((path === "/admin/login/code" || path === "/admin/login") && method === "POST") {
if (!LOGIN_ON) return json({ ok: true });
const body = await readJson(req, 1000);
if (body instanceof Response) return body;
const email = normEmail(body?.email);
if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "Enter a valid email address." }, 400);
const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || srv.requestIP(req)?.address || "unknown";
if (path === "/admin/login/code") {
if (!underLimit("code:" + ip, 20, 3600000)) return json({ error: "Too many codes asked for from this network. Try again in an hour." }, 429);
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
if (path === "/admin" || path.startsWith("/admin/")) {
const me = LOGIN_ON ? sessionOf(req) : null;
const authed = !LOGIN_ON || !!me;
if ((path === "/admin" || path === "/admin/allowlist") && method === "GET") {
if (!authed) return sendShell(req, LOGIN);
return sendShell(req, path === "/admin" ? ADMIN_CAL : ADMIN_ALLOW);
}
if (path === "/admin/analytics" && method === "GET") return sendShell(req, authed ? ANALYTICS : { ...LOGIN, csp: CSP.frame, framed: true });
if (!authed) return json({ error: "Sign in again." }, 401);
// Enquiries from /enquiry, newest first; each resume downloads from its own link; an enquiry can be deleted.
if (path === "/admin/api/enquiries" && method === "GET")
return json({ enquiries: [...enquiriesStore.data.enquiries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(enquiryView) });
const resumePath = path.match(/^\/admin\/api\/enquiries\/([0-9a-f-]{36})\/resume$/);
if (resumePath && method === "GET") {
const v = enquiriesStore.data.enquiries.find((x) => x.id === resumePath[1]);
const bytes = v && (await readResume(v.resume.file));
if (!v || !bytes) return json({ error: "That resume isn't there any more." }, 404);
const ascii = v.resume.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
return new Response(bytes, {
headers: {
...BASE_HEADERS,
"Content-Type": v.resume.type,
"Content-Disposition": 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(v.resume.name),
},
});
}
if (path === "/admin/api/enquiries/delete" && method === "POST") {
const body = await readJson(req, 1000);
if (body instanceof Response) return body;
const v = enquiriesStore.data.enquiries.find((x) => x.id === String(body?.id ?? ""));
if (!v) return json({ error: "That enquiry was already deleted." }, 404);
const prev = enquiriesStore.data.enquiries;
enquiriesStore.data.enquiries = prev.filter((x) => x !== v);
try {
await saveStore(enquiriesStore);
} catch {
enquiriesStore.data.enquiries = prev;
return json({ error: "Couldn't save the change. Try again." }, 500);
}
await removeResume(v.resume.file).catch(() => {});
return json({ ok: true });
}
// Who can sign in: the owners (ADMIN_EMAILS, fixed) and the admins they add here.
if (path === "/admin/api/admins" && method === "GET") return json(adminsView(me?.email ?? ""));
if (path === "/admin/api/admins" && method === "POST") {
if (!me) return json({ error: "Admin sign-in is off, so there is no admin list." }, 409);
const body = await readJson(req, 10000);
if (body instanceof Response) return body;
if (!Array.isArray(body?.emails) || body.emails.length > 50) return json({ error: "You can have up to 50 admins." }, 400);
const emails = [...new Set<string>(body.emails.map(normEmail))];
const bad = emails.find((e) => !EMAIL_RE.test(e) || e.length > 200);
if (bad !== undefined) return json({ error: (bad || "An empty entry") + " isn't a valid email address." }, 400);
const list = emails.filter((e) => !OWNER_EMAILS.includes(e));
if (!OWNER_EMAILS.includes(me.email) && !list.includes(me.email)) return json({ error: "You can't remove yourself. Ask an owner to do it." }, 400);
const prev = adminsStore.data.emails;
adminsStore.data.emails = list;
try {
await saveStore(adminsStore);
} catch {
adminsStore.data.emails = prev;
return json({ error: "Couldn't save the change. Try again." }, 500);
}
// removed admins are signed out everywhere
await dropSessions((v) => isAdmin(v.email)).catch(() => {});
return json(adminsView(me.email));
}
if (path === "/admin/api/state" && method === "GET") return json(adminState());
if (path === "/admin/api/push" && method === "GET") return json(pushView());
if (path.startsWith("/admin/api/push/") && method === "POST") {
const body = await readJson(req, 3000);
if (body instanceof Response) return body;
const endpoint = String(body?.endpoint ?? "");
const act = path.slice("/admin/api/push/".length);
if (act === "subscribe") {
const p256dh = String(body?.keys?.p256dh ?? "");
const auth = String(body?.keys?.auth ?? "");
if (!pushEndpointOk(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth)) return json({ error: "This browser sent an unexpected subscription. Try again." }, 400);
const subs = pushStore.data.subs.filter((x) => x.endpoint !== endpoint);
if (subs.length >= 50) return json({ error: "Too many devices. Turn alerts off on an old one first." }, 400);
subs.push({ endpoint, p256dh, auth, label: String(body?.label ?? "Browser").slice(0, 40), addedAt: new Date().toISOString() });
pushStore.data.subs = subs;
} else if (act === "unsubscribe") {
pushStore.data.subs = pushStore.data.subs.filter((x) => x.endpoint !== endpoint);
} else if (act === "test") {
const sub = pushStore.data.subs.find((x) => x.endpoint === endpoint);
if (!sub) return json({ error: "Alerts aren't on for this device. Turn them on first." }, 404);
const code = await pushTo(sub, { title: "Test notification", body: "Alerts are working on this " + sub.label + ".", tag: "test", url: "/admin" });
return code >= 200 && code < 300 ? json(pushView()) : json({ error: "The notification service didn't accept it (" + code + "). Turn alerts off and on again." }, 502);
} else return json({ error: "Not found." }, 404);
try {
await saveStore(pushStore);
} catch {
return json({ error: "Couldn't save the change. Try again." }, 500);
}
console.log("browser alerts: " + pushStore.data.subs.length + " device(s)");
return json(pushView());
}
if (path === "/admin/api/bookings" && method === "GET")
return json({ bookings: [...bookingsStore.data.bookings].sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).map(pub) });
if (path === "/admin/api/results") {
if (method === "GET") return json({ people: resultsStore.data.people, joins: resultsStore.data.joins, persistent: resultsStore.ok });
if (method !== "POST") return json({ error: "Method not allowed." }, 405);
const body = await readJson(req, 60000);
if (body instanceof Response) return body;
const entries = body?.entries;
if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length > 20) return json({ error: "Bad request." }, 400);
const prev = JSON.stringify(resultsStore.data);
const now = new Date().toISOString();
for (const [k, v] of Object.entries(entries)) {
if (!k || k.length > 200) return json({ error: "Bad request." }, 400);
const raw = (v as any)?.results;
if (v !== null && (!raw || typeof raw !== "object")) return json({ error: "Bad request." }, 400);
const results = v === null ? {} : normResults(raw);
if (v !== null && Object.keys(results).length !== Object.keys(raw).length) return json({ error: "Bad request." }, 400);
if (Object.keys(results).length > 150) return json({ error: "Too many companies saved for one person." }, 400);
if (Object.keys(results).length) resultsStore.data.people[k] = { results, updated: now };
else delete resultsStore.data.people[k];
}
if (Object.keys(resultsStore.data.people).length > 10000) {
resultsStore.data = JSON.parse(prev);
return json({ error: "Too many candidates saved." }, 400);
}
try {
await saveStore(resultsStore);
} catch {
resultsStore.data = JSON.parse(prev);
return json({ error: "Couldn't save the change. Try again." }, 500);
}
return json({ people: resultsStore.data.people, joins: resultsStore.data.joins, persistent: resultsStore.ok });
}
// Join one company name to another (to: "" separates it again). Names are compared lower-cased.
if (path === "/admin/api/company-joins" && method === "POST") {
const body = await readJson(req, 4000);
if (body instanceof Response) return body;
const from = String(body?.from ?? "").trim().toLowerCase();
const to = String(body?.to ?? "").trim().toLowerCase();
if (!from || from === to || from.length > 120 || to.length > 120) return json({ error: "Bad request." }, 400);
const joins = resultsStore.data.joins;
const prev = JSON.stringify(joins);
if (to) {
// joining A to B when B already leads back to A would make a loop: they're combined already
for (let k = to, hops = 0; joins[k] && hops < 50; hops++) if ((k = joins[k]) === from) return json({ joins, persistent: resultsStore.ok });
joins[from] = to;
} else delete joins[from];
if (Object.keys(joins).length > 5000) {
resultsStore.data.joins = JSON.parse(prev);
return json({ error: "Too many combined companies." }, 400);
}
try {
await saveStore(resultsStore);
} catch {
resultsStore.data.joins = JSON.parse(prev);
return json({ error: "Couldn't save the change. Try again." }, 500);
}
return json({ joins: resultsStore.data.joins, persistent: resultsStore.ok });
}
if (path === "/admin/export.csv" && method === "GET") return bookingsCsv();
if (path === "/admin/backup.json" && method === "GET")
return new Response(JSON.stringify(backupData(false), null, 1), {
headers: { ...BASE_HEADERS, "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="backup-' + istDate(new Date().toISOString()) + '.json"' },
});
if (path === "/admin/api/slots" && method === "GET") {
const key = url.searchParams.get("date") ?? "";
const duration = Number(url.searchParams.get("duration"));
if (!DATE_KEY.test(key) || !DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
const [y, mo, d] = key.split("-").map(Number);
return json({ slots: slotsFor(y, mo, d, duration, url.searchParams.get("ignore") ?? "") });
}
if (path === "/admin/api/book" && method === "POST") {
const body = await readJson(req);
if (body instanceof Response) return body;
return createBooking(body, req, "admin");
}
if ((path === "/admin/api/reschedule" || path === "/admin/api/cancel") && method === "POST") {
const body = await readJson(req, 2000);
if (body instanceof Response) return body;
const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
if (!b || b.cancelled) return json({ error: "That booking isn't active anymore." }, 404);
if (path.endsWith("cancel")) return cancelBooking(b, String(body?.reason ?? ""), "host", req);
if (Date.parse(b.start) <= Date.now()) return json({ error: "This interview has already started, so it can't be moved." }, 409);
return moveBooking(b, Number(body?.startMs), Number(body?.duration), "host", req);
}
if (path === "/admin/api/allowlist") {
if (method === "GET") return json({ state: allowView() });
if (method !== "POST") return json({ error: "Method not allowed." }, 405);
const body = await readJson(req, 200000);
if (body instanceof Response) return body;
const a = allowStore.data;
const before = { enabled: a.enabled, emails: [...a.emails] };
let extra: Record<string, unknown> = {};
const action = String(body?.action ?? "");
if (action === "add") {
const have = new Set(a.emails);
let added = 0;
let existing = 0;
const invalid: string[] = [];
for (const raw of String(body?.text ?? "").split(/[\s,;]+/)) {
const p = raw.replace(/^[<("']+|[>)"'.]+$/g, "");
if (!p) continue;
const e = normEmail(p);
if (!EMAIL_RE.test(e) || e.length > 200) {
if (invalid.length < 50) invalid.push(p.slice(0, 80));
continue;
}
if (have.has(e)) {
existing++;
continue;
}
if (a.emails.length >= 5000) return json({ error: "The list is full (5,000 emails). Remove some first." }, 400);
have.add(e);
a.emails.push(e);
added++;
}
extra = { added, existing, invalid };
} else if (action === "remove") {
const e = normEmail(body?.email);
a.emails = a.emails.filter((x) => x !== e);
} else if (action === "enable") {
const on = body?.on === true;
if (on && !a.emails.length) return json({ error: "Add at least one email first. With an empty list, nobody could book." }, 400);
a.enabled = on;
} else if (action === "importBooked") {
const have = new Set(a.emails);
let added = 0;
for (const b of bookingsStore.data.bookings) {
const e = normEmail(b.email);
if (EMAIL_RE.test(e) && !have.has(e) && a.emails.length < 5000) {
have.add(e);
a.emails.push(e);
added++;
}
}
extra = { added };
} else return json({ error: "Bad request." }, 400);
try {
await saveStore(allowStore);
} catch {
allowStore.data = before;
return json({ error: "Couldn't save the change. Try again." }, 500);
}
broadcastState();
return json({ state: allowView(), ...extra });
}
if (path === "/admin/stream" && method === "GET") {
if (streams.size >= 50) return new Response("Too many viewers", { status: 503, headers: BASE_HEADERS });
srv.timeout(req, 0);
let ctrl: ReadableStreamDefaultController;
const stream = new ReadableStream({
start(c) {
ctrl = c;
streams.set(c, me ? me.id : "");
c.enqueue(enc.encode("retry: 3000\n\nevent: state\ndata: " + JSON.stringify(adminState()) + "\n\n"));
},
cancel() {
streams.delete(ctrl);
},
});
req.signal.addEventListener("abort", () => streams.delete(ctrl));
return new Response(stream, {
headers: { ...BASE_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
});
}
// Mark a started interview as a no-show or as not happened for another reason, or undo it ("").
if (path === "/admin/api/missed" && method === "POST") {
const body = await readJson(req, 1000);
if (body instanceof Response) return body;
const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
const missed = body?.missed;
if (!b || (missed !== "noshow" && missed !== "other" && missed !== "")) return json({ error: "Bad request." }, 400);
if (b.cancelled) return json({ error: "This interview was cancelled." }, 409);
if (missed && Date.parse(b.start) > Date.now() + 60000) return json({ error: "You can mark this once the interview's start time has passed." }, 409);
if (missed && ivStore.data.assign[b.id]) return json({ error: "Interview support is already recorded for this interview, so it happened." }, 409);
const prev = { ...b };
if (missed) Object.assign(b, { missed, missedAt: new Date().toISOString() });
else {
delete b.missed;
delete b.missedAt;
}
if (!(await commit(b, prev))) return saveFailed();
broadcastState();
return json({ ok: true });
}
if (path === "/admin/api/interviewers" && method === "PUT") {
const body = await readJson(req, 20000);
if (body instanceof Response) return body;
const iv = ivStore.data;
const set: Record<string, string> = {};
for (const [id, name] of Object.entries(body?.set ?? {})) {
if (!UUID.test(id) || typeof name !== "string" || (name !== "" && !iv.names.includes(name))) return json({ error: "Bad request." }, 400);
if (iv.assign[id] && iv.assign[id] !== name) return json({ error: "The interview supporter is locked once recorded, so it can't be changed." }, 409);
const b = bookingsStore.data.bookings.find((x) => x.id === id);
if (name && b && Date.parse(b.start) > Date.now() + 60000) return json({ error: "You can record the interview supporter once the interview starts." }, 409);
if (name && b?.missed) return json({ error: "This interview is marked as not happened. Undo that first." }, 409);
set[id] = name;
}
const prev = { ...iv.assign };
for (const [id, name] of Object.entries(set)) name ? (iv.assign[id] = name) : delete iv.assign[id];
try {
await saveStore(ivStore);
} catch {
iv.assign = prev;
return json({ error: "Couldn't save the change. Try again." }, 500);
}
broadcastState();
return json({ ok: true });
}
if (path === "/admin/api/interviewer-names" && method === "POST") {
const body = await readJson(req, 5000);
if (body instanceof Response) return body;
const iv = ivStore.data;
if (!Array.isArray(body?.list) || body.list.length > 12) return json({ error: "You can have up to 12 interview supporters." }, 400);
const names: string[] = [];
const renames = new Map<string, string>();
for (const r of body.list) {
const to = String(r?.to ?? "").trim().slice(0, 30);
if (!to) continue;
if (names.some((n) => n.toLowerCase() === to.toLowerCase())) return json({ error: "Each interview supporter needs a different name." }, 400);
names.push(to);
const from = typeof r?.from === "string" ? r.from : "";
if (from && from !== to && iv.names.includes(from)) renames.set(from, to);
}
if (!names.length) return json({ error: "Keep at least one interview supporter." }, 400);
const prev = { names: iv.names, assign: { ...iv.assign } };
iv.names = names;
for (const [id, n] of Object.entries(iv.assign)) if (renames.has(n)) iv.assign[id] = renames.get(n)!;
try {
await saveStore(ivStore);
} catch {
Object.assign(iv, prev);
return json({ error: "Couldn't save the change. Try again." }, 500);
}
broadcastState();
return json({ ok: true });
}
return json({ error: "Not found." }, 404);
}
return new Response("Not found", { status: 404, headers: BASE_HEADERS });
}
const server = Bun.serve({
port: PORT,
hostname: "0.0.0.0",
idleTimeout: 30,
async fetch(req, srv) {
return compressed(req, await route(req, srv));
},
});
await loadStore(backupStateStore);
void runBackup();
setInterval(() => void runBackup(), 15 * 60000);
console.log("booking-form listening on " + server.port + (bookingsStore.ok ? "" : " (no persistent storage attached)"));

