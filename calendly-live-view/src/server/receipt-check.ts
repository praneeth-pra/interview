// Reads the amount on a payment receipt and compares it with the amount the payer typed. PDFs are read with pdftotext
// (poppler-utils) and images with the tesseract OCR command, both installed in the Docker image; nothing leaves the
// server. When neither is available, or the receipt has no readable amount, the payment is kept as "unread" so an admin
// checks it by eye, rather than refusing an honest payer with a blurry screenshot.

type ReceiptCheck = { status: "verified" } | { status: "mismatch"; read: number[] } | { status: "unread" };

const READ_TIMEOUT_MS = 20000;

async function run(cmd: string[], input: Uint8Array): Promise<string> {
  try {
    const proc = Bun.spawn(cmd, { stdin: input, stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), READ_TIMEOUT_MS);
    const [text] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return proc.exitCode === 0 ? text : "";
  } catch {
    return ""; // the command isn't installed (local runs without it)
  }
}
// psm 11 (scattered text) reads app screenshots best; psm 6 (one block) reads tilted photos and tables that 11 gets
// wrong, so it is the second pass when the first doesn't find the typed amount.
const OCR_PASSES = ["11", "6"];
async function receiptText(bytes: Uint8Array, type: string, pass = 0): Promise<string> {
  if (type === "application/pdf") return pass ? "" : run(["pdftotext", "-l", "3", "-layout", "-", "-"], bytes);
  // HEIC photos can't be read by tesseract; they are left for an admin
  if (type === "image/heic" || pass >= OCR_PASSES.length) return "";
  return run(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", OCR_PASSES[pass]], bytes);
}

// Numbers in the text. Each has its value and whether it looks like money: a currency sign or word before it
// (₹, Rs, INR, or "%" and "=" which is how OCR often reads ₹), Indian or western comma grouping, or two decimals.
type Found = { value: number; money: boolean };
export function numbersIn(text: string): Found[] {
  const out: Found[] = [];
  text = text.replace(/(\d),\s+(\d{2,3}\b)/g, "$1,$2"); // "1, 999.00"
  const re = /(₹|rs\.?|inr|%|=)?\s?(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\d,]*\d)/gi;
  for (const m of text.matchAll(re)) {
    const before = text[(m.index ?? 0) + m[0].length - m[2].length - 1] ?? " ";
    if (/[\w.\/:-]/.test(before) && !m[1]) continue; // part of an id, a date, a time or a word
    const digits = m[2];
    const grouped = digits.includes(",");
    if (grouped && !/^\d{1,3}(,\d{2})*,\d{3}(\.\d{1,2})?$|^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(digits)) continue;
    const value = Number(digits.replace(/,/g, ""));
    if (!(value > 0) || value > 10000000) continue;
    out.push({ value, money: !!m[1] || grouped || /\.\d{2}$/.test(digits) });
    // OCR sometimes reads the ₹ sign as a 2 or a 7 stuck to the amount: "₹5,000" becomes "25,000"
    const stuck = digits.match(/^[27]([1-9]\d{0,2}(?:,\d{2,3})+(?:\.\d{1,2})?)$/);
    if (stuck && /^\d{1,3}(,\d{2})*,\d{3}(\.\d{1,2})?$|^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(stuck[1]))
      out.push({ value: Number(stuck[1].replace(/,/g, "")), money: true });
  }
  return out;
}
// verified: the typed amount is on the receipt. mismatch: the receipt shows amounts, none of them the typed one.
// unread: nothing on it looks like an amount.
export function compareAmount(text: string, amount: number): ReceiptCheck {
  const found = numbersIn(text);
  // OCR often misreads ".00" as ".09" or ".60", so a whole-rupee amount also matches the rupees of a read amount
  const whole = Number.isInteger(amount);
  if (found.some((f) => Math.abs(f.value - amount) < 0.005 || (whole && f.money && Math.floor(f.value) === amount)))
    return { status: "verified" };
  const all = [...new Set(found.filter((f) => f.money).map((f) => f.value))];
  if (!all.length) return { status: "unread" };
  // "₹12,500" misread as "412500" or "212500" shows as ₹12,500 only
  const money = all.filter((v) => !all.some((w) => w !== v && String(v).length > String(w).length && String(v).endsWith(String(w))));
  return { status: "mismatch", read: money.sort((a, b) => b - a).slice(0, 3) };
}
export async function checkReceipt(bytes: Uint8Array, type: string, amount: number): Promise<ReceiptCheck> {
  let text = "";
  let result: ReceiptCheck = { status: "unread" };
  for (let pass = 0; ; pass++) {
    const more = await receiptText(bytes, type, pass);
    if (!more.trim()) return result;
    text += "\n" + more;
    result = compareAmount(text, amount);
    if (result.status === "verified") return result;
  }
}
