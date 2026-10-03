// Restores a backup (from the weekly email, /admin/backup.json or DATA_DIR/backups) into a data folder. When the email
// split the resumes and receipts over several parts, pass every part file; the one with the data can come first or last.
// Usage: bun run scripts/restore.ts <backup.json> [more part files...] <data dir>   then restart the service.
// Files being replaced are first copied to <name>.pre-restore.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dir = args.pop();
if (!args.length || !dir) {
  console.error("Usage: bun run scripts/restore.ts <backup.json> [more part files...] <data dir>");
  process.exit(1);
}
const all = args.map((f) => JSON.parse(readFileSync(f, "utf8")));
const backup = all.find((b) => typeof b?.files === "object" && b.files);
if (!backup || all.some((b) => b?.app !== "booking-form" || b.createdAt !== backup.createdAt)) {
  console.error("Those aren't the files of one booking-form backup (the one with the data is needed).");
  process.exit(1);
}
backup.uploads = Object.assign({}, ...all.map((b) => b.uploads ?? {}));
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
  if (!/^(resumes|receipts|id-cards)\/[A-Za-z0-9-]{1,64}\.(pdf|docx|doc|png|jpg|webp|heic)$/.test(name) || typeof b64 !== "string")
    continue;
  const path = dir.replace(/\/+$/, "") + "/" + name;
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, Buffer.from(b64, "base64"));
  uploads++;
}
if (uploads) console.log("restored " + uploads + " resumes and receipts");
console.log("Backup from " + backup.createdAt + " restored. Restart the service to load it.");
