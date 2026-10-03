// Creating, moving and cancelling bookings, and the bookings CSV.
import { earlierSpelling } from "./companies";
import { DURATIONS, REMOVE_BOOKINGS, RESEND_API_KEY } from "./config";
import { type Booking, bookingsStore, emailAllowed, ivStore, onboarded } from "./data";
import { notifyBooked, notifyCancelled, notifyRescheduled } from "./email";
import { BASE_HEADERS, json } from "./http";
import { baseUrl, manageUrl, tokenOk } from "./links";
import { broadcastState } from "./live";
import { alertAdmins } from "./push";
import { bookingLimitMs, isBlocked, overlapsExisting, slotOk } from "./schedule";
import { saveStore } from "./store";
import { sameCompany } from "../same-company";
import { istDate, t12 } from "./time";
import { EMAIL_RE, type Fields } from "./util";

export function managedBooking(body: Fields): Booking | Response {
  const id = String(body?.id ?? "");
  const b = bookingsStore.data.bookings.find((x) => x.id === id);
  if (!b || !tokenOk(b.id, body?.t)) return json({ error: "This link isn't valid. Use the link from your confirmation email." }, 403);
  if (b.cancelled) return json({ error: "This interview was already cancelled." }, 409);
  if (Date.parse(b.start) <= Date.now()) return json({ error: "This interview has already started, so it can't be changed here." }, 409);
  return b;
}
export async function commit(b: Booking, prev: Booking) {
  try {
    await saveStore(bookingsStore);
    return true;
  } catch {
    for (const k of Object.keys(b)) if (!(k in prev)) delete (b as Record<string, unknown>)[k];
    Object.assign(b, prev);
    return false;
  }
}
const OUTCOME_LABEL = { cleared: "Cleared", rejected: "Rejected", hold: "On hold" } as const;
// Booking a later round with a company means the one before was cleared: the candidate's latest earlier round with the
// same company (by email, already started, not cancelled) is marked Cleared when it has no result yet or is On hold.
// A round an admin marked Rejected, a no-show or didn't happen is left as it is. Returns the round changed and a copy
// from before the change, so a failed save can put it back.
function clearEarlierRound(next: Booking): { round: Booking; before: Booking } | null {
  if (!next.company) return null;
  const email = next.email.toLowerCase();
  const startMs = Date.parse(next.start);
  const round = bookingsStore.data.bookings
    .filter(
      (x) =>
        x !== next &&
        !x.cancelled &&
        x.email.toLowerCase() === email &&
        !!x.company &&
        (x.company === next.company || sameCompany(x.company, next.company!)) &&
        Date.parse(x.start) < startMs &&
        Date.parse(x.start) <= Date.now(),
    )
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0];
  if (!round || round.missed || (round.outcome && round.outcome !== "hold")) return null;
  const before = { ...round };
  Object.assign(round, { outcome: "cleared", outcomeAt: next.createdAt, outcomeBy: "next-round" });
  return { round, before };
}
// what a new email is told on the booking page, which links "the onboarding form" to /onboarding
export const ONBOARDING_FIRST = "Please fill in the onboarding form with this email first, then book your slot.";
export const saveFailed = () => json({ error: "Couldn't save the change. Try again." }, 500);
export async function createBooking(body: Fields, req: Request, source?: "admin"): Promise<Response> {
  const name = String(body?.name ?? "")
    .trim()
    .slice(0, 120);
  const email = String(body?.email ?? "")
    .trim()
    .slice(0, 200);
  const company = String(body?.company ?? "")
    .trim()
    .slice(0, 120);
  const round = String(body?.round ?? "")
    .trim()
    .slice(0, 60);
  const duration = Number(body?.duration);
  const startMs = Number(body?.startMs);
  if (!name) return json({ error: "Enter a name." }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
  // candidates must say which company the interview is for; the admin form may leave it empty
  if (!source && !company) return json({ error: "Enter the company you're interviewing with.", field: "company" }, 400);
  if (!source && !emailAllowed(email))
    return json({ error: "This email isn't on the invite list. Use the email address your invitation was sent to.", field: "email" }, 403);
  // a new email (never booked before) books only after sending the onboarding form with that email; admins can book anyone
  if (!source && !onboarded(email)) return json({ error: ONBOARDING_FIRST, field: "email", onboarding: true }, 403);
  if (!DURATIONS.includes(duration) || !Number.isFinite(startMs)) return json({ error: "Bad request." }, 400);
  const endMs = startMs + duration * 60000;
  if (
    !slotOk(startMs, duration) ||
    overlapsExisting(startMs, endMs) ||
    (!source && (startMs >= bookingLimitMs() || isBlocked(startMs, endMs)))
  )
    return json({ error: "That time is no longer available. Pick another time.", retry: true }, 409);
  const booking: Booking = {
    id: crypto.randomUUID(),
    name,
    email,
    company: earlierSpelling(email, company),
    round,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    duration,
    createdAt: new Date().toISOString(),
    cancelled: false,
    cancelledAt: "",
    ...(source ? { source } : {}),
  };
  bookingsStore.data.bookings.push(booking);
  const cleared = clearEarlierRound(booking);
  try {
    await saveStore(bookingsStore);
  } catch {
    bookingsStore.data.bookings = bookingsStore.data.bookings.filter((x) => x !== booking);
    if (cleared) {
      for (const k of Object.keys(cleared.round)) if (!(k in cleared.before)) delete (cleared.round as Record<string, unknown>)[k];
      Object.assign(cleared.round, cleared.before);
    }
    return json({ error: "Couldn't save the booking. Try again." }, 500);
  }
  broadcastState();
  const base = baseUrl(req);
  notifyBooked(booking, base);
  if (!source) alertAdmins("booked", booking);
  return json({
    booking: {
      id: booking.id,
      name,
      email,
      company: booking.company,
      round,
      start: booking.start,
      end: booking.end,
      duration,
      manage: manageUrl(base, booking),
    },
    emailed: !!RESEND_API_KEY,
  });
}
export async function moveBooking(
  b: Booking,
  startMs: number,
  duration: number,
  by: "candidate" | "host",
  req: Request,
): Promise<Response> {
  if (!DURATIONS.includes(duration) || !Number.isFinite(startMs)) return json({ error: "Bad request." }, 400);
  if (startMs === Date.parse(b.start) && duration === b.duration)
    return json({ error: "That's already the interview time. Pick a different time." }, 400);
  const endMs = startMs + duration * 60000;
  if (
    !slotOk(startMs, duration) ||
    overlapsExisting(startMs, endMs, b.id) ||
    (by === "candidate" && (startMs >= bookingLimitMs() || isBlocked(startMs, endMs)))
  )
    return json({ error: "That time is no longer available. Pick another time.", retry: true }, 409);
  const prev = { ...b };
  Object.assign(b, {
    prevStart: b.start,
    prevEnd: b.end,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    duration,
    seq: (b.seq ?? 0) + 1,
    rescheduledAt: new Date().toISOString(),
    rescheduledBy: by,
  });
  // a new time is a new chance: it isn't "didn't happen" any more
  delete b.missed;
  delete b.missedAt;
  if (!(await commit(b, prev))) return saveFailed();
  broadcastState();
  notifyRescheduled(b, prev.start, prev.end, baseUrl(req));
  if (by === "candidate") alertAdmins("moved", b);
  return json({ booking: { start: b.start, end: b.end, duration: b.duration }, emailed: !!RESEND_API_KEY });
}
export async function cancelBooking(b: Booking, reason: string, by: "candidate" | "host", req: Request): Promise<Response> {
  const prev = { ...b };
  Object.assign(b, {
    cancelled: true,
    cancelledAt: new Date().toISOString(),
    cancelReason: reason.trim().slice(0, 500),
    cancelledBy: by,
    seq: (b.seq ?? 0) + 1,
  });
  if (!(await commit(b, prev))) return saveFailed();
  broadcastState();
  if (Date.parse(b.start) > Date.now()) {
    notifyCancelled(b, baseUrl(req));
    if (by === "candidate") alertAdmins("cancelled", b);
  }
  return json({ ok: true, emailed: !!RESEND_API_KEY });
}
export const csvCell = (v: unknown) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets treating text as formulas
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
export function bookingsCsvText() {
  const now = Date.now();
  const iv = ivStore.data.assign;
  const d = istDate;
  const who = (x?: string) => (x === "host" ? "You" : x === "candidate" ? "Candidate" : "");
  const rows = [
    [
      "Name",
      "Email",
      "Company",
      "Round",
      "Date",
      "Start (IST)",
      "End (IST)",
      "Length (min)",
      "Status",
      "Interview support given by",
      "Booked on",
      "Booked via",
      "Cancelled by",
      "Cancel reason",
    ],
  ];
  for (const b of [...bookingsStore.data.bookings].sort((x, y) => Date.parse(x.start) - Date.parse(y.start)))
    rows.push([
      b.name,
      b.email,
      b.company,
      b.round,
      d(b.start),
      t12(b.start),
      t12(b.end),
      String(b.duration),
      b.cancelled
        ? "Cancelled"
        : b.outcome
          ? OUTCOME_LABEL[b.outcome]
          : b.missed === "noshow"
            ? "No-show"
            : b.missed
              ? "Didn't happen"
              : Date.parse(b.end) <= now
                ? "Completed"
                : Date.parse(b.start) <= now
                  ? "In progress"
                  : "Upcoming",
      iv[b.id] ?? "",
      d(b.createdAt),
      b.source === "admin" ? "Admin" : b.source === "calendly" ? "Calendly" : "Booking page",
      b.cancelled ? who(b.cancelledBy) : "",
      b.cancelReason ?? "",
    ]);
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export const bookingsCsv = () =>
  new Response(bookingsCsvText(), {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bookings-' + istDate(new Date().toISOString()) + '.csv"',
    },
  });
// One-time cleanup: REMOVE_BOOKINGS lists "Name@YYYY-MM-DD" entries (IST date); matching bookings are deleted on start.
export async function removeListedBookings() {
  if (!REMOVE_BOOKINGS.length || !bookingsStore.ok) return;
  const rules = REMOVE_BOOKINGS.map((r) => {
    const at = r.lastIndexOf("@");
    return at > 0 ? { name: r.slice(0, at).trim().toLowerCase(), day: r.slice(at + 1).trim() } : { name: r.trim().toLowerCase(), day: "" };
  });
  const gone = bookingsStore.data.bookings.filter((b) =>
    rules.some(
      (r) =>
        String(b.name ?? "")
          .trim()
          .toLowerCase() === r.name &&
        (!r.day || istDate(b.start) === r.day),
    ),
  );
  if (gone.length) {
    bookingsStore.data.bookings = bookingsStore.data.bookings.filter((b) => !gone.includes(b));
    for (const b of gone) delete ivStore.data.assign[b.id];
    await saveStore(bookingsStore);
    await saveStore(ivStore);
  }
  console.log(
    "cleanup: removed " + gone.length + " booking(s)" + (gone.length ? ": " + gone.map((b) => b.name + " " + b.start).join(", ") : ""),
  );
}
// The round's result from the booking panel, once the interview has started: "cleared", "rejected", "hold",
// "noshow" or "other" (didn't happen), or "" to clear it. No-show and didn't happen reuse the missed mark.
export async function setRoundStatus(id: string, status: unknown): Promise<Response> {
  const b = bookingsStore.data.bookings.find((x) => x.id === id);
  if (!b || typeof status !== "string" || !["", "cleared", "rejected", "hold", "noshow", "other"].includes(status))
    return json({ error: "Bad request." }, 400);
  if (b.cancelled) return json({ error: "This interview was cancelled." }, 409);
  if (status && Date.parse(b.start) > Date.now() + 60000)
    return json({ error: "You can set the round's status once the interview's start time has passed." }, 409);
  const missed = status === "noshow" || status === "other" ? status : "";
  if (missed && ivStore.data.assign[b.id])
    return json({ error: "Interview support is already recorded for this interview, so it happened." }, 409);
  const prev = { ...b };
  const now = new Date().toISOString();
  if (!missed) {
    delete b.missed;
    delete b.missedAt;
  } else if (b.missed !== missed) Object.assign(b, { missed, missedAt: now });
  delete b.outcomeBy;
  if (status && !missed) Object.assign(b, { outcome: status, outcomeAt: now });
  else {
    delete b.outcome;
    delete b.outcomeAt;
  }
  if (!(await commit(b, prev))) return saveFailed();
  broadcastState();
  return json({ ok: true });
}
