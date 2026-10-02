// Dates and times, always in India Standard Time. Day keys are "YYYY-MM-DD".
import type { Booking } from "./types";

const TIME_ZONE = "Asia/Kolkata";
function formatIst(options: Intl.DateTimeFormatOptions, date: Date | number) {
  return new Intl.DateTimeFormat(
    "en-US",
    Object.assign(
      {
        timeZone: TIME_ZONE,
      },
      options,
    ),
  ).format(date);
}
function dayKeyOf(date: Date | number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function formatTime(date: Date | number) {
  return formatIst(
    {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    },
    date,
  )
    .replace(" AM", "am")
    .replace(" PM", "pm");
}
// Minutes since midnight in India.
function minutesOfDay(date: Date | number) {
  let minutes = 0;
  new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .forEach(function (part) {
      if (part.type === "hour") {
        minutes += +part.value * 60;
      }
      if (part.type === "minute") {
        minutes += +part.value;
      }
    });
  return minutes;
}
function addDays(day: string, count: number): string {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
// The Monday of the week that day is in.
function weekStart(day: string) {
  return addDays(day, -((new Date(day + "T12:00:00Z").getUTCDay() + 6) % 7));
}
function formatDay(day: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(
    "en-US",
    Object.assign(
      {
        timeZone: "UTC",
      },
      options,
    ),
  ).format(new Date(day + "T12:00:00Z"));
}
function shortDate(iso: string) {
  return formatIst(
    {
      weekday: "short",
      month: "short",
      day: "numeric",
    },
    new Date(iso),
  );
}
function formatRange(booking: Pick<Booking, "start" | "end">) {
  return shortDate(booking.start) + ", " + formatTime(new Date(booking.start)) + " – " + formatTime(new Date(booking.end));
}
function timeAgo(iso: string) {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (seconds < 60) {
    return "just now";
  } else if (seconds < 3600) {
    return Math.round(seconds / 60) + "m ago";
  } else if (seconds < 86400) {
    return Math.round(seconds / 3600) + "h ago";
  } else {
    return Math.round(seconds / 86400) + "d ago";
  }
}
function hourLabel(hour: number) {
  hour %= 24;
  if (hour === 0) {
    return "12 AM";
  } else if (hour < 12) {
    return hour + " AM";
  } else if (hour === 12) {
    return "12 PM";
  } else {
    return hour - 12 + " PM";
  }
}

// The moment a day key and minutes since midnight stand for in India (India has no daylight saving).
function istMs(day: string, minutes: number) {
  return Date.parse(day + "T00:00:00Z") + (minutes - 330) * 60000;
}
// The part of an unavailable time that falls on a day, in minutes since that day's midnight; null when none does.
function blockSpan(block: { start: string; end: string }, day: string) {
  const from = Math.max(Date.parse(block.start), istMs(day, 0));
  const to = Math.min(Date.parse(block.end), istMs(day, 1440));
  return to > from ? { from: (from - istMs(day, 0)) / 60000, to: (to - istMs(day, 0)) / 60000 } : null;
}
// "Mon, Oct 5" for a whole day, "Mon, Oct 5 – Wed, Oct 7" for whole days, "Mon, Oct 5, 2:00pm – 5:00pm" for hours.
function blockLabel(block: { start: string; end: string }) {
  const start = Date.parse(block.start);
  const end = Date.parse(block.end);
  const midnight = (ms: number) => minutesOfDay(ms) === 0;
  if (midnight(start) && midnight(end)) {
    const last = end - 86400000;
    return shortDate(block.start) + (dayKeyOf(last) > dayKeyOf(start) ? " – " + shortDate(new Date(last).toISOString()) : "");
  }
  if (dayKeyOf(start) === dayKeyOf(end - 1)) {
    return shortDate(block.start) + ", " + formatTime(start) + " – " + (midnight(end) ? "midnight" : formatTime(end));
  }
  return shortDate(block.start) + ", " + formatTime(start) + " – " + shortDate(block.end) + ", " + formatTime(end);
}

export {
  TIME_ZONE,
  istMs,
  blockSpan,
  blockLabel,
  formatIst,
  dayKeyOf,
  formatTime,
  minutesOfDay,
  addDays,
  weekStart,
  formatDay,
  shortDate,
  formatRange,
  timeAgo,
  hourLabel,
};
