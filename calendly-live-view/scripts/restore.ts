// Restores a backup JSON (from the weekly email, /admin/backup.json or DATA_DIR/backups) into a data folder.
// Usage: bun run scripts/restore.ts <backup.json> <data dir>   then restart the service.
// Files being replaced are first copied to <name>.pre-restore.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

const [file, dir] = process.argv.slice(2);
if (!file || !dir) {
  console.error("Usage: bun run scripts/restore.ts <backup.json> <data dir>");
  process.exit(1);
}
const backup = JSON.parse(readFileSync(file, "utf8"));
if (backup?.app !== "booking-form" || typeof backup.files !== "object") {
  console.error("That file isn't a booking-form backup.");
  process.exit(1);
}
for (const [name, data] of Object.entries(backup.files)) {
  if (!/^[a-z-]+\.json$/.test(name)) continue;
  const path = dir.replace(/\/+$/, "") + "/" + name;
  if (existsSync(path)) await copyFile(path, path + ".pre-restore");
  await writeFile(path, JSON.stringify(data));
  console.log("restored " + path);
}
// the resumes and receipts (in backups since they went into the weekly email)
let uploads = 0;
for (const [name, b64] of Object.entries(backup.uploads ?? {})) {
  if (!/^(resumes|receipts)\/[A-Za-z0-9-]{1,64}\.(pdf|docx|doc|png|jpg|webp|heic)$/.test(name) || typeof b64 !== "string") continue;
  const path = dir.replace(/\/+$/, "") + "/" + name;
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, Buffer.from(b64, "base64"));
  uploads++;
}
if (uploads) console.log("restored " + uploads + " resumes and receipts");
console.log("Backup from " + backup.createdAt + " restored. Restart the service to load it.");
