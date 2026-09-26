// Small helpers shared by the server modules.
import { createHash, timingSafeEqual } from "node:crypto";

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
