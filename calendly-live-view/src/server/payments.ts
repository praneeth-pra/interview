// Payments from the public /payment page, with their receipts.
import { DATA_DIR, RECEIPT_MAX } from "./config";
import { type Payment, paymentsStore, pushStore } from "./data";
import { type Srv, json, underLimit, clientIp } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { saveStore } from "./store";
import { EMAIL_RE, normEmail } from "./util";
import { mkdir, rm } from "node:fs/promises";

// the form doesn't mention this limit; a bigger file gets RECEIPT_TOO_BIG, in the browser and here
const mb = (n: number) => String(Math.round((n / 1048576) * 10) / 10);
export const RECEIPT_TOO_BIG = "Your receipt is larger than " + mb(RECEIPT_MAX) + " MB. Please upload a smaller file.";
const PAYMENTS_PER_DAY = 100;
const AMOUNT_MAX = 10000000;
// what the first bytes of each allowed kind of file look like (HEIC photos have "ftyp" after a 4-byte length)
const RECEIPT_KINDS = [
  { ext: ".pdf", type: "application/pdf", at: 0, magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: ".png", type: "image/png", at: 0, magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: ".jpg", type: "image/jpeg", at: 0, magic: [0xff, 0xd8, 0xff] },
  { ext: ".webp", type: "image/webp", at: 8, magic: [0x57, 0x45, 0x42, 0x50] },
  { ext: ".heic", type: "image/heic", at: 4, magic: [0x66, 0x74, 0x79, 0x70] },
];
const receiptsInMemory = new Map<string, Uint8Array>();
async function saveReceipt(file: string, bytes: Uint8Array) {
  if (!DATA_DIR) return void receiptsInMemory.set(file, bytes);
  await mkdir(DATA_DIR + "/receipts", { recursive: true });
  await Bun.write(DATA_DIR + "/receipts/" + file, bytes);
}
export async function readReceipt(file: string): Promise<Uint8Array | null> {
  if (!DATA_DIR) return receiptsInMemory.get(file) ?? null;
  const f = Bun.file(DATA_DIR + "/receipts/" + file);
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}
export async function removeReceipt(file: string) {
  if (!DATA_DIR) return void receiptsInMemory.delete(file);
  await rm(DATA_DIR + "/receipts/" + file, { force: true });
}
// POST /api/payment, a multipart form from the /payment page. Anyone can send one (no allowlist). Five an hour per
// network address; a hidden "website" field that only bots fill in gets a thank-you and is dropped.
export async function receivePayment(req: Request, srv: Srv): Promise<Response> {
  const ip = clientIp(req, srv);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "Bad request." }, 415);
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!(length > 0)) return json({ error: "Bad request." }, 411);
  if (length > RECEIPT_MAX + 64 * 1024) return json({ error: RECEIPT_TOO_BIG }, 413);
  if (!underLimit("payment:" + ip, 5, 3600000)) return json({ error: "Too many payments from this network. Try again in an hour." }, 429);
  const lastDay = paymentsStore.data.payments.filter((v) => Date.parse(v.createdAt) > Date.now() - 86400000).length;
  if (lastDay >= PAYMENTS_PER_DAY) return json({ error: "We're getting a lot of payments right now. Try again tomorrow." }, 429);
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
  if (text("website", 200)) return json({ ok: true });
  const email = normEmail(text("email", 200));
  const name = text("name", 100);
  const amountText = text("amount", 20).replace(/[,\s₹]/g, "");
  const amount = /^\d+(\.\d{1,2})?$/.test(amountText) ? Number(amountText) : NaN;
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
  if (name.length < 2) return json({ error: "Enter your full name." }, 400);
  if (!(amount > 0) || amount > AMOUNT_MAX) return json({ error: "Enter the amount you paid, in rupees." }, 400);
  const receipt = form.get("receipt");
  if (!(receipt instanceof Blob) || !receipt.size) return json({ error: "Attach your payment receipt." }, 400);
  if (receipt.size > RECEIPT_MAX) return json({ error: RECEIPT_TOO_BIG }, 413);
  const bytes = new Uint8Array(await receipt.arrayBuffer());
  const kind = RECEIPT_KINDS.find((k) => k.magic.every((b, i) => bytes[k.at + i] === b));
  if (!kind) return json({ error: "The receipt must be an image or a PDF." }, 400);
  const id = crypto.randomUUID();
  const original =
    (receipt instanceof File ? receipt.name : "")
      .replace(/[\u0000-\u001f"\\/]/g, "")
      .trim()
      .slice(-120) || "receipt" + kind.ext;
  const entry: Payment = {
    id,
    name,
    email,
    amount,
    createdAt: new Date().toISOString(),
    receipt: { file: id + kind.ext, name: original, type: kind.type, size: bytes.length },
  };
  try {
    await saveReceipt(entry.receipt.file, bytes);
    paymentsStore.data.payments.push(entry);
    await saveStore(paymentsStore);
  } catch {
    paymentsStore.data.payments = paymentsStore.data.payments.filter((v) => v.id !== id);
    await removeReceipt(entry.receipt.file).catch(() => {});
    return json({ error: "Couldn't save your payment details. Try again." }, 500);
  }
  console.log("payment received (" + paymentsStore.data.payments.length + " in total)");
  broadcastState();
  if (pushStore.data.subs.length)
    void pushAll({
      title: "New payment",
      body: name + " · ₹" + amount.toLocaleString("en-IN"),
      tag: "payment:" + id,
      url: "/admin?view=payments",
    });
  return json({ ok: true });
}
export const paymentView = (v: Payment) => ({
  id: v.id,
  name: v.name,
  email: v.email,
  amount: v.amount,
  createdAt: v.createdAt,
  receipt: { name: v.receipt.name, type: v.receipt.type, size: v.receipt.size },
});
