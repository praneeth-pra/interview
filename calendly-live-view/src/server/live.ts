// Live admin updates over server-sent events (/admin/stream).
import { DAY_END_MIN, DAY_START_MIN, RESEND_API_KEY } from "./config";
import { type Booking, activeBookings, allowStore, bookingsStore, enquiriesStore, ivStore, paymentsStore, liveSession, sessionsStore } from "./data";
import { BASE_HEADERS, type Srv } from "./http";
import { BUILD } from "./pages";

export const enc = new TextEncoder();
// Live admin updates, each with the session that opened it ("" when sign-in is off) and whether it is an owner's; a stream
// whose session has ended (signed out, or removed from the admin list) is closed at the next update.
export const streams = new Map<ReadableStreamDefaultController, { sid: string; owner: boolean }>();
export function closeEndedStreams() {
  for (const [c, { sid }] of streams) {
    if (!sid || sessionsStore.data.sessions.some((v) => v.id === sid && liveSession(v))) continue;
    streams.delete(c);
    try {
      c.close();
    } catch {}
  }
}
export const pub = (b: Booking) => ({
  id: b.id,
  name: b.name,
  email: b.email,
  company: b.company,
  round: b.round,
  start: b.start,
  end: b.end,
  duration: b.duration,
  createdAt: b.createdAt,
  source: b.source ?? "",
  cancelled: b.cancelled,
  cancelledAt: b.cancelledAt,
  cancelledBy: b.cancelledBy ?? "",
  cancelReason: b.cancelReason ?? "",
  rescheduledAt: b.rescheduledAt ?? "",
  rescheduledBy: b.rescheduledBy ?? "",
  prevStart: b.prevStart ?? "",
  missed: b.missed ?? "",
  missedAt: b.missedAt ?? "",
  outcome: b.outcome ?? "",
  outcomeAt: b.outcomeAt ?? "",
});
// owner: whether this admin may see enquiries and payments; for everyone else the state leaves them out
export function adminState(owner: boolean) {
  const since = Date.now() - 30 * 86400000;
  const changes = bookingsStore.data.bookings
    .filter((b) => (b.cancelled ? Date.parse(b.cancelledAt) > since : Date.parse(b.rescheduledAt ?? "") > since))
    .map((b) => ({ ...pub(b), kind: b.cancelled ? "cancelled" : "rescheduled", at: b.cancelled ? b.cancelledAt : b.rescheduledAt }))
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))
    .slice(0, 40);
  return {
    ready: true,
    build: BUILD,
    email: !!RESEND_API_KEY,
    hours: { start: DAY_START_MIN, end: DAY_END_MIN },
    iv: { names: ivStore.data.names, assign: ivStore.data.assign },
    allow: { enabled: allowStore.data.enabled, count: allowStore.data.emails.length },
    events: activeBookings()
      .map(pub)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    changes,
    owner,
    ...(owner
      ? {
          // when each enquiry came in; each owner's page counts the ones newer than their last visit to Enquiries
          enquiries: enquiriesStore.data.enquiries.map((v) => v.createdAt),
          // how many payments there are, so an open Payments tab shows a new one straight away
          payments: paymentsStore.data.payments.length,
          // how many wait for the owner to confirm or discard them, for the count on the Payments tab
          paymentsPending: paymentsStore.data.payments.filter((v) => !v.decision).length,
        }
      : {}),
  };
}
// data: the same for everyone, or one version for owners and one for other admins
function send(event: string, data: unknown | ((owner: boolean) => unknown)) {
  closeEndedStreams();
  const chunkFor = (owner: boolean) =>
    enc.encode("event: " + event + "\ndata: " + JSON.stringify(typeof data === "function" ? data(owner) : data) + "\n\n");
  const chunks = new Map<boolean, Uint8Array>();
  for (const [c, { owner }] of streams) {
    if (!chunks.has(owner)) chunks.set(owner, chunkFor(owner));
    try {
      c.enqueue(chunks.get(owner)!);
    } catch {
      streams.delete(c);
    }
  }
}
export const broadcastState = () => {
  if (streams.size) send("state", adminState);
};
setInterval(() => send("tick", {}), 15000);
// GET /admin/stream: the admin page's live connection. It starts with the current state; sid is the viewer's session
// ("" with sign-in off), so the stream closes when that session ends.
export function openStream(req: Request, srv: Srv, sid: string, owner: boolean): Response {
  if (streams.size >= 50) return new Response("Too many viewers", { status: 503, headers: BASE_HEADERS });
  srv.timeout(req, 0);
  let ctrl: ReadableStreamDefaultController;
  const stream = new ReadableStream({
    start(c) {
      ctrl = c;
      streams.set(c, { sid, owner });
      c.enqueue(enc.encode("retry: 3000\n\nevent: state\ndata: " + JSON.stringify(adminState(owner)) + "\n\n"));
    },
    cancel() {
      streams.delete(ctrl);
    },
  });
  req.signal.addEventListener("abort", () => streams.delete(ctrl));
  return new Response(stream, {
    headers: { ...BASE_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
  });
}
