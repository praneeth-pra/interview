// ---- Backups ------------------------------------------------------------------------------
// Every day after BACKUP_HOUR (IST, default 2) a data snapshot is written to DATA_DIR/backups (the last 14 are kept), and
// once a week (BACKUP_EMAIL_DAYS after the last one) the bookings CSV plus a full backup (the data without push.json, and
// the resumes and payment receipts, split over several emails when they are big) are emailed to BACKUP_EMAIL (or
// HOST_EMAIL), so the data survives losing the volume. backup-state.json records the last days done, so restarts don't
// send duplicates; a failed email is retried later. push.json (browser-alert keys) is only in the on-volume snapshots;
// sessions.json (who is signed in) is never copied.
import { bookingsCsvText } from "./bookings";
import { BACKUP_EMAIL_DAYS, BACKUP_HOUR, BACKUP_KEEP, BACKUP_RECIPIENTS, DATA_DIR, HOST_NAME, RESEND_API_KEY } from "./config";
import {
  adminsStore,
  allowStore,
  backupStateStore,
  blocksStore,
  bookingsStore,
  enquiriesStore,
  ivStore,
  onboardingStore,
  paymentsStore,
  pushStore,
  resultsStore,
  secretStore,
} from "./data";
import { emailBody, sendEmail } from "./email";
import { readResume, saveResume } from "./enquiries";
import { json } from "./http";
import { broadcastState } from "./live";
import { readIdCard, saveIdCard } from "./onboarding";
import { readReceipt, saveReceipt } from "./payments";
import { type FileStore, loadStore, saveStore } from "./store";
import { istParts } from "./time";
import { type Fields, asFields, pad } from "./util";
import { copyFile, readdir, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";

// The stores a backup carries, by file name. push.json is added only to the on-volume snapshots.
const STORES: Record<string, FileStore<any>> = {
  "bookings.json": bookingsStore,
  "interviewers.json": ivStore,
  "allowlist.json": allowStore,
  "admins.json": adminsStore,
  "enquiries.json": enquiriesStore,
  "payments.json": paymentsStore,
  "onboarding.json": onboardingStore,
  "results.json": resultsStore,
  "unavailable.json": blocksStore,
  "secret.json": secretStore,
};
// The resumes, receipts and ID cards, as "resumes/<file>", "receipts/<file>" or "id-cards/<file>"; restoring writes only
// names like these.
export const UPLOAD_PATH = /^(resumes|receipts|id-cards)\/[A-Za-z0-9-]{1,64}\.(pdf|docx|doc|png|jpg|webp|heic)$/;
// The resumes and receipts in one backup email, at most (BACKUP_FILES_MB, default 12). They are base64 twice over (in the
// JSON, then as an attachment), so 12 MB of files is about 21 MB of email: under the 25 MB many inboxes accept.
const FILES_MB = Number(Bun.env.BACKUP_FILES_MB);
const EMAIL_FILES_MAX = (FILES_MB > 0 ? FILES_MB : 12) * 1024 * 1024;

export function backupData(withPush: boolean) {
  return {
    app: "booking-form",
    version: 1,
    createdAt: new Date().toISOString(),
    files: {
      ...Object.fromEntries(Object.entries(STORES).map(([name, s]) => [name, s.data])),
      ...(withPush ? { "push.json": pushStore.data } : {}),
    },
  };
}
// The backup with every resume and receipt (base64), split into parts of at most max bytes of files, newest files first.
// Part 1 has the data and the first files; the other parts have only files. Restoring takes all the parts together.
export async function backupParts(max = Infinity) {
  const wanted = [
    ...enquiriesStore.data.enquiries.map((v) => ({
      at: v.createdAt,
      path: "resumes/" + v.resume.file,
      read: () => readResume(v.resume.file),
    })),
    ...paymentsStore.data.payments.map((v) => ({
      at: v.createdAt,
      path: "receipts/" + v.receipt.file,
      read: () => readReceipt(v.receipt.file),
    })),
    ...onboardingStore.data.forms.flatMap((v) =>
      [v.aadhaar, v.pan].map((c) => ({ at: v.createdAt, path: "id-cards/" + c.file, read: () => readIdCard(c.file) })),
    ),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const chunks: Record<string, string>[] = [{}];
  const seen = new Set<string>();
  let size = 0;
  let count = 0;
  for (const w of wanted) {
    if (!UPLOAD_PATH.test(w.path) || seen.has(w.path)) continue;
    seen.add(w.path);
    const bytes = await w.read();
    if (!bytes) continue;
    if (size && size + bytes.length > max) {
      chunks.push({});
      size = 0;
    }
    size += bytes.length;
    count++;
    chunks.at(-1)![w.path] = Buffer.from(bytes).toString("base64");
  }
  const data = backupData(false);
  const parts = chunks.map((uploads, i) => ({
    ...(i ? { app: data.app, version: data.version, createdAt: data.createdAt } : data),
    part: i + 1,
    parts: chunks.length,
    uploads,
  }));
  return { parts, count };
}
async function saveSnapshot(day: string) {
  const dir = DATA_DIR + "/backups";
  await mkdir(dir, { recursive: true });
  await Bun.write(dir + "/" + day + ".json", JSON.stringify(backupData(true)));
  const old = (await readdir(dir))
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(0, -BACKUP_KEEP);
  for (const f of old) await rm(dir + "/" + f, { force: true });
}
// Part 1 goes with the bookings CSV; when the files need more than one email, each other part follows in its own email.
async function emailBackup(day: string) {
  const all = bookingsStore.data.bookings;
  const upcoming = all.filter((b) => !b.cancelled && Date.parse(b.start) > Date.now()).length;
  const { parts, count } = await backupParts(EMAIL_FILES_MAX);
  const n = parts.length;
  const name = (i: number) => "backup-" + day + (n > 1 ? "-part" + (i + 1) : "") + ".json";
  const subject = "Backup: " + HOST_NAME + " bookings \u2013 " + day;
  const attach = (i: number) => ({
    filename: name(i),
    content: Buffer.from(JSON.stringify(parts[i], null, 1)).toString("base64"),
    content_type: "application/json",
  });
  const first = emailBody({
    heading: "Weekly backup",
    intro:
      "The " +
      HOST_NAME +
      " data as of today. Keep this email" +
      (n > 1 ? " and the " + (n - 1) + " that follow it" : "") +
      ": if the server's data is ever lost, the backup " +
      (n > 1 ? "files are" : "file is") +
      " enough to restore everything (admin ⋯ menu → Backup).",
    rows: [
      ["Date", day],
      ["Bookings", all.length + " in total, " + upcoming + " upcoming"],
      ["Allowed emails", String(allowStore.data.emails.length)],
      ["Resumes and receipts", String(count) + (n > 1 ? " (split across " + n + " emails, to keep each one small enough)" : "")],
    ],
    note:
      "bookings.csv opens in Excel or Google Sheets. " +
      (n > 1 ? "The backup-…-part files together are" : "backup.json is") +
      " the full data, with the resumes and receipts, for restoring: choose " +
      (n > 1 ? "all of them" : "it") +
      " at once. It contains candidate details: don't forward it.",
  });
  const sent = await sendEmail({
    to: BACKUP_RECIPIENTS,
    subject: subject + (n > 1 ? " (1 of " + n + ")" : ""),
    ...first,
    files: [
      {
        filename: "bookings-" + day + ".csv",
        content: Buffer.from(bookingsCsvText()).toString("base64"),
        content_type: "text/csv; charset=utf-8",
      },
      attach(0),
    ],
  });
  // the other parts are sent once; one that fails is logged, and next week's backup carries every file again
  if (sent)
    for (let i = 1; i < n; i++) {
      const body = emailBody({
        heading: "Weekly backup, part " + (i + 1) + " of " + n,
        intro: "More resumes and receipts from the " + day + " backup. Keep this email with the others from that day.",
        rows: [["Files in this part", String(Object.keys(parts[i]!.uploads).length)]],
        note:
          "Restore by choosing every backup-" +
          day +
          "-part file together (admin ⋯ menu → Backup). It contains candidate details: don't forward it.",
      });
      if (!(await sendEmail({ to: BACKUP_RECIPIENTS, subject: subject + " (" + (i + 1) + " of " + n + ")", ...body, files: [attach(i)] })))
        console.log("backup: part " + (i + 1) + " of " + n + " not emailed");
    }
  return sent;
}
// Whether the weekly email is due: none sent yet, or the last one was BACKUP_EMAIL_DAYS or more days ago.
const emailDue = (day: string, last: string) => !last || Date.parse(day) - Date.parse(last) >= BACKUP_EMAIL_DAYS * 86400000;
let backupRunning = false;
async function runBackup() {
  const now = istParts(Date.now());
  const day = now.y + "-" + pad(now.mo) + "-" + pad(now.d);
  if (backupRunning || !bookingsStore.ok || now.hh < BACKUP_HOUR) return;
  const st = backupStateStore.data;
  const wantEmail = !!RESEND_API_KEY && BACKUP_RECIPIENTS.length > 0;
  const sendNow = wantEmail && emailDue(day, st.emailed);
  if (st.saved === day && !sendNow) return;
  backupRunning = true;
  try {
    if (st.saved !== day) {
      await saveSnapshot(day);
      st.saved = day;
      console.log("backup: saved " + DATA_DIR + "/backups/" + day + ".json");
    }
    if (sendNow && (await emailBackup(day))) st.emailed = day;
    await saveStore(backupStateStore);
    if (!wantEmail) console.log("backup: not emailed (set BACKUP_EMAIL and RESEND_API_KEY)");
  } catch (e) {
    console.log("backup failed: " + String(e));
  } finally {
    backupRunning = false;
  }
}
// ---- Restoring (owner's ⋯ menu → Backup) ---------------------------------------------------------------------------
// POST /admin/api/restore: the "files" of a backup replace the data. Each file being replaced is first copied to
// <name>.pre-restore. push.json and sessions.json are never replaced, so alerts and the owner's sign-in carry on.
export async function restoreData(b: Fields): Promise<Response> {
  if (b?.app !== "booking-form" || typeof b.files !== "object" || !b.files)
    return json({ error: "That file isn't a backup from this site." }, 400);
  const files = asFields(b.files);
  const names = Object.keys(STORES).filter((name) => name in files);
  if (!names.includes("bookings.json")) return json({ error: "That backup has no bookings in it." }, 400);
  try {
    for (const name of names) {
      const s = STORES[name]!;
      const path = DATA_DIR + "/" + name;
      if (DATA_DIR && (await Bun.file(path).exists())) await copyFile(path, path + ".pre-restore");
      s.data = s.norm(asFields(files[name]));
      // a store whose file didn't read is written too: the backup is what the owner asked for
      s.ok = true;
      await saveStore(s);
    }
  } catch (e) {
    console.log("restore failed: " + String(e));
    return json({ error: "Couldn't save the restored data. Try again." }, 500);
  }
  console.log("backup restored (" + names.length + " files) from " + String(b.createdAt ?? "?"));
  broadcastState();
  return json({ ok: true, restored: names.length, bookings: bookingsStore.data.bookings.length });
}
// POST /admin/api/restore-file?path=resumes/<file>: one resume or receipt from a backup's "uploads", as raw bytes.
export async function restoreUpload(req: Request, path: string): Promise<Response> {
  if (!UPLOAD_PATH.test(path)) return json({ error: "Bad file name." }, 400);
  if ((req.headers.get("content-type") ?? "").toLowerCase() !== "application/octet-stream") return json({ error: "Bad request." }, 415);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) return json({ error: "Empty file." }, 400);
  const [dir, file] = path.split("/") as [string, string];
  await (dir === "resumes" ? saveResume(file, bytes) : dir === "id-cards" ? saveIdCard(file, bytes) : saveReceipt(file, bytes));
  return json({ ok: true });
}
// Runs the backup now (when it is due) and every 15 minutes after.
export async function startBackups() {
  await loadStore(backupStateStore);
  void runBackup();
  setInterval(() => void runBackup(), 15 * 60000);
}
