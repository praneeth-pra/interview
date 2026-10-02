// ---- Backups ------------------------------------------------------------------------------
// Every day after BACKUP_HOUR (IST, default 2) a data snapshot is written to DATA_DIR/backups (the last 14 are kept), and
// once a week (BACKUP_EMAIL_DAYS after the last one) the bookings CSV plus a full backup (the data without push.json, and
// the resumes and payment receipts) are emailed to BACKUP_EMAIL (or HOST_EMAIL), so the data survives losing the volume.
// backup-state.json records the last days done, so restarts don't send duplicates; a failed email is retried later.
// push.json (browser-alert keys) is only in the on-volume snapshots; sessions.json (who is signed in) is never copied, so
// a restore signs everyone else out.
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
  paymentsStore,
  pushStore,
  resultsStore,
  secretStore,
} from "./data";
import { emailBody, sendEmail } from "./email";
import { readResume, saveResume } from "./enquiries";
import { json } from "./http";
import { broadcastState } from "./live";
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
  "results.json": resultsStore,
  "unavailable.json": blocksStore,
  "secret.json": secretStore,
};
// The resumes and receipts, as "resumes/<file>" or "receipts/<file>"; restoring writes only names like these.
export const UPLOAD_PATH = /^(resumes|receipts)\/[A-Za-z0-9-]{1,64}\.(pdf|docx|doc|png|jpg|webp|heic)$/;
// Resend takes 40 MB an email, and the files are base64 twice over (in the JSON, then as an attachment): about 18 MB of
// files fits with room for the data.
const EMAIL_UPLOADS_MAX = 18 * 1024 * 1024;

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
// The backup with the resumes and receipts (base64), newest first until max bytes; left counts the files that didn't fit.
export async function fullBackup(max = Infinity) {
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
  ].sort((a, b) => b.at.localeCompare(a.at));
  const uploads: Record<string, string> = {};
  let size = 0;
  let left = 0;
  for (const w of wanted) {
    if (!UPLOAD_PATH.test(w.path) || w.path in uploads) continue;
    const bytes = await w.read();
    if (!bytes) continue;
    if (size + bytes.length > max) {
      left++;
      continue;
    }
    size += bytes.length;
    uploads[w.path] = Buffer.from(bytes).toString("base64");
  }
  return { backup: { ...backupData(false), uploads }, count: Object.keys(uploads).length, left };
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
async function emailBackup(day: string) {
  const all = bookingsStore.data.bookings;
  const upcoming = all.filter((b) => !b.cancelled && Date.parse(b.start) > Date.now()).length;
  const { backup, count, left } = await fullBackup(EMAIL_UPLOADS_MAX);
  const body = emailBody({
    heading: "Weekly backup",
    intro:
      "The " +
      HOST_NAME +
      " data as of today. Keep this email: if the server's data is ever lost, the backup file is enough to restore everything (admin ⋯ menu → Backup).",
    rows: [
      ["Date", day],
      ["Bookings", all.length + " in total, " + upcoming + " upcoming"],
      ["Allowed emails", String(allowStore.data.emails.length)],
      ["Resumes and receipts", count + (left ? " (" + left + " older ones didn't fit in this email; they are still on the server)" : "")],
    ],
    note: "bookings.csv opens in Excel or Google Sheets. backup.json is the full data, with the resumes and receipts, for restoring. It contains candidate details: don't forward it.",
  });
  return sendEmail({
    to: BACKUP_RECIPIENTS,
    subject: "Backup: " + HOST_NAME + " bookings \u2013 " + day,
    ...body,
    files: [
      {
        filename: "bookings-" + day + ".csv",
        content: Buffer.from(bookingsCsvText()).toString("base64"),
        content_type: "text/csv; charset=utf-8",
      },
      {
        filename: "backup-" + day + ".json",
        content: Buffer.from(JSON.stringify(backup, null, 1)).toString("base64"),
        content_type: "application/json",
      },
    ],
  });
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
  await (dir === "resumes" ? saveResume(file, bytes) : saveReceipt(file, bytes));
  return json({ ok: true });
}
// Runs the backup now (when it is due) and every 15 minutes after.
export async function startBackups() {
  await loadStore(backupStateStore);
  void runBackup();
  setInterval(() => void runBackup(), 15 * 60000);
}
