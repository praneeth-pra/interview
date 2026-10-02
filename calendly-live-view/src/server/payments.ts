// Payments from the public /payment page, with their receipts.
import { DATA_DIR, RECEIPT_MAX } from "./config";
import { INSTALLMENTS, INSTALLMENT_NAMES, type Installment, type Payment, paymentsStore, pushStore } from "./data";
import { allowEmail } from "./allowlist";
import { type Srv, json, saveOrUndo, storedFile, underLimit, clientIp } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { checkReceipt } from "./receipt-check";
import { saveStore } from "./store";
import { EMAIL_RE, normEmail } from "./util";
import { mkdir, rm } from "node:fs/promises";

// the form doesn't mention this limit; a bigger file gets RECEIPT_TOO_BIG, in the browser and here
const mb = (n: number) => String(Math.round((n / 1048576) * 10) / 10);
const RECEIPT_TOO_BIG = "Your receipt is larger than " + mb(RECEIPT_MAX) + " MB. Please upload a smaller file.";
const PAYMENTS_PER_DAY = 100;
// payments are open to any email, so one email can't pile up payments waiting for a decision
const PENDING_PER_EMAIL = 3;
const rupees = (n: number) => "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
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
export async function saveReceipt(file: string, bytes: Uint8Array) {
  if (!DATA_DIR) return void receiptsInMemory.set(file, bytes);
  await mkdir(DATA_DIR + "/receipts", { recursive: true });
  await Bun.write(DATA_DIR + "/receipts/" + file, bytes);
}
export async function readReceipt(file: string): Promise<Uint8Array | null> {
  if (!DATA_DIR) return receiptsInMemory.get(file) ?? null;
  const f = Bun.file(DATA_DIR + "/receipts/" + file);
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}
async function removeReceipt(file: string) {
  if (!DATA_DIR) return void receiptsInMemory.delete(file);
  await rm(DATA_DIR + "/receipts/" + file, { force: true });
}
// POST /api/payment, a multipart form from the /payment page. When the Candidates list is on, only its emails can send
// one, the same as booking. Five an hour per
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
  const installment = text("installment", 20);
  const amountText = text("amount", 20).replace(/[,\s₹]/g, "");
  const amount = /^\d+(\.\d{1,2})?$/.test(amountText) ? Number(amountText) : NaN;
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
  if (name.length < 2) return json({ error: "Enter your full name." }, 400);
  if (!Object.hasOwn(INSTALLMENTS, installment)) return json({ error: "Choose which installment this is.", field: "installment" }, 400);
  if (!(amount > 0) || amount > AMOUNT_MAX) return json({ error: "Enter the amount you paid, in rupees." }, 400);
  if (paymentsStore.data.payments.filter((v) => v.email === email && !v.decision).length >= PENDING_PER_EMAIL)
    return json({ error: "You already have payments waiting to be checked. We'll look at those first." }, 429);
  const receipt = form.get("receipt");
  if (!(receipt instanceof Blob) || !receipt.size) return json({ error: "Attach your payment receipt." }, 400);
  if (receipt.size > RECEIPT_MAX) return json({ error: RECEIPT_TOO_BIG }, 413);
  const bytes = new Uint8Array(await receipt.arrayBuffer());
  const kind = RECEIPT_KINDS.find((k) => k.magic.every((b, i) => bytes[k.at + i] === b));
  if (!kind) return json({ error: "The receipt must be an image or a PDF." }, 400);
  // the amount typed must be the one on the receipt; a receipt with no readable amount is kept for an admin to check
  const check = await checkReceipt(bytes, kind.type, amount);
  if (check.status === "mismatch") {
    const shown = check.read.map(rupees).join(" or ");
    return json(
      { error: "The receipt shows " + shown + ", not " + rupees(amount) + ". Enter the amount on your receipt.", field: "amount" },
      422,
    );
  }
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
    installment: installment as Installment,
    check: check.status,
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
    void pushAll(
      {
        title: "New payment",
        body: name + " · ₹" + amount.toLocaleString("en-IN") + " · " + INSTALLMENT_NAMES[installment as Installment],
        tag: "payment:" + id,
        url: "/admin?view=payments&pay=" + id,
      },
      true,
    );
  return json({ ok: true });
}
export const paymentView = (v: Payment) => ({
  id: v.id,
  name: v.name,
  email: v.email,
  amount: v.amount,
  installment: v.installment ?? "",
  check: v.check ?? "",
  decision: v.decision ?? "",
  decidedAt: v.decidedAt ?? "",
  createdAt: v.createdAt,
  receipt: { name: v.receipt.name, type: v.receipt.type, size: v.receipt.size },
});
// Newest first, for the Payments tab; reversed first, so two sent in the same millisecond still list the later one first.
export const paymentsList = () => ({
  payments: [...paymentsStore.data.payments]
    .reverse()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(paymentView),
});
// A payment's receipt: opens in the browser, or with download saves as "<name> receipt.jpg".
export async function receiptFile(id: string, download: boolean): Promise<Response> {
  const v = paymentsStore.data.payments.find((x) => x.id === id);
  const bytes = v && (await readReceipt(v.receipt.file));
  if (!v || !bytes) return json({ error: "That receipt isn't there any more." }, 404);
  return storedFile(bytes, v.receipt, download, v.name, "Payment", "receipt");
}
// Confirm or discard a payment waiting for a decision. Either is final: a decided payment can't be changed or deleted.
// Confirming an email's first payment also adds it to the Candidates list, so they can book (allowed: whether they now
// can). Later confirmed payments from that email leave the list alone, so removing someone from it sticks.
export async function decidePayment(id: string, choice: unknown, by: string): Promise<Response> {
  const decision = choice === "confirm" ? "confirmed" : choice === "discard" ? "discarded" : "";
  if (!decision) return json({ error: "Bad request." }, 400);
  const v = paymentsStore.data.payments.find((x) => x.id === id);
  if (!v) return json({ error: "That payment isn't there any more." }, 404);
  if (v.decision) return json({ error: "This payment was already " + v.decision + ". It can't be changed." }, 409);
  const email = normEmail(v.email);
  const first = !paymentsStore.data.payments.some((x) => x.decision === "confirmed" && normEmail(x.email) === email);
  v.decision = decision;
  v.decidedAt = new Date().toISOString();
  v.decidedBy = by;
  const failed = await saveOrUndo(paymentsStore, () => {
    delete v.decision;
    delete v.decidedAt;
    delete v.decidedBy;
  });
  if (failed) return failed;
  const allowed = decision === "confirmed" && first ? await allowEmail(v.email) : undefined;
  broadcastState();
  return json({ ok: true, payment: paymentView(v), ...(allowed === undefined ? {} : { allowed }) });
}
