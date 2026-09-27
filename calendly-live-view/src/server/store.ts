// JSON files on the data volume (DATA_DIR), each loaded once and written whole on every change: the previous copy is
// kept as <file>.bak, and a new copy is written to <file>.tmp and renamed over it. Without DATA_DIR everything stays in
// memory.
import { DATA_DIR } from "./config";
import { rename } from "node:fs/promises";
import { type Fields, asFields } from "./util";

export type FileStore<T> = { file: string; data: T; ok: boolean; chain: Promise<void>; norm: (x: Fields) => T };
export function fileStore<T>(file: string, empty: () => T, norm: (x: Fields) => T): FileStore<T> {
  return { file, data: empty(), ok: false, chain: Promise.resolve(), norm };
}
export async function loadStore<T>(s: FileStore<T>) {
  if (!DATA_DIR) return console.log("store: memory only (" + s.file + ")");
  const path = DATA_DIR + "/" + s.file;
  try {
    await Bun.write(DATA_DIR + "/.probe", String(Date.now()));
    const f = Bun.file(path);
    if (await f.exists()) {
      try {
        s.data = s.norm(asFields(JSON.parse(await f.text())));
      } catch {
        try {
          s.data = s.norm(asFields(JSON.parse(await Bun.file(path + ".bak").text())));
        } catch {
          // Neither copy reads. Keep this store in memory only, so the next save can't replace the file with an empty one.
          return console.log("store unreadable, not saving until it is fixed: " + path);
        }
      }
    }
    s.ok = true;
    console.log("store loaded: " + path);
  } catch (e) {
    console.log("store unavailable (" + s.file + "): " + String(e));
  }
}
export function saveStore<T>(s: FileStore<T>): Promise<void> {
  if (!DATA_DIR || !s.ok) return Promise.resolve();
  const path = DATA_DIR + "/" + s.file;
  const run = s.chain.then(async () => {
    const f = Bun.file(path);
    if (await f.exists()) await Bun.write(path + ".bak", f);
    await Bun.write(path + ".tmp", JSON.stringify(s.data));
    // a rename replaces the file in one step, so a crash mid-save leaves the old copy or the new one, never half of it
    await rename(path + ".tmp", path);
  });
  s.chain = run.catch((e) => console.log("save failed (" + s.file + "): " + String(e)));
  return run;
}
