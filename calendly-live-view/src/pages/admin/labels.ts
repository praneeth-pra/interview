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
  } else if (Date.parse(booking.end) <= now) {
    return "Completed";
  } else if (Date.parse(booking.start) <= now) {
    return "In progress";
  } else {
    return "Upcoming";
  }
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

export { titleCase, statusOf, byWhom, plural };
