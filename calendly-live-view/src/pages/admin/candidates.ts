// The search box's candidates, grouped the way Contacts groups them: one row per person (by name, or by email for a
// "Guest"), whatever emails they booked with. No DOM here, so it is unit-tested (tests/page-units.test.ts).
import type { Booking } from "./types";
import { normalizeName } from "../../same-name";

export type CandidateMatch = { booking: Booking; email: string; count: number };

// The email to show for a person: not an admin's own (the server marks those bookings staff, e.g. the owner's email used
// for a demo), then one used for an interview over a demo-only one, then the latest.
function rank(booking: Booking) {
  return [booking.staff ? 0 : 1, /\bdemo\b/i.test(booking.round || "") ? 0 : 1, Date.parse(booking.start) || 0];
}
function better(first: Booking, second: Booking) {
  const a = rank(first);
  const b = rank(second);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
export function candidateMatches(bookings: Booking[], query: string, limit: number) {
  const people = new Map<string, CandidateMatch & { pick: Booking }>();
  bookings.forEach(function (booking) {
    if ((booking.name + " " + booking.email + " " + booking.company).toLowerCase().indexOf(query) < 0) {
      return;
    }
    const name = normalizeName(booking.name);
    const key = name && name !== "guest" ? "n:" + name : "e:" + (booking.email || "").trim().toLowerCase();
    const seen = people.get(key);
    if (!seen) {
      people.set(key, { booking: booking, pick: booking, email: booking.email, count: 1 });
      return;
    }
    seen.count++;
    // the latest booking opens the person in Contacts; the best one gives the email shown
    if (booking.start > seen.booking.start) {
      seen.booking = booking;
    }
    if (better(booking, seen.pick) > 0) {
      seen.pick = booking;
      seen.email = booking.email;
    }
  });
  return Array.from(people.values())
    .slice(0, limit)
    .map(function (match) {
      return { booking: match.booking, email: match.email, count: match.count };
    });
}
