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
// The round's status, set by an admin in the booking panel. Cancelled and No-show are what the app already records
// (a cancelled booking, the no-show mark); a booking with no result yet is Scheduled.
type RoundStatus = { key: string; label: string };
var ROUND_STATUSES: RoundStatus[] = [
  { key: "scheduled", label: "Scheduled" },
  { key: "cleared", label: "Cleared" },
  { key: "rejected", label: "Rejected" },
  { key: "hold", label: "On hold" },
  { key: "noshow", label: "No-show" },
  { key: "cancelled", label: "Cancelled" },
];
function roundStatus(booking: Booking): RoundStatus {
  var key = booking.cancelled
    ? "cancelled"
    : booking.missed === "noshow"
      ? "noshow"
      : booking.missed
        ? "didnthappen"
        : booking.outcome || "scheduled";
  return (
    ROUND_STATUSES.find(function (status) {
      return status.key === key;
    }) || { key: key, label: key === "didnthappen" ? "Didn't happen" : "Scheduled" }
  );
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

export { titleCase, statusOf, missedLabel, statusClass, byWhom, plural, ROUND_STATUSES, roundStatus };
export type { RoundStatus };
