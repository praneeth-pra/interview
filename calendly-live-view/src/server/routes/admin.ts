// Everything under /admin: pages for signed-in admins and their API. This file checks who is asking and reads the
// request; what each action does is in the feature's own module.
import { changeAllowlist, allowView } from "../allowlist";
import { analyticsCsv, analyticsView } from "../analytics";
import { adminsView, sessionOf, setAdmins } from "../auth";
import { backupParts, restoreData, restoreUpload } from "../backup";
import { bookingsCsv, cancelBooking, createBooking, moveBooking, setFeedback, setRoundStatus } from "../bookings";
import { DURATIONS, LOGIN_ON, MAX_BODY } from "../config";
import { bookingsStore, isOwner, onboardingStore } from "../data";
import { deleteEnquiry, enquiriesList, enquiriesSeen, resumeFile } from "../enquiries";
import { BASE_HEADERS, CSP, type Srv, json, readJson, sendShell } from "../http";
import { assignInterviewers, renameInterviewers } from "../interviewers";
import { adminState, openStream, pub } from "../live";
import { ANALYTICS, LOGIN, adminShell, sheetPage } from "../pages";
import { MY_SUPPORTER, mySheet } from "../my-interviews";
import { deleteOnboarding, idCardFile, onboardingList } from "../onboarding";
import { dropInvites, inviteFile } from "../invites";
import { checkDeleteCode, sendDeleteCode } from "../delete-code";
import { decidePayment, paymentsList, receiptFile } from "../payments";
import { changePush, pushView } from "../push";
import { reportPdfResponse } from "../report-pdf";
import { slotsFor } from "../schedule";
import { istDate } from "../time";
import { addBlock, removeBlock } from "../unavailable";
import { type Fields, DATE_KEY } from "../util";

// Enquiries, payments, revenue and onboarding forms are for owners only; other admins don't see their tabs, and these APIs refuse them.
const OWNER_ONLY = /^\/admin\/api\/(enquiries|payments|revenue|onboarding)(\/|\.csv$|\.pdf$|$)/;
// What only owners open from the ⋯ menu (added admins have no ⋯ menu): who can sign in, unavailable times, the interview
// supporters' names, the Candidates list, the bookings download and the backup download and restore (which hold all of
// those, and the key that signs candidates' manage links). Added admins still record who supported each interview (PUT /admin/api/interviewers).
const OWNER_SETTINGS =
  /^\/admin\/(api\/(admins|unavailable|interviewer-names|allowlist)(\/|$)|export\.csv$|backup\.json$|api\/restore(-file)?$)/;

