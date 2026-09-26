// JSON files on the data volume (DATA_DIR), each loaded once and written whole on every change: the previous copy is
// kept as <file>.bak, and a new copy is written to <file>.tmp first. Without DATA_DIR everything stays in memory.
import { DATA_DIR } from "./config";

export type FileStore<T> = { file: string; data: T; ok: boolean; chain: Promise<void>; norm: (x: any) => T };
export function fileStore<T>(file: string, empty: () => T, norm: (x: any) => T): FileStore<T> {
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
export function saveStore<T>(s: FileStore<T>): Promise<void> {
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
