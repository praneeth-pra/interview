import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkReceipt, compareAmount, numbersIn } from "../src/server/receipt-check";

// Reading the amount on payment receipts. The screenshots in tests/receipts are made to look like UPI apps' success
// screens; CI installs tesseract and pdftotext as the Docker image does.
describe("amounts on a receipt", () => {
  test("rupee amounts in the ways apps and banks write them", () => {
    const money = (t: string) => numbersIn(t).filter((n) => n.money).map((n) => n.value);
    expect(money("Paid ₹5,000")).toEqual([5000]);
    expect(money("₹ 1,25,000.50 debited")).toEqual([125000.5]);
    expect(money("Rs.1,999.00 to Hi-Techie")).toEqual([1999]);
    expect(money("Amount INR 15000.00")).toEqual([15000]);
    // OCR often reads ₹ as % or as a 2 stuck to the amount
    expect(money("%8,000 Completed")).toEqual([8000]);
    expect(money("25,000")).toEqual([25000, 5000]);
    // ids, dates, times and phone numbers are not amounts
    expect(money("UPI transaction ID 427019383746 on 26/09/2026 at 16:40 from 9876543210@ybl")).toEqual([]);
  });

  test("the typed amount matches, doesn't match, or can't be found", () => {
    expect(compareAmount("Paid to Hi Techie ₹5,000 Completed", 5000)).toEqual({ status: "verified" });
    expect(compareAmount("Paid to Hi Techie ₹5,000 Completed", 6000)).toEqual({ status: "mismatch", read: [5000] });
    // an amount written without a sign still counts when it is the typed one
    expect(compareAmount("Amount 5000 Ref 427019383746", 5000)).toEqual({ status: "verified" });
    expect(compareAmount("Ref 427019383746 26 Sep 2026", 5000)).toEqual({ status: "unread" });
    expect(compareAmount("", 5000)).toEqual({ status: "unread" });
  });
});

describe("reading real receipts", () => {
  const file = async (name: string) => new Uint8Array(await Bun.file(join(import.meta.dir, "receipts", name)).arrayBuffer());
  const ocr = !!Bun.which("tesseract");
  const pdf = !!Bun.which("pdftotext");
  test.skipIf(!ocr)("a Google Pay screenshot: ₹5,000", async () => {
    const bytes = await file("gpay-5000.jpg");
    expect(await checkReceipt(bytes, "image/jpeg", 5000)).toEqual({ status: "verified" });
    expect(await checkReceipt(bytes, "image/jpeg", 50000)).toEqual({ status: "mismatch", read: [5000] });
  });
  test.skipIf(!ocr)("a PhonePe screenshot: ₹12,500", async () => {
    const bytes = await file("phonepe-12500.jpg");
    expect(await checkReceipt(bytes, "image/jpeg", 12500)).toEqual({ status: "verified" });
    expect((await checkReceipt(bytes, "image/jpeg", 2500)).status).toBe("mismatch");
  });
  test.skipIf(!pdf)("a bank transfer PDF: INR 20,000.00", async () => {
    const bytes = await file("bank-20000.pdf");
    expect(await checkReceipt(bytes, "application/pdf", 20000)).toEqual({ status: "verified" });
    expect((await checkReceipt(bytes, "application/pdf", 2000)).status).toBe("mismatch");
  });
  test("a file that can't be read is left for an admin", async () => {
    expect(await checkReceipt(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png", 5000)).toEqual({ status: "unread" });
    expect(await checkReceipt(new Uint8Array([1, 2, 3]), "image/heic", 5000)).toEqual({ status: "unread" });
  });
});