export async function adminRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;
  if (path !== "/admin" && !path.startsWith("/admin/")) return null;

  const me = LOGIN_ON ? sessionOf(req) : null;
  const authed = !LOGIN_ON || !!me;
  const owner = authed && isOwner(me?.email ?? "");
  const email = me?.email ?? "";
  const q = (name: string) => url.searchParams.get(name) ?? "";
  // A JSON body of at most max characters, then the action; a bad body is answered for it.
  const withBody = async (max: number, act: (body: Fields) => Promise<Response> | Response) => {
    const body = await readJson(req, max);
    return body instanceof Response ? body : act(body);
  };

  // ---- pages
  if ((path === "/admin" || path === "/admin/allowlist") && method === "GET") {
    if (!authed) return sendShell(req, LOGIN);
    return sendShell(req, adminShell(path === "/admin" || !owner ? "cal" : "allow", owner));
  }
  // the owner's interview sheet (hi-techie.dev/praneeth sends people here, where the sign-in cookie is sent)
  if (path === "/admin/praneeth" && method === "GET") {
    if (!authed) return sendShell(req, LOGIN);
    if (!owner) return new Response("Only the owner can open this page.", { status: 403, headers: BASE_HEADERS });
    return sheetPage(req, MY_SUPPORTER, mySheet());
  }
  if (path === "/admin/analytics" && method === "GET")
    return sendShell(req, authed ? ANALYTICS : { ...LOGIN, csp: CSP.frame, framed: true });
  // the booking page asks this to offer signed-in admins the Demo round (the sign-in cookie is only sent under /admin)
  if (path === "/admin/api/me" && method === "GET") return json({ admin: authed });
  if (!authed) return json({ error: "Sign in again." }, 401);
  if (!owner && OWNER_ONLY.test(path))
    return json({ error: "Only the owner can see enquiries, payments, revenue and onboarding forms." }, 403);
  if (!owner && OWNER_SETTINGS.test(path)) return json({ error: "Only the owner can open this." }, 403);

  // ---- owners: revenue, enquiries, payments, onboarding
  if (path === "/admin/api/revenue" && method === "GET") return json(analyticsView(q("q").slice(0, 100)));
  if (path === "/admin/api/revenue.csv" && method === "GET") return analyticsCsv(q("q").slice(0, 100));
  if (path === "/admin/api/revenue.pdf" && method === "GET") return reportPdfResponse(q("month"));
  if (path === "/admin/api/enquiries" && method === "GET") return json(enquiriesList());
  const resume = path.match(/^\/admin\/api\/enquiries\/([0-9a-f-]{36})\/resume$/);
  if (resume && method === "GET") return resumeFile(resume[1], q("download") === "1");
  if (path === "/admin/api/enquiries/delete" && method === "POST") return withBody(1000, (b) => deleteEnquiry(String(b?.id ?? "")));
  if (path === "/admin/api/enquiries/seen") return enquiriesSeen(email, method === "POST");
  if (path === "/admin/api/payments" && method === "GET") return json(paymentsList());
  const receipt = path.match(/^\/admin\/api\/payments\/([0-9a-f-]{36})\/receipt$/);
  if (receipt && method === "GET") return receiptFile(receipt[1], q("download") === "1");
  if (path === "/admin/api/payments/decide" && method === "POST")
    return withBody(1000, (b) => decidePayment(String(b?.id ?? ""), b?.decision, email));

  if (path === "/admin/api/onboarding" && method === "GET") return json(onboardingList());
  const card = path.match(/^\/admin\/api\/onboarding\/([0-9a-f-]{36})\/(aadhaar|pan)$/);
  if (card && method === "GET") return idCardFile(card[1], card[2], q("download") === "1");
  // deleting a form takes a code emailed to the owner; the candidate's interview invites go with it
  if (path === "/admin/api/onboarding/delete-code" && method === "POST")
    return withBody(1000, (b) => sendDeleteCode(String(b?.id ?? ""), email));
  if (path === "/admin/api/onboarding/delete" && method === "POST")
    return withBody(1000, async (b) => {
      const id = String(b?.id ?? "");
      const form = onboardingStore.data.forms.find((x) => x.id === id);
      if (!form) return json({ error: "That form was already deleted." }, 404);
      const refused = checkDeleteCode(id, email, String(b?.code ?? "").trim());
      if (refused) return refused;
      const done = await deleteOnboarding(id);
      if (done.ok) await dropInvites(form.email);
      return done;
    });

  // ---- who can sign in (owners only)
  if (path === "/admin/api/admins" && method === "GET") return json(adminsView(email));
  if (path === "/admin/api/admins" && method === "POST") {
    if (!me) return json({ error: "Admin sign-in is off, so there is no admin list." }, 409);
    return withBody(10000, (b) => setAdmins(b?.emails, me.email));
  }

  // ---- live state and browser alerts
  if (path === "/admin/api/state" && method === "GET") return json(adminState(owner));
  if (path === "/admin/stream" && method === "GET") return openStream(req, srv, me ? me.id : "", owner);
  if (path === "/admin/api/push" && method === "GET") return json(pushView(email));
  if (path.startsWith("/admin/api/push/") && method === "POST")
    return withBody(3000, (b) => changePush(path.slice("/admin/api/push/".length), b, email));

  // ---- bookings
  if (path === "/admin/api/bookings" && method === "GET")
    return json({ bookings: [...bookingsStore.data.bookings].sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).map(pub) });
  const invite = path.match(/^\/admin\/api\/bookings\/([0-9a-f-]{36})\/invite$/);
  if (invite && method === "GET") return inviteFile(invite[1], q("download") === "1");
  if (path === "/admin/export.csv" && method === "GET") return bookingsCsv();
  if (path === "/admin/backup.json" && method === "GET")
    return new Response(JSON.stringify((await backupParts()).parts[0], null, 1), {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/json",
        "Content-Disposition": 'attachment; filename="backup-' + istDate(new Date().toISOString()) + '.json"',
      },
    });
  // restoring a backup (owner's ⋯ menu → Backup): the data, then each resume and receipt
  if (path === "/admin/api/restore" && method === "POST") return withBody(MAX_BODY, restoreData);
  if (path === "/admin/api/restore-file" && method === "POST") return restoreUpload(req, q("path"));
  if (path === "/admin/api/slots" && method === "GET") {
    const key = q("date");
    const duration = Number(url.searchParams.get("duration"));
    if (!DATE_KEY.test(key) || !DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
    const [y, mo, d] = key.split("-").map(Number);
    return json({ slots: slotsFor(y, mo, d, duration, q("ignore")) });
  }
  if (path === "/admin/api/book" && method === "POST") return withBody(5000, (b) => createBooking(b, req, "admin"));
  if ((path === "/admin/api/reschedule" || path === "/admin/api/cancel") && method === "POST")
    return withBody(2000, (body) => {
      const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
      if (!b || b.cancelled) return json({ error: "That booking isn't active anymore." }, 404);
      if (path.endsWith("cancel")) return cancelBooking(b, String(body?.reason ?? ""), "host", req);
      if (Date.parse(b.start) <= Date.now()) return json({ error: "This interview has already started, so it can't be moved." }, 409);
      return moveBooking(b, Number(body?.startMs), Number(body?.duration), "host", req);
    });
  if (path === "/admin/api/round-status" && method === "POST") return withBody(1000, (b) => setRoundStatus(String(b?.id ?? ""), b?.status));
  if (path === "/admin/api/feedback" && method === "POST")
    return withBody(5000, (b) => setFeedback(String(b?.id ?? ""), b?.rating, b?.notes, email));

  // ---- unavailable times (owners only; they come with the live state)
  if (path === "/admin/api/unavailable" && method === "POST") return withBody(2000, (b) => addBlock(b, email));
  if (path === "/admin/api/unavailable/delete" && method === "POST") return withBody(1000, (b) => removeBlock(String(b?.id ?? "")));

  // ---- Candidates list and interview supporters (only owners rename them)
  if (path === "/admin/api/allowlist") {
    if (method === "GET") return json({ state: allowView() });
    if (method !== "POST") return json({ error: "Method not allowed." }, 405);
    return withBody(200000, changeAllowlist);
  }
  if (path === "/admin/api/interviewers" && method === "PUT") return withBody(20000, assignInterviewers);
  if (path === "/admin/api/interviewer-names" && method === "POST") return withBody(5000, renameInterviewers);
  return json({ error: "Not found." }, 404);
}
