// Which interview times are free.
import { DAYS_AHEAD, DAY_END_MIN, DAY_START_MIN, SLOT_STEP_MIN } from "./config";
import { activeBookings, blocksStore } from "./data";
import { istParts, istToUtcMs } from "./time";
import { pad } from "./util";

export function overlapsExisting(startMs: number, endMs: number, ignoreId = "") {
  return activeBookings().some((b) => b.id !== ignoreId && Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);
}
// Inside a time an admin marked unavailable (⋯ menu → Unavailable). Only candidates are kept out; admins can still book.
export function isBlocked(startMs: number, endMs: number) {
  return blocksStore.data.blocks.some((b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs);
}
export function slotOk(startMs: number, duration: number) {
  if (!(startMs > Date.now()) || startMs % 60000 !== 0) return false;
  const p = istParts(startMs);
  const min = p.hh * 60 + p.mm;
  return min >= DAY_START_MIN && min + duration <= DAY_END_MIN && (min - DAY_START_MIN) % SLOT_STEP_MIN === 0;
}
// Midnight (IST) after the last day candidates may book.
export function bookingLimitMs() {
  const t = istParts(Date.now());
  return istToUtcMs(t.y, t.mo, t.d + DAYS_AHEAD, 0);
}
// candidate: leave out unavailable times too (the booking page); the admin's own booking form still offers them
export function slotsFor(y: number, mo: number, d: number, duration: number, ignoreId = "", candidate = false) {
  const out: number[] = [];
  const now = Date.now();
  for (let m = DAY_START_MIN; m + duration <= DAY_END_MIN; m += SLOT_STEP_MIN) {
    const s = istToUtcMs(y, mo, d, m);
    const e = s + duration * 60000;
    if (s > now && !overlapsExisting(s, e, ignoreId) && !(candidate && isBlocked(s, e))) out.push(s);
  }
  return out;
}
// The booking page's days. Each day carries its free times too, so the booking page shows them without one request per day.
export function bookableDays(duration: number, ignoreId = "") {
  const today = istParts(Date.now());
  const limit = bookingLimitMs();
  const out: { key: string; open: boolean; slots: number[] }[] = [];
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const t = new Date(Date.UTC(today.y, today.mo - 1, today.d + i));
    const [y, mo, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    const slots = slotsFor(y, mo, d, duration, ignoreId, true).filter((s) => s < limit);
    out.push({ key: y + "-" + pad(mo) + "-" + pad(d), open: slots.length > 0, slots });
  }
  return out;
}
