// The booking site's server: the public pages (landing, booking, enquiry), the admin app and their APIs.
// The code lives in src/server/: routes/ for the URLs, one module per feature, data.ts for what is stored.
import { assetList, compressed } from "./assets";
import { startBackups } from "./server/backup";
import { startReports } from "./server/report";
import { removeListedBookings } from "./server/bookings";
import { dropDemoInvites } from "./server/invites";
import { ADMIN_OPEN, LOGIN_ON, OWNER_EMAILS, PORT, PUBLIC_URL, RESEND_API_KEY, EMAIL_FROM, MAX_BODY } from "./server/config";
import { adminsStore, allowStore, bookingsStore, loadStores, pushStore, resultsStore } from "./server/data";
import { ensureSecret } from "./server/links";
import { ensurePushKeys } from "./server/push";
import { route } from "./server/routes";

for (const a of assetList()) console.log("asset " + a.url + " (" + a.raw + " bytes, " + a.br + " compressed)");
await loadStores();
await ensurePushKeys();
await ensureSecret();
await removeListedBookings();
await dropDemoInvites();
console.log(RESEND_API_KEY ? "email: on, sending as " + EMAIL_FROM : "email: off (set RESEND_API_KEY to send invites)");
// Without PUBLIC_URL, links in emails (candidates' manage links, with their token) are built from the request's
// X-Forwarded-Host or Host header, which a visitor can set.
if (!PUBLIC_URL) console.log("PUBLIC_URL is not set: links in emails use the request's host name (set PUBLIC_URL=https://hi-techie.dev)");
console.log("allowlist: " + (allowStore.data.enabled ? "on" : "off") + ", " + allowStore.data.emails.length + " emails");
console.log(
  !LOGIN_ON
    ? "admin sign-in: OFF (ADMIN_OPEN=1), the admin page is open to anyone"
    : OWNER_EMAILS.length
      ? "admin sign-in: on, " + (OWNER_EMAILS.length + adminsStore.data.emails.length) + " admin email(s)"
      : "admin sign-in: on, but ADMIN_EMAILS is empty, so only admins added earlier can sign in (set ADMIN_EMAILS)",
);
if (ADMIN_OPEN && LOGIN_ON) console.log("ADMIN_OPEN is ignored because ADMIN_EMAILS is set");
if (Bun.env.ADMIN_PASSWORD || Bun.env.ADMIN_LOGIN)
  console.log("ADMIN_PASSWORD and ADMIN_LOGIN are no longer used: admins sign in with an emailed code (ADMIN_EMAILS)");
console.log("browser alerts: " + pushStore.data.subs.length + " device(s)");
console.log("analytics results: " + Object.keys(resultsStore.data.people).length + " candidate(s)");

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 30,
  // uploads are at most a 200 KB resume or a payment receipt (RECEIPT_MAX); anything bigger is refused before it is read
  maxRequestBodySize: MAX_BODY,
  async fetch(req, srv) {
    return compressed(req, await route(req, srv));
  },
});
await startBackups();
await startReports();
console.log("booking-form listening on " + server.port + (bookingsStore.ok ? "" : " (no persistent storage attached)"));
