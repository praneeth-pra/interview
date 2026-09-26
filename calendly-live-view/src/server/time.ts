// India time (IST) helpers: India has no daylight saving, so a fixed offset is exact.
import { IST_OFFSET_MIN, TZ } from "./config";

export function istParts(ms: number) {
  const t = new Date(ms + IST_OFFSET_MIN * 60000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}
export const istToUtcMs = (y: number, mo: number, d: number, min: number) => Date.UTC(y, mo - 1, d, 0, min) - IST_OFFSET_MIN * 60000;
const fmtIst = (iso: string, o: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o }).format(new Date(iso));
export const t12 = (iso: string) =>
  fmtIst(iso, { hour: "numeric", minute: "2-digit", hour12: true }).replace(" AM", "am").replace(" PM", "pm");
export const whenText = (start: string, end: string) =>
  fmtIst(start, { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + ", " + t12(start) + " \u2013 " + t12(end) + " IST";
export const dayShort = (iso: string) => fmtIst(iso, { weekday: "short", month: "short", day: "numeric" }) + ", " + t12(iso);
export const istDate = (iso: string) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso)) : "");
