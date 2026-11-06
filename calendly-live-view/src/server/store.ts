// JSON files on the data volume (DATA_DIR), each loaded once and written whole on every change. A save writes the new
// contents to <file>.tmp and fsyncs that first. The current file is renamed to <file>.bak only when it parses; a file
// that does not parse is never copied onto the backup. The tmp file is then renamed into place. Without a durable
// store, saves reject so a caller can answer 503 instead of reporting success.
import { DATA_DIR } from "./config";
import { open, rename, unlink } from "node:fs/promises";
import { type Fields, asFields } from "./util";

export type FileStore<T> = {
  file: string;
  data: T;
  ok: boolean;
  checked: boolean; // loadStore has run (a store that has not been loaded yet is not part of /healthz)
  chain: Promise<void>;
  norm: (x: Fields) => T;
};
const stores: FileStore<unknown>[] = [];
export class StoreUnavailable extends Error {
  constructor(file: string) {
    super("store is not durable: " + file);
    this.name = "StoreUnavailable";
  }
}
export function fileStore<T>(file: string, empty: () => T, norm: (x: Fields) => T): FileStore<T> {
  const s: FileStore<T> = { file, data: empty(), ok: false, checked: false, chain: Promise.resolve(), norm };
  stores.push(s);
  return s;
}
async function readJson(path: string): Promise<unknown | "missing" | "bad"> {
  const f = Bun.file(path);
  if (!(await f.exists())) return "missing";
  try {
    return JSON.parse(await f.text());
  } catch {
    return "bad";
  }
}
function take(parsed: unknown | "missing" | "bad"): Fields | null {
  return parsed === "missing" || parsed === "bad" ? null : asFields(parsed);
}
export async function loadStore<T>(s: FileStore<T>) {
  s.checked = true;
  if (!DATA_DIR) {
    s.ok = false;
    return console.log("store: memory only (" + s.file + ")");
  }
  const path = DATA_DIR + "/" + s.file;
  try {
    // The directory has to be there. A missing volume must not look like an empty, writable store.
    const dir = await open(DATA_DIR, "r");
    await dir.close();
    const main = await readJson(path);
    if (main === "bad") {
      // Keep the backup as it is. Serving the backup in memory is fine; accepting new bookings is not, until the
      // unreadable file is repaired.
      const bak = take(await readJson(path + ".bak"));
      if (bak) s.data = s.norm(bak);
      s.ok = false;
      return console.log("store unreadable, not saving until it is fixed: " + path);
    }
    if (main === "missing") {
      // A crash can leave the new bytes in .tmp, or only the previous file as .bak, with no main file.
      const recovered = take(await readJson(path + ".tmp")) ?? take(await readJson(path + ".bak"));
      if (recovered) s.data = s.norm(recovered);
    } else s.data = s.norm(asFields(main));
    s.ok = true;
    console.log("store loaded: " + path);
  } catch (e) {
    s.ok = false;
    console.log("store unavailable (" + s.file + "): " + String(e));
  }
}
export function saveStore<T>(s: FileStore<T>): Promise<void> {
  if (!DATA_DIR || !s.ok) return Promise.reject(new StoreUnavailable(s.file));
  const path = DATA_DIR + "/" + s.file;
  const run = s.chain.then(async () => {
    const tmp = path + ".tmp";
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(s.data));
      await fh.sync();
    } finally {
      await fh.close();
    }
    // The new bytes are durable in .tmp before the backup is touched. An unreadable main is left off the backup.
    const main = await readJson(path);
    if (main !== "missing" && main !== "bad") await rename(path, path + ".bak");
    await rename(tmp, path);
    const dir = await open(DATA_DIR, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  });
  s.chain = run.then(
    () => {},
    (e) => console.log("save failed (" + s.file + "): " + String(e)),
  );
  return run;
}
// Every store loadStore has already been asked to load, and a real write to the data directory.
export function storesOk() {
  const live = stores.filter((s) => s.checked);
  return !!DATA_DIR && live.length > 0 && live.every((s) => s.ok);
}
export async function probeWrite(): Promise<boolean> {
  if (!DATA_DIR) return false;
  const path = DATA_DIR + "/.health-probe";
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "w");
    await fh.writeFile(String(Date.now()));
    await fh.sync();
    return true;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}
export const durable = async () => storesOk() && (await probeWrite());
// Wait until queued saves have settled. The process calls this on SIGTERM before it exits.
export function drainStores(): Promise<void> {
  return Promise.all(
    stores.map((s) =>
      s.chain.then(
        () => {},
        () => {},
      ),
    ),
  ).then(() => {});
}
