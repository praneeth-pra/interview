// Payments from the public /payment page, with their receipts.
import { RECEIPT_MAX } from "./config";
import { INSTALLMENTS, INSTALLMENT_NAMES, type Installment, type Payment, paymentsStore, pushStore } from "./data";
import { type Srv, json, saveOrUndo, storedFile } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { checkReceipt } from "./receipt-check";
import { saveStore } from "./store";
import { PHOTO_OR_PDF, kindOf, lastDay, mb, readForm, receipts, uploadedName } from "./uploads";
import { EMAIL_RE, normEmail } from "./util";

// the form doesn't mention this limit; a bigger file gets RECEIPT_TOO_BIG, in the browser and here
const RECEIPT_TOO_BIG = "Your receipt is larger than " + mb(RECEIPT_MAX) + " MB. Please upload a smaller file.";
// payments are open to any email, so one email can't pile up payments waiting for a decision
const PENDING_PER_EMAIL = 3;
const rupees = (n: number) => "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const AMOUNT_MAX = 10000000;
// POST /api/payment, a multipart form from the /payment page. When the Candidates list is on, only its emails can send
// one, the same as booking. Five an hour per
// network address; a hidden "website" field that only bots fill in gets a thank-you and is dropped.
export async function receivePayment(req: Request, srv: Srv): Promise<Response> {
  const got = await readForm(req, srv, {
    key: "payment",
    maxBytes: RECEIPT_MAX,
    tooBig: RECEIPT_TOO_BIG,
    tooMany: "Too many payments from this network. Try again in an hour.",
    busy: "We're getting a lot of payments right now. Try again tomorrow.",
    sentToday: lastDay(paymentsStore.data.payments),
  });
  if (!got) return json({ ok: true });
  if (got instanceof Response) return got;
  const { form, text } = got;
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
  const kind = kindOf(bytes, PHOTO_OR_PDF);
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
  const original = uploadedName(receipt, "receipt" + kind.ext);
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
    await receipts.save(entry.receipt.file, bytes);
    paymentsStore.data.payments.push(entry);
    await saveStore(paymentsStore);
  } catch {
    paymentsStore.data.payments = paymentsStore.data.payments.filter((v) => v.id !== id);
    await receipts.remove(entry.receipt.file).catch(() => {});
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
  const bytes = v && (await receipts.read(v.receipt.file));
  if (!v || !bytes) return json({ error: "That receipt isn't there any more." }, 404);
  return storedFile(bytes, v.receipt, download, v.name, "Payment", "receipt");
}
// Confirm or discard a payment waiting for a decision. Either is final: a decided payment can't be changed or deleted.
// Confirming doesn't add anyone to the Candidates list: the onboarding form does, once the email has a confirmed payment.
export async function decidePayment(id: string, choice: unknown, by: string): Promise<Response> {
  const decision = choice === "confirm" ? "confirmed" : choice === "discard" ? "discarded" : "";
  if (!decision) return json({ error: "Bad request." }, 400);
  const v = paymentsStore.data.payments.find((x) => x.id === id);
  if (!v) return json({ error: "That payment isn't there any more." }, 404);
  if (v.decision) return json({ error: "This payment was already " + v.decision + ". It can't be changed." }, 409);
  v.decision = decision;
  v.decidedAt = new Date().toISOString();
  v.decidedBy = by;
  const failed = await saveOrUndo(paymentsStore, () => {
    delete v.decision;
    delete v.decidedAt;
    delete v.decidedBy;
  });
  if (failed) return failed;
  broadcastState();
  return json({ ok: true, payment: paymentView(v) });
}
