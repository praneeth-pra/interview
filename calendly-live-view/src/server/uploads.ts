// What the public forms with a file share: reading the multipart form within its limits, checking what kind of file
// came, and keeping the files in a folder of DATA_DIR (in memory when there is no data folder).
import { DATA_DIR } from "./config";
import { type Srv, clientIp, json, underLimit } from "./http";
import { mkdir, rm } from "node:fs/promises";

export type Kind = { ext: string; type: string; at: number; magic: number[] };
// what the first bytes of each allowed kind of file look like (HEIC photos have "ftyp" after a 4-byte length)
export const PHOTO_OR_PDF: Kind[] = [
  { ext: ".pdf", type: "application/pdf", at: 0, magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: ".png", type: "image/png", at: 0, magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: ".jpg", type: "image/jpeg", at: 0, magic: [0xff, 0xd8, 0xff] },
  { ext: ".webp", type: "image/webp", at: 8, magic: [0x57, 0x45, 0x42, 0x50] },
  { ext: ".heic", type: "image/heic", at: 4, magic: [0x66, 0x74, 0x79, 0x70] },
];
export const PDF_OR_WORD: Kind[] = [
  PHOTO_OR_PDF[0]!,
  { ext: ".docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", at: 0, magic: [0x50, 0x4b, 0x03, 0x04] },
  { ext: ".doc", type: "application/msword", at: 0, magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];
export const kindOf = (bytes: Uint8Array, kinds: readonly Kind[]) => kinds.find((k) => k.magic.every((b, i) => bytes[k.at + i] === b));
export const mb = (n: number) => String(Math.round((n / 1048576) * 10) / 10);

// One folder of uploads: "resumes", "receipts", "id-cards" or "invites".
export function uploadFolder(dir: string) {
  const inMemory = new Map<string, Uint8Array>();
  return {
    async save(file: string, bytes: Uint8Array) {
      if (!DATA_DIR) return void inMemory.set(file, bytes);
      await mkdir(DATA_DIR + "/" + dir, { recursive: true });
      await Bun.write(DATA_DIR + "/" + dir + "/" + file, bytes);
    },
    async read(file: string): Promise<Uint8Array | null> {
      if (!DATA_DIR) return inMemory.get(file) ?? null;
      const f = Bun.file(DATA_DIR + "/" + dir + "/" + file);
      return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
    },
    async remove(file: string) {
      if (!DATA_DIR) return void inMemory.delete(file);
      await rm(DATA_DIR + "/" + dir + "/" + file, { force: true });
    },
  };
}
export const resumes = uploadFolder("resumes");
export const receipts = uploadFolder("receipts");
export const idCards = uploadFolder("id-cards");
export const invites = uploadFolder("invites");

// A public multipart form: refused when it isn't one, is bigger than maxBytes (tooBig answers), comes more than five
// times an hour from one network (key names the form) or when sentToday has reached 100 in all. The text() it gives
// has spaces tidied and is cut to max; a form whose hidden "website" field (only bots fill it in) has text is null.
export async function readForm(
  req: Request,
  srv: Srv,
  o: { key: string; maxBytes: number; tooBig: string; tooMany: string; busy: string; sentToday: number },
): Promise<Response | { form: FormData; text: (k: string, max: number) => string } | null> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "Bad request." }, 415);
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!(length > 0)) return json({ error: "Bad request." }, 411);
  if (length > o.maxBytes + 64 * 1024) return json({ error: o.tooBig }, 413);
  if (!underLimit(o.key + ":" + clientIp(req, srv), 5, 3600000)) return json({ error: o.tooMany }, 429);
  // at most 100 saved in any 24 hours from everyone together, so a flood of fake ones can't fill the disk
  if (o.sentToday >= 100) return json({ error: o.busy }, 429);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  const text = (k: string, max: number) =>
    String(form.get(k) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  return text("website", 200) ? null : { form, text };
}
export const lastDay = (items: { createdAt: string }[]) => items.filter((v) => Date.parse(v.createdAt) > Date.now() - 86400000).length;
// The file's name as uploaded, without control characters, quotes or slashes, or fallback.
export const uploadedName = (upload: Blob, fallback: string) =>
  (upload instanceof File ? upload.name : "")
    .replace(/[\u0000-\u001f"\\/]/g, "")
    .trim()
    .slice(-120) || fallback;
