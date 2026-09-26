// The public site: landing, booking, enquiry and manage-link pages, and their API.
import { asset, respond } from "../../assets";
import { cancelBooking, createBooking, managedBooking, moveBooking } from "../bookings";
import { companySuggestions, knownName } from "../companies";
import { DURATIONS, HOST_NAME } from "../config";
import { bookingsStore, emailAllowed } from "../data";
import { receiveEnquiry } from "../enquiries";
import { BASE_HEADERS, type Srv, json, readJson, sendShell, underLimit, clientIp } from "../http";
import { tokenOk } from "../links";
import { BOOK_HOME, ENQUIRY, HOME, ICON, SW_JS, bookPage, splash } from "../pages";
import { bookableDays, bookingLimitMs, slotsFor } from "../schedule";
import { DATE_KEY, EMAIL_RE, UUID, normEmail } from "../util";

export async function publicRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/favicon.ico") return new Response(null, { status: 204 });
  if (path === "/healthz") return new Response("ok", { headers: BASE_HEADERS });
  if (path === "/sw.js")
    return new Response(SW_JS, {
      headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  if (path === "/manifest.webmanifest")
    return new Response(
      JSON.stringify({
        name: HOST_NAME + " Admin",
        short_name: HOST_NAME,
        start_url: "/admin",
        scope: "/",
        display: "standalone",
        background_color: "#141414",
        theme_color: "#141414",
        icons: [
          { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon.png", sizes: "192x192", type: "image/png", purpose: "any" },
        ],
      }),
      { headers: { ...BASE_HEADERS, "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } },
    );
  if (path.startsWith("/splash/") && (method === "GET" || method === "HEAD")) {
    const body = splash(path.slice(8));
    return body
      ? respond(req, body, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" })
      : new Response("Not found", { status: 404, headers: BASE_HEADERS });
  }
  if (path === "/icon.png" || path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png")
    return respond(req, ICON, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" });
  if (path.startsWith("/assets/") && (method === "GET" || method === "HEAD")) {
    const a = asset(path);
    if (!a) return new Response("Not found", { status: 404, headers: BASE_HEADERS });
    return respond(req, a.body, { ...BASE_HEADERS, "Cache-Control": a.current ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  if (path === "/" && method === "GET") return sendShell(req, HOME);
  if (path === "/booking" && method === "GET") return sendShell(req, BOOK_HOME);
  if (path === "/booking/" && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/booking" } });
  if (path === "/enquiry" && method === "GET") return sendShell(req, ENQUIRY);
  if ((path === "/enquiry/" || path === "/inquiry" || path === "/enquiries") && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/enquiry" } });
  if (path === "/api/enquiry" && method === "POST") return receiveEnquiry(req, srv);
  const mm = path.match(/^\/b\/([0-9a-f-]{36})$/i);
  if (mm && method === "GET") {
    const b = bookingsStore.data.bookings.find((x) => x.id === mm[1]);
    const t = url.searchParams.get("t") ?? "";
    if (!b || !tokenOk(b.id, t))
      return bookPage(req, { error: "This link isn't valid. Use the link from your confirmation email, or contact " + HOST_NAME + "." });
    return bookPage(req, {
      id: b.id,
      t,
      name: b.name,
      email: b.email,
      start: b.start,
      end: b.end,
      duration: b.duration,
      cancelled: b.cancelled,
      past: Date.parse(b.start) <= Date.now(),
    });
  }
  const ignoreId = (() => {
    const id = url.searchParams.get("ignore") ?? "";
    return UUID.test(id) && tokenOk(id, url.searchParams.get("t")) ? id : "";
  })();
  if (path === "/api/companies" && method === "GET") return json({ companies: companySuggestions() });
  if (path === "/api/lookup" && method === "GET") {
    const ip = clientIp(req, srv);
    if (!underLimit("lookup:" + ip, 30, 60000)) return json({ name: "" }, 429);
    const email = String(url.searchParams.get("email") ?? "").slice(0, 200);
    if (!EMAIL_RE.test(normEmail(email)) || !emailAllowed(email)) return json({ name: "" });
    return json({ name: knownName(email) });
  }
  if (path === "/api/days" && method === "GET") {
    const duration = Number(url.searchParams.get("duration"));
    if (!DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
    return json({ days: bookableDays(duration, ignoreId) });
  }
  if (path === "/api/slots" && method === "GET") {
    const key = url.searchParams.get("date") ?? "";
    const duration = Number(url.searchParams.get("duration"));
    if (!DATE_KEY.test(key) || !DURATIONS.includes(duration)) return json({ error: "Bad request." }, 400);
    const [y, mo, d] = key.split("-").map(Number);
    return json({ slots: slotsFor(y, mo, d, duration, ignoreId).filter((s) => s < bookingLimitMs()) });
  }
  if (path === "/api/book" && method === "POST") {
    const body = await readJson(req);
    if (body instanceof Response) return body;
    return createBooking(body, req);
  }
  if ((path === "/api/manage/reschedule" || path === "/api/manage/cancel") && method === "POST") {
    const body = await readJson(req);
    if (body instanceof Response) return body;
    const b = managedBooking(body);
    if (b instanceof Response) return b;
    return path.endsWith("cancel")
      ? cancelBooking(b, String(body?.reason ?? ""), "candidate", req)
      : moveBooking(b, Number(body?.startMs), Number(body?.duration), "candidate", req);
  }
  return null;
}
