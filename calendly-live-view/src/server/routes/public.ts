// The public site: landing, booking, enquiry, payment, onboarding and manage-link pages, and their API.
import { asset, respond } from "../../assets";
import { cancelBooking, createBooking, managedBooking, moveBooking } from "../bookings";
import { companySuggestions, knownName } from "../companies";
import { DURATIONS, HOST_NAME } from "../config";
import { bookingsStore, emailAllowed } from "../data";
import { receiveEnquiry } from "../enquiries";
import { receiveOnboarding } from "../onboarding";
import { receivePayment } from "../payments";
import { BASE_HEADERS, type Srv, json, readJson, sendShell, underLimit, clientIp } from "../http";
import { siteUrl, tokenOk } from "../links";
import { BOOK_HOME, ENQUIRY, FAVICON, HOME, ICON, OG_IMAGE, ONBOARDING, PAYMENT, SW_JS, bookPage, splash } from "../pages";
import { bookableDays, bookingLimitMs, slotsFor } from "../schedule";
import { DATE_KEY, EMAIL_RE, UUID, normEmail } from "../util";

export async function publicRoute(req: Request, url: URL, srv: Srv): Promise<Response | null> {
  const path = url.pathname;
  // HEAD is answered like GET (respond() drops the body): link-preview fetchers check pages and pictures with it
  const method = req.method === "HEAD" ? "GET" : req.method;

  if (path === "/healthz") return new Response("ok", { headers: BASE_HEADERS });
  if (path === "/sw.js")
    return new Response(SW_JS, {
      headers: { ...BASE_HEADERS, "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
    });
  if (path === "/manifest.webmanifest")
    return new Response(
      JSON.stringify({
        id: "/admin",
        name: HOST_NAME + " Admin",
        short_name: HOST_NAME,
        start_url: "/admin",
        scope: "/",
        display: "standalone",
        // Android draws its launch screen in these colours; the page's own theme-color takes over once it has loaded.
        // A manifest can't follow light or dark mode, so it matches the light admin, the default.
        background_color: "#f3f0e8",
        theme_color: "#f3f0e8",
        // The drawing sits inside the middle 80% of the tile, so Android can cut it to a circle or squircle.
        icons: [
          { src: "/icon.png?v=8", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon.png?v=8", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Long-press the home-screen icon on Android. Admins who aren't owners land on the Calendar for the last two.
        shortcuts: [
          { name: "Agenda", url: "/admin?view=agenda", icons: [{ src: "/icon.png?v=8", sizes: "512x512" }] },
          { name: "Enquiries", url: "/admin?view=enquiries", icons: [{ src: "/icon.png?v=8", sizes: "512x512" }] },
          { name: "Payments", url: "/admin?view=payments", icons: [{ src: "/icon.png?v=8", sizes: "512x512" }] },
        ],
      }),
      { headers: { ...BASE_HEADERS, "Content-Type": "application/manifest+json", "Cache-Control": "no-cache" } },
    );
  if (path.startsWith("/splash/") && method === "GET") {
    const body = splash(path.slice(8));
    return body
      ? respond(req, body, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" })
      : new Response("Not found", { status: 404, headers: BASE_HEADERS });
  }
  if (path === "/og.jpg") return respond(req, OG_IMAGE, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" });
  if (path === "/favicon.png" || path === "/favicon.ico")
    return respond(req, FAVICON, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" });
  if (path === "/icon.png" || path === "/apple-touch-icon.png" || path === "/apple-touch-icon-precomposed.png")
    return respond(req, ICON, { ...BASE_HEADERS, "Cache-Control": "public, max-age=86400" });
  if (path.startsWith("/assets/") && method === "GET") {
    const a = asset(path);
    if (!a) return new Response("Not found", { status: 404, headers: BASE_HEADERS });
    return respond(req, a.body, { ...BASE_HEADERS, "Cache-Control": a.current ? "public, max-age=31536000, immutable" : "no-cache" });
  }
  // the owner's interview sheet lives under /admin, where the admin sign-in cookie is sent
  if (path.toLowerCase().replace(/\/$/, "") === "/praneeth" && method === "GET")
    return new Response(null, { status: 302, headers: { ...BASE_HEADERS, Location: "/admin/praneeth" } });
  if (path === "/" && method === "GET") return sendShell(req, HOME, undefined, { Link: "<" + siteUrl(req) + '/>; rel="canonical"' });
  // For search engines: the landing page is listed; the admin, the API and candidates' manage links are not crawled.
  if (path === "/robots.txt" && method === "GET")
    return new Response(
      ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "Disallow: /b/", "", "Sitemap: " + siteUrl(req) + "/sitemap.xml", ""].join(
        "\n",
      ),
      { headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
    );
  if (path === "/sitemap.xml" && method === "GET")
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' +
        Bun.escapeHTML(siteUrl(req)) +
        "/</loc></url></urlset>\n",
      { headers: { ...BASE_HEADERS, "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } },
    );
  if (path === "/booking" && method === "GET") return sendShell(req, BOOK_HOME);
  if (path === "/booking/" && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/booking" } });
  if (path === "/enquiry" && method === "GET") return sendShell(req, ENQUIRY);
  if ((path === "/enquiry/" || path === "/inquiry" || path === "/enquiries") && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/enquiry" } });
  if (path === "/api/enquiry" && method === "POST") return receiveEnquiry(req, srv);
  // the payment page isn't listed anywhere public and search engines are told not to index it (X-Robots-Tag)
  if (path === "/payment" && method === "GET") return sendShell(req, PAYMENT);
  if ((path === "/payment/" || path === "/payments" || path === "/pay") && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/payment" } });
  if (path === "/api/payment" && method === "POST") return receivePayment(req, srv);
  // the onboarding page is shared by link too, and not indexed
  if (path === "/onboarding" && method === "GET") return sendShell(req, ONBOARDING);
  if (path === "/onboarding/" && method === "GET")
    return new Response(null, { status: 301, headers: { ...BASE_HEADERS, Location: "/onboarding" } });
  if (path === "/api/onboarding" && method === "POST") return receiveOnboarding(req, srv);
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
    return json({ slots: slotsFor(y, mo, d, duration, ignoreId, true).filter((s) => s < bookingLimitMs()) });
  }
  if (path === "/api/book" && method === "POST") {
    // a person books a round or two; 20 an hour from one network keeps a script from filling every free time
    if (!underLimit("book:" + clientIp(req, srv), 20, 3600000))
      return json({ error: "Too many bookings from this network. Try again in an hour." }, 429);
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
