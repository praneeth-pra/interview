// What the laptop layout's sidebar and right-hand panel show (desktop.ts draws them). No DOM, so it is unit-tested.
import { addDays, dayKeyOf, weekStart } from "./time";
import type { Booking } from "./types";

// The days of a month view: whole weeks from the Monday on or before the 1st to the Sunday on or after the last day.
// month is "YYYY-MM"; each entry says whether the day is in that month.
export function monthDays(month: string): { day: string; inMonth: boolean }[] {
  const first = month + "-01";
  const nextMonth = addDays(first, 32).slice(0, 7) + "-01";
  const last = addDays(nextMonth, -1);
  const out: { day: string; inMonth: boolean }[] = [];
  for (let day = weekStart(first); day <= last || out.length % 7; day = addDays(day, 1)) {
    out.push({ day: day, inMonth: day.slice(0, 7) === month });
  }
  return out;
}
// The month before or after ("YYYY-MM").
export function shiftMonth(month: string, count: number) {
  const date = new Date(month + "-15T12:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + count);
  return date.toISOString().slice(0, 7);
}
// How many of the week's interviews (not cancelled) each supporter has, in the order of names, then how many have none.
export function supporterCounts(events: Booking[], assign: Record<string, string>, names: string[], week: string) {
  const end = addDays(week, 7);
  const counts: Record<string, number> = {};
  let none = 0;
  events.forEach(function (booking) {
    const day = dayKeyOf(new Date(booking.start));
    if (booking.cancelled || day < week || day >= end) {
      return;
    }
    const who = assign[booking.id];
    if (who) {
      counts[who] = (counts[who] || 0) + 1;
    } else {
      none++;
    }
  });
  const rows = names.map(function (name) {
    return { name: name, count: counts[name] || 0 };
  });
  // supporters recorded on a booking but since removed from the list still count
  Object.keys(counts).forEach(function (name) {
    if (names.indexOf(name) < 0) {
      rows.push({ name: name, count: counts[name] });
    }
  });
  return { rows: rows, none: none };
}
// The interview on now, or else the next one to start: never a cancelled one or one marked as not taking place.
export function nextInterview(events: Booking[], now: number): Booking | null {
  let best: Booking | null = null;
  events.forEach(function (booking) {
    if (booking.cancelled || booking.missed || Date.parse(booking.end) <= now) {
      return;
    }
    if (!best || Date.parse(booking.start) < Date.parse(best.start)) {
      best = booking;
    }
  });
  return best;
}
// "Now · ends in 10 min", "In 25 min", "In 3 h", "Tomorrow", or the day: how soon an interview is.
export function untilLabel(booking: Booking, now: number) {
  const start = Date.parse(booking.start);
  if (start <= now) {
    const left = Math.max(1, Math.round((Date.parse(booking.end) - now) / 60000));
    return "Now · " + left + " min left";
  }
  const minutes = Math.round((start - now) / 60000);
  if (minutes < 60) {
    return "In " + Math.max(1, minutes) + " min";
  }
  const day = dayKeyOf(start);
  const today = dayKeyOf(now);
  if (day === today) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return "In " + hours + " h" + (rest ? " " + rest + " min" : "");
  }
  if (day === addDays(today, 1)) {
    return "Tomorrow";
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(
    new Date(day + "T12:00:00Z"),
  );
}
// The booking to show beside the agenda when a day opens: the one on now or next to start, else the day's first.
export function dockPick(dayBookings: Booking[], now: number): Booking | null {
  const live = dayBookings.filter(function (booking) {
    return !booking.cancelled;
  });
  return nextInterview(live, now) || live[0] || dayBookings[0] || null;
}
