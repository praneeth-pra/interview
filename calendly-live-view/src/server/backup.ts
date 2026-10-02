// ---- Backups ------------------------------------------------------------------------------
// Every day after BACKUP_HOUR (IST, default 2) a full snapshot is written to DATA_DIR/backups (the last 14 are kept),
// and the bookings CSV plus the data (without push.json) are emailed to BACKUP_EMAIL (or HOST_EMAIL).
// backup-state.json records the last day done, so restarts don't send duplicates; a failed email is retried later that day.
// Everything needed to restore. push.json (browser-alert keys) is only in the on-volume snapshots; sessions.json
// (who is signed in) is never copied, so a restore signs everyone out.
import { bookingsCsvText } from "./bookings";
import { BACKUP_HOUR, BACKUP_KEEP, BACKUP_RECIPIENTS, DATA_DIR, HOST_NAME, RESEND_API_KEY } from "./config";
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
import { loadStore, saveStore } from "./store";
import { istParts } from "./time";
import { pad } from "./util";
import { readdir, rm } from "node:fs/promises";
import { mkdir } from "node:fs/promises";

export function backupData(withPush: boolean) {
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
      "payments.json": paymentsStore.data,
      "results.json": resultsStore.data,
      "unavailable.json": blocksStore.data,
      "secret.json": secretStore.data,
      ...(withPush ? { "push.json": pushStore.data } : {}),
    },
  };
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
      {
        filename: "bookings-" + day + ".csv",
        content: Buffer.from(bookingsCsvText()).toString("base64"),
        content_type: "text/csv; charset=utf-8",
      },
      {
        filename: "backup-" + day + ".json",
        content: Buffer.from(JSON.stringify(backupData(false), null, 1)).toString("base64"),
        content_type: "application/json",
      },
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
// Runs the backup now (when it is due) and every 15 minutes after.
export async function startBackups() {
  await loadStore(backupStateStore);
  void runBackup();
  setInterval(() => void runBackup(), 15 * 60000);
}
