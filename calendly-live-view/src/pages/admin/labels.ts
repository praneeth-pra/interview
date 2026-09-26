// Words shown for bookings and counts.
import type { Booking } from "./types";

function titleCase(text: string | null | undefined): string {
  text = String(text || "");
  if (text === text.toLowerCase()) {
    return text.replace(/(^|[\s\-'])(\p{L})/gu, function (match, before, letter) {
      return before + letter.toUpperCase();
    });
  } else {
    return text;
  }
}
function statusOf(booking: Booking) {
  var now = Date.now();
  if (booking.cancelled) {
    return "Cancelled";
  } else if (booking.missed) {
    return missedLabel(booking);
  } else if (Date.parse(booking.end) <= now) {
    return "Completed";
  } else if (Date.parse(booking.start) <= now) {
    return "In progress";
  } else {
    return "Upcoming";
  }
}
// "No-show" or "Didn't happen", for an interview marked as not having taken place ("" otherwise).
function missedLabel(booking: Booking) {
  return booking.missed === "noshow" ? "No-show" : booking.missed ? "Didn't happen" : "";
}
// The class for a status pill: "st-completed", "st-noshow", "st-didnthappen"...
function statusClass(status: string) {
  return "st-" + status.toLowerCase().replace(/[^a-z]/g, "");
}
function byWhom(who: string | undefined) {
  if (who === "host") {
    return "by you";
  } else if (who === "candidate") {
    return "by the candidate";
  } else {
    return "";
  }
}
function plural(count: number, word: string) {
  return count + " " + word + (count === 1 ? "" : "s");
}

export { titleCase, statusOf, missedLabel, statusClass, byWhom, plural };
