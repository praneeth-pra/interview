// Small helpers shared by the server modules.
import { createHash, timingSafeEqual } from "node:crypto";

// A demo isn't a company's interview: anyone can book one with any email, it carries no interview invite, and its
// name isn't remembered for the email it was booked with.
export const isDemo = (round: string) => /\bdemo\b/i.test(round);

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const normEmail = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLowerCase();
export const pad = (n: number) => String(n).padStart(2, "0");
export const UUID = /^[0-9a-f-]{36}$/i;
export const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
export const DAY_MS = 86400000;
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
// JSON from outside (a request body, a data file): every field is unknown until checked. Anything that isn't a JSON
// object reads as an empty one, so handlers only ever look fields up by name.
export type Fields = { readonly [key: string]: unknown };
export const asFields = (x: unknown): Fields => (x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Fields) : {});
