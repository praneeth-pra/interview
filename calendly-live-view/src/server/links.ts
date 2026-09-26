// Candidates' manage links (/b/<id>?t=<token>): the token is an HMAC of the booking id with the key in secret.json.
import { PUBLIC_URL } from "./config";
import { type Booking, secretStore } from "./data";
import { saveStore } from "./store";
import { safeEq } from "./util";
import { createHmac, randomBytes } from "node:crypto";

function manageToken(id: string) {
  return createHmac("sha256", secretStore.data.key)
    .update("manage:" + id)
    .digest("hex")
    .slice(0, 32);
}
export function tokenOk(id: string, t: unknown) {
  return !!secretStore.data.key && typeof t === "string" && t.length === 32 && safeEq(t, manageToken(id));
}
export function baseUrl(req: Request) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0].trim();
  return (/^(localhost|127\.)/.test(host) ? "http://" : "https://") + host;
}
// The address search engines should use for the site: www.hi-techie.dev and hi-techie.dev serve the same pages, so
// links to the landing page always name the one without www.
export const siteUrl = (req: Request) => baseUrl(req).replace("://www.", "://");
export const manageUrl = (base: string, b: Booking) => base + "/b/" + b.id + "?t=" + manageToken(b.id);
// The key for manage links, made once and kept in secret.json.
export async function ensureSecret() {
  if (secretStore.data.key) return;
  secretStore.data.key = randomBytes(32).toString("hex");
  await saveStore(secretStore).catch(() => {});
}
