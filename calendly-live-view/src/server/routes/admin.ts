import { adminsView, dropSessions, sessionOf } from "../auth";
import { backupData } from "../backup";
import { bookingsCsv, cancelBooking, commit, createBooking, moveBooking, saveFailed } from "../bookings";
import { DURATIONS, LOGIN_ON, OWNER_EMAILS } from "../config";
import { adminsStore, allowStore, bookingsStore, enquiriesStore, isAdmin, ivStore, normResults, paymentsStore, pushStore, resultsStore } from "../data";
import { enquiryView, readResume, removeResume } from "../enquiries";
import { paymentView, readReceipt, removeReceipt } from "../payments";
import { BASE_HEADERS, CSP, type Srv, json, readJson, sendShell } from "../http";
import { adminState, broadcastState, enc, pub, streams } from "../live";
import { ADMIN_ALLOW, ADMIN_CAL, ANALYTICS, LOGIN } from "../pages";
import { pushEndpointOk, pushTo, pushView } from "../push";
import { slotsFor } from "../schedule";
import { saveStore } from "../store";
import { istDate } from "../time";
import { DATE_KEY, EMAIL_RE, UUID, normEmail } from "../util";

const allowView = () => ({ enabled: allowStore.data.enabled, emails: [...allowStore.data.emails].sort() });
// Everything under /admin: pages for signed-in admins and their API.
export async function adminRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/admin" || path.startsWith("/admin/")) {
    const me = LOGIN_ON ? sessionOf(req) : null;
    const authed = !LOGIN_ON || !!me;
    if ((path === "/admin" || path === "/admin/allowlist") && method === "GET") {
      if (!authed) return sendShell(req, LOGIN);
      return sendShell(req, path === "/admin" ? ADMIN_CAL : ADMIN_ALLOW);
    }
    if (path === "/admin/analytics" && method === "GET")
      return sendShell(req, authed ? ANALYTICS : { ...LOGIN, csp: CSP.frame, framed: true });
    if (!authed) return json({ error: "Sign in again." }, 401);
    // Enquiries from /enquiry, newest first; each resume downloads from its own link; an enquiry can be deleted.
    if (path === "/admin/api/enquiries" && method === "GET")
      return json({
        enquiries: [...enquiriesStore.data.enquiries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(enquiryView),
      });
    const resumePath = path.match(/^\/admin\/api\/enquiries\/([0-9a-f-]{36})\/resume$/);
    if (resumePath && method === "GET") {
      const v = enquiriesStore.data.enquiries.find((x) => x.id === resumePath[1]);
      const bytes = v && (await readResume(v.resume.file));
      if (!v || !bytes) return json({ error: "That resume isn't there any more." }, 404);
      // opens in the browser to read; ?download=1 saves it as "<candidate> resume.pdf" instead of the uploaded file name
      const download = url.searchParams.get("download") === "1";
      const ext = v.resume.file.slice(v.resume.file.lastIndexOf("."));
      const name = download
        ? (v.name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Candidate") + " resume" + ext
        : v.resume.name;
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": v.resume.type,
          "Content-Disposition":
            (download ? "attachment" : "inline") + '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
        },
      });
    }
    if (path === "/admin/api/enquiries/delete" && method === "POST") {
      const body = await readJson(req, 1000);
      if (body instanceof Response) return body;
      const v = enquiriesStore.data.enquiries.find((x) => x.id === String(body?.id ?? ""));
      if (!v) return json({ error: "That enquiry was already deleted." }, 404);
      const prev = enquiriesStore.data.enquiries;
      enquiriesStore.data.enquiries = prev.filter((x) => x !== v);
      try {
        await saveStore(enquiriesStore);
      } catch {
        enquiriesStore.data.enquiries = prev;
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      await removeResume(v.resume.file).catch(() => {});
      broadcastState();
      return json({ ok: true });
    }
    // when this admin last opened Enquiries (GET), or now (POST, when they open it)
    if (path === "/admin/api/enquiries/seen") {
      const key = me?.email ?? "";
      if (method === "POST") {
        enquiriesStore.data.seen[key] = new Date().toISOString();
        await saveStore(enquiriesStore).catch(() => {});
      }
      return json({ seenAt: enquiriesStore.data.seen[key] ?? "" });
    }
    // Payments from /payment, newest first; each receipt opens or downloads from its own link; a payment can be deleted.
    if (path === "/admin/api/payments" && method === "GET")
      return json({
        payments: [...paymentsStore.data.payments].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(paymentView),
      });
    const receiptPath = path.match(/^\/admin\/api\/payments\/([0-9a-f-]{36})\/receipt$/);
    if (receiptPath && method === "GET") {
      const v = paymentsStore.data.payments.find((x) => x.id === receiptPath[1]);
      const bytes = v && (await readReceipt(v.receipt.file));
      if (!v || !bytes) return json({ error: "That receipt isn't there any more." }, 404);
      // opens in the browser to look at; ?download=1 saves it as "<name> receipt.jpg" instead of the uploaded file name
      const download = url.searchParams.get("download") === "1";
      const ext = v.receipt.file.slice(v.receipt.file.lastIndexOf("."));
      const name = download
        ? (v.name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Payment") + " receipt" + ext
        : v.receipt.name;
      const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
      return new Response(bytes as Uint8Array<ArrayBuffer>, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": v.receipt.type,
          "Content-Disposition":
            (download ? "attachment" : "inline") + '; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
        },
      });
    }
    if (path === "/admin/api/payments/delete" && method === "POST") {
      const body = await readJson(req, 1000);
      if (body instanceof Response) return body;
      const v = paymentsStore.data.payments.find((x) => x.id === String(body?.id ?? ""));
      if (!v) return json({ error: "That payment was already deleted." }, 404);
      const prev = paymentsStore.data.payments;
      paymentsStore.data.payments = prev.filter((x) => x !== v);
      try {
        await saveStore(paymentsStore);
      } catch {
        paymentsStore.data.payments = prev;
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      await removeReceipt(v.receipt.file).catch(() => {});
      broadcastState();
      return json({ ok: true });
    }
    // Who can sign in: the owners (ADMIN_EMAILS, fixed) and the admins they add here.
    if (path === "/admin/api/admins" && method === "GET") return json(adminsView(me?.email ?? ""));
    if (path === "/admin/api/admins" && method === "POST") {
      if (!me) return json({ error: "Admin sign-in is off, so there is no admin list." }, 409);
      const body = await readJson(req, 10000);
      if (body instanceof Response) return body;
      if (!Array.isArray(body?.emails) || body.emails.length > 50) return json({ error: "You can have up to 50 admins." }, 400);
      const emails = [...new Set<string>(body.emails.map(normEmail))];
      const bad = emails.find((e) => !EMAIL_RE.test(e) || e.length > 200);
      if (bad !== undefined) return json({ error: (bad || "An empty entry") + " isn't a valid email address." }, 400);
      const list = emails.filter((e) => !OWNER_EMAILS.includes(e));
      if (!OWNER_EMAILS.includes(me.email) && !list.includes(me.email))
        return json({ error: "You can't remove yourself. Ask an owner to do it." }, 400);
      const prev = adminsStore.data.emails;
      adminsStore.data.emails = list;
      try {
        await saveStore(adminsStore);
      } catch {
        adminsStore.data.emails = prev;
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      // removed admins are signed out everywhere
      await dropSessions((v) => isAdmin(v.email)).catch(() => {});
      return json(adminsView(me.email));
    }
    if (path === "/admin/api/state" && method === "GET") return json(adminState());
    if (path === "/admin/api/push" && method === "GET") return json(pushView());
    if (path.startsWith("/admin/api/push/") && method === "POST") {
      const body = await readJson(req, 3000);
      if (body instanceof Response) return body;
      const endpoint = String(body?.endpoint ?? "");
      const act = path.slice("/admin/api/push/".length);
      if (act === "subscribe") {
        const p256dh = String(body?.keys?.p256dh ?? "");
        const auth = String(body?.keys?.auth ?? "");
        if (!pushEndpointOk(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth))
          return json({ error: "This browser sent an unexpected subscription. Try again." }, 400);
        const subs = pushStore.data.subs.filter((x) => x.endpoint !== endpoint);
        if (subs.length >= 50) return json({ error: "Too many devices. Turn alerts off on an old one first." }, 400);
        subs.push({ endpoint, p256dh, auth, label: String(body?.label ?? "Browser").slice(0, 40), addedAt: new Date().toISOString() });
        pushStore.data.subs = subs;
      } else if (act === "unsubscribe") {
        pushStore.data.subs = pushStore.data.subs.filter((x) => x.endpoint !== endpoint);
      } else if (act === "test") {
        const sub = pushStore.data.subs.find((x) => x.endpoint === endpoint);
        if (!sub) return json({ error: "Alerts aren't on for this device. Turn them on first." }, 404);
        const code = await pushTo(sub, {
          title: "Test notification",
          body: "Alerts are working on this " + sub.label + ".",
          tag: "test",
          url: "/admin",
        });
        return code >= 200 && code < 300
          ? json(pushView())
          : json({ error: "The notification service didn't accept it (" + code + "). Turn alerts off and on again." }, 502);
      } else return json({ error: "Not found." }, 404);
      try {
        await saveStore(pushStore);
      } catch {
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      console.log("browser alerts: " + pushStore.data.subs.length + " device(s)");
      return json(pushView());
    }
    if (path === "/admin/api/bookings" && method === "GET")
      return json({ bookings: [...bookingsStore.data.bookings].sort((a, b) => Date.parse(b.start) - Date.parse(a.start)).map(pub) });
    if (path === "/admin/api/results") {
      if (method === "GET") return json({ people: resultsStore.data.people, joins: resultsStore.data.joins, persistent: resultsStore.ok });
      if (method !== "POST") return json({ error: "Method not allowed." }, 405);
      const body = await readJson(req, 60000);
      if (body instanceof Response) return body;
      const entries = body?.entries;
      if (!entries || typeof entries !== "object" || Array.isArray(entries) || Object.keys(entries).length > 20)
        return json({ error: "Bad request." }, 400);
      const prev = JSON.stringify(resultsStore.data);
      const now = new Date().toISOString();
      for (const [k, v] of Object.entries(entries)) {
        if (!k || k.length > 200) return json({ error: "Bad request." }, 400);
        const raw = (v as any)?.results;
        if (v !== null && (!raw || typeof raw !== "object")) return json({ error: "Bad request." }, 400);
        const results = v === null ? {} : normResults(raw);
        if (v !== null && Object.keys(results).length !== Object.keys(raw).length) return json({ error: "Bad request." }, 400);
        if (Object.keys(results).length > 150) return json({ error: "Too many companies saved for one person." }, 400);
        if (Object.keys(results).length) resultsStore.data.people[k] = { results, updated: now };
        else delete resultsStore.data.people[k];
      }
      if (Object.keys(resultsStore.data.people).length > 10000) {
        resultsStore.data = JSON.parse(prev);
        return json({ error: "Too many candidates saved." }, 400);
      }
      try {
        await saveStore(resultsStore);
      } catch {
        resultsStore.data = JSON.parse(prev);
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      return json({ people: resultsStore.data.people, joins: resultsStore.data.joins, persistent: resultsStore.ok });
    }
    // Join one company name to another (to: "" separates it again). Names are compared lower-cased.
    if (path === "/admin/api/company-joins" && method === "POST") {
      const body = await readJson(req, 4000);
      if (body instanceof Response) return body;
      const from = String(body?.from ?? "")
        .trim()
        .toLowerCase();
      const to = String(body?.to ?? "")
        .trim()
        .toLowerCase();
      if (!from || from === to || from.length > 120 || to.length > 120) return json({ error: "Bad request." }, 400);
      const joins = resultsStore.data.joins;
      const prev = JSON.stringify(joins);
      if (to) {
        // joining A to B when B already leads back to A would make a loop: they're combined already
        for (let k = to, hops = 0; joins[k] && hops < 50; hops++)
          if ((k = joins[k]) === from) return json({ joins, persistent: resultsStore.ok });
        joins[from] = to;
      } else delete joins[from];
      if (Object.keys(joins).length > 5000) {
        resultsStore.data.joins = JSON.parse(prev);
        return json({ error: "Too many combined companies." }, 400);
      }
      try {
        await saveStore(resultsStore);
      } catch {
        resultsStore.data.joins = JSON.parse(prev);
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      return json({ joins: resultsStore.data.joins, persistent: resultsStore.ok });
    }
    if (path === "/admin/export.csv" && method === "GET") return bookingsCsv();
    if (path === "/admin/backup.json" && method === "GET")
      return new Response(JSON.stringify(backupData(false), null, 1), {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "application/json",
          "Content-Disposition": 'attachment; filename="backup-' + istDate(new Date().toISOString()) + '.json"',
        },
      });
    if (path === "/admin/api/slots" && method === "GET") {
      const key = url.searchParams.get("date") ?? "";
      const duration = Number(url.searchParams.get("duration"));
      if (!DATE_KEY.test(key) || !DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
      const [y, mo, d] = key.split("-").map(Number);
      return json({ slots: slotsFor(y, mo, d, duration, url.searchParams.get("ignore") ?? "") });
    }
    if (path === "/admin/api/book" && method === "POST") {
      const body = await readJson(req);
      if (body instanceof Response) return body;
      return createBooking(body, req, "admin");
    }
    if ((path === "/admin/api/reschedule" || path === "/admin/api/cancel") && method === "POST") {
      const body = await readJson(req, 2000);
      if (body instanceof Response) return body;
      const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
      if (!b || b.cancelled) return json({ error: "That booking isn't active anymore." }, 404);
      if (path.endsWith("cancel")) return cancelBooking(b, String(body?.reason ?? ""), "host", req);
      if (Date.parse(b.start) <= Date.now()) return json({ error: "This interview has already started, so it can't be moved." }, 409);
      return moveBooking(b, Number(body?.startMs), Number(body?.duration), "host", req);
    }
    if (path === "/admin/api/allowlist") {
      if (method === "GET") return json({ state: allowView() });
      if (method !== "POST") return json({ error: "Method not allowed." }, 405);
      const body = await readJson(req, 200000);
      if (body instanceof Response) return body;
      const a = allowStore.data;
      const before = { enabled: a.enabled, emails: [...a.emails] };
      let extra: Record<string, unknown> = {};
      const action = String(body?.action ?? "");
      if (action === "add") {
        const have = new Set(a.emails);
        let added = 0;
        let existing = 0;
        const invalid: string[] = [];
        for (const raw of String(body?.text ?? "").split(/[\s,;]+/)) {
          const p = raw.replace(/^[<("']+|[>)"'.]+$/g, "");
          if (!p) continue;
          const e = normEmail(p);
          if (!EMAIL_RE.test(e) || e.length > 200) {
            if (invalid.length < 50) invalid.push(p.slice(0, 80));
            continue;
          }
          if (have.has(e)) {
            existing++;
            continue;
          }
          if (a.emails.length >= 5000) return json({ error: "The list is full (5,000 emails). Remove some first." }, 400);
          have.add(e);
          a.emails.push(e);
          added++;
        }
        extra = { added, existing, invalid };
      } else if (action === "remove") {
        const e = normEmail(body?.email);
        a.emails = a.emails.filter((x) => x !== e);
      } else if (action === "enable") {
        const on = body?.on === true;
        if (on && !a.emails.length) return json({ error: "Add at least one email first. With an empty list, nobody could book." }, 400);
        a.enabled = on;
      } else if (action === "importBooked") {
        const have = new Set(a.emails);
        let added = 0;
        for (const b of bookingsStore.data.bookings) {
          const e = normEmail(b.email);
          if (EMAIL_RE.test(e) && !have.has(e) && a.emails.length < 5000) {
            have.add(e);
            a.emails.push(e);
            added++;
          }
        }
        extra = { added };
      } else return json({ error: "Bad request." }, 400);
      try {
        await saveStore(allowStore);
      } catch {
        allowStore.data = before;
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      broadcastState();
      return json({ state: allowView(), ...extra });
    }
    if (path === "/admin/stream" && method === "GET") {
      if (streams.size >= 50) return new Response("Too many viewers", { status: 503, headers: BASE_HEADERS });
      srv.timeout(req, 0);
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          streams.set(c, me ? me.id : "");
          c.enqueue(enc.encode("retry: 3000\n\nevent: state\ndata: " + JSON.stringify(adminState()) + "\n\n"));
        },
        cancel() {
          streams.delete(ctrl);
        },
      });
      req.signal.addEventListener("abort", () => streams.delete(ctrl));
      return new Response(stream, {
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }
    // Mark a started interview as a no-show or as not happened for another reason, or undo it ("").
    if (path === "/admin/api/missed" && method === "POST") {
      const body = await readJson(req, 1000);
      if (body instanceof Response) return body;
      const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
      const missed = body?.missed;
      if (!b || (missed !== "noshow" && missed !== "other" && missed !== "")) return json({ error: "Bad request." }, 400);
      if (b.cancelled) return json({ error: "This interview was cancelled." }, 409);
      if (missed && Date.parse(b.start) > Date.now() + 60000)
        return json({ error: "You can mark this once the interview's start time has passed." }, 409);
      if (missed && ivStore.data.assign[b.id])
        return json({ error: "Interview support is already recorded for this interview, so it happened." }, 409);
      const prev = { ...b };
      if (missed) {
        Object.assign(b, { missed, missedAt: new Date().toISOString() });
        delete b.outcome;
        delete b.outcomeAt;
      } else {
        delete b.missed;
        delete b.missedAt;
      }
      if (!(await commit(b, prev))) return saveFailed();
      broadcastState();
      return json({ ok: true });
    }
    // The round's result from the booking panel, once the interview has started: "cleared", "rejected", "hold",
    // "noshow" or "other" (didn't happen), or "" to clear it. No-show and didn't happen reuse the missed mark.
    if (path === "/admin/api/round-status" && method === "POST") {
      const body = await readJson(req, 1000);
      if (body instanceof Response) return body;
      const b = bookingsStore.data.bookings.find((x) => x.id === String(body?.id ?? ""));
      const status = body?.status;
      if (!b || !["", "cleared", "rejected", "hold", "noshow", "other"].includes(status)) return json({ error: "Bad request." }, 400);
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
      if (status && !missed) Object.assign(b, { outcome: status, outcomeAt: now });
      else {
        delete b.outcome;
        delete b.outcomeAt;
      }
      if (!(await commit(b, prev))) return saveFailed();
      broadcastState();
      return json({ ok: true });
    }
    if (path === "/admin/api/interviewers" && method === "PUT") {
      const body = await readJson(req, 20000);
      if (body instanceof Response) return body;
      const iv = ivStore.data;
      const set: Record<string, string> = {};
      for (const [id, name] of Object.entries(body?.set ?? {})) {
        if (!UUID.test(id) || typeof name !== "string" || (name !== "" && !iv.names.includes(name)))
          return json({ error: "Bad request." }, 400);
        if (iv.assign[id] && iv.assign[id] !== name)
          return json({ error: "The interview supporter is locked once recorded, so it can't be changed." }, 409);
        const b = bookingsStore.data.bookings.find((x) => x.id === id);
        if (name && b && Date.parse(b.start) > Date.now() + 60000)
          return json({ error: "You can record the interview supporter once the interview starts." }, 409);
        if (name && b?.missed) return json({ error: "This interview is marked as not happened. Undo that first." }, 409);
        set[id] = name;
      }
      const prev = { ...iv.assign };
      for (const [id, name] of Object.entries(set)) name ? (iv.assign[id] = name) : delete iv.assign[id];
      try {
        await saveStore(ivStore);
      } catch {
        iv.assign = prev;
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      broadcastState();
      return json({ ok: true });
    }
    if (path === "/admin/api/interviewer-names" && method === "POST") {
      const body = await readJson(req, 5000);
      if (body instanceof Response) return body;
      const iv = ivStore.data;
      if (!Array.isArray(body?.list) || body.list.length > 12) return json({ error: "You can have up to 12 interview supporters." }, 400);
      const names: string[] = [];
      const renames = new Map<string, string>();
      for (const r of body.list) {
        const to = String(r?.to ?? "")
          .trim()
          .slice(0, 30);
        if (!to) continue;
        if (names.some((n) => n.toLowerCase() === to.toLowerCase()))
          return json({ error: "Each interview supporter needs a different name." }, 400);
        names.push(to);
        const from = typeof r?.from === "string" ? r.from : "";
        if (from && from !== to && iv.names.includes(from)) renames.set(from, to);
      }
      if (!names.length) return json({ error: "Keep at least one interview supporter." }, 400);
      const prev = { names: iv.names, assign: { ...iv.assign } };
      iv.names = names;
      for (const [id, n] of Object.entries(iv.assign)) if (renames.has(n)) iv.assign[id] = renames.get(n)!;
      try {
        await saveStore(ivStore);
      } catch {
        Object.assign(iv, prev);
        return json({ error: "Couldn't save the change. Try again." }, 500);
      }
      broadcastState();
      return json({ ok: true });
    }
    return json({ error: "Not found." }, 404);
  }
  return null;
}
