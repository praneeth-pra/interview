// Words shown for bookings and counts.
import type { Booking } from "./types";

function titleCase(text: string | null | undefined): string {
  text = String(text || "");
  if (text === text.toLowerCase()) {
    return text.replace(/(^|[\s\-'])(\p{L})/gu, function (_match, before, letter) {
      return before + letter.toUpperCase();
    });
  } else {
    return text;
  }
}
function statusOf(booking: Booking) {
  const now = Date.now();
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
// The round's status, set by an admin in the booking panel once the interview has started. No-show and Didn't happen
// are the missed mark the app already records; value is what /admin/api/round-status takes.
type RoundStatus = { key: string; label: string; value: string };
const ROUND_STATUSES: RoundStatus[] = [
  { key: "cleared", label: "Cleared", value: "cleared" },
  { key: "rejected", label: "Rejected", value: "rejected" },
  { key: "hold", label: "On hold", value: "hold" },
  { key: "noshow", label: "No-show", value: "noshow" },
  { key: "didnthappen", label: "Didn't happen", value: "other" },
];
// The status set for a booking, or null when none is (or the booking was cancelled).
function roundStatus(booking: Booking): RoundStatus | null {
  const key = booking.cancelled ? "" : booking.missed === "noshow" ? "noshow" : booking.missed ? "didnthappen" : booking.outcome || "";
  return (
    ROUND_STATUSES.find(function (status) {
      return status.key === key;
    }) || null
  );
}
// A status pill: the round's status when set, otherwise Upcoming, In progress, Completed or Cancelled.
function statusPill(booking: Booking, small?: boolean) {
  const round = roundStatus(booking);
  const label = round ? round.label : statusOf(booking);
  return { class: "bk-st " + (small ? "sm " : "") + (round ? "rs-" + round.key : statusClass(label)), text: label };
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

export { titleCase, statusOf, missedLabel, statusClass, byWhom, plural, ROUND_STATUSES, roundStatus, statusPill };
export type { RoundStatus };
// what the candidate said about their experience (enquiries and onboarding), after the years
export const GENUINE = { yes: " · Genuine", no: " · Not genuine", "": "" };
