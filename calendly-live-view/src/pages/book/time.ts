// Dates and times, always shown in India Standard Time.
const TIME_ZONE = "Asia/Kolkata";
function formatIst(ms: number, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(
    "en-US",
    Object.assign(
      {
        timeZone: TIME_ZONE,
      },
      options,
    ),
  ).format(new Date(ms));
}
function formatTime(ms: number) {
  return formatIst(ms, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .replace(" AM", "am")
    .replace(" PM", "pm");
}
// Noon IST on a "YYYY-MM-DD" day, as a timestamp.
function middayOf(dayKey: string) {
  return Date.parse(dayKey + "T12:00:00+05:30");
}
// Today in IST as "YYYY-MM-DD".
function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
// "10:00am – 10:30am, Friday, September 25, 2026"
function formatRange(startMs: number, minutes: number) {
  return (
    formatTime(startMs) +
    " – " +
    formatTime(startMs + minutes * 60000) +
    ", " +
    formatIst(startMs, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  );
}

export { TIME_ZONE, formatIst, formatTime, middayOf, todayKey, formatRange };
