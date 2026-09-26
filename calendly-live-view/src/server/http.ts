// Response helpers, security headers and request limits.
import { encode, respond } from "../assets";

export const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Strict-Transport-Security": "max-age=31536000",
  // pages opened from this site can't reach back into it, and no page may use the camera, microphone or location
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cache-Control": "no-store",
};
export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...BASE_HEADERS, ...extra } });
// Scripts and styles are files under /assets, so the policy needs no per-request nonce.
const CSP_BASE =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'";
export const CSP = {
  page: CSP_BASE + "; frame-ancestors 'none'",
  admin: CSP_BASE + "; manifest-src 'self'; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'",
  frame: CSP_BASE + "; frame-ancestors 'self'",
};
// app: an admin page the home-screen app may keep for offline use (the service worker only caches responses marked so).
// index: a page search engines may list (only the landing page); everything else is sent with "noindex".
type Shell = { body: ReturnType<typeof encode>; csp: string; framed?: boolean; app?: boolean; index?: boolean };
export const shell = (html: string, csp: string, framed = false, app = false): Shell => ({
  body: encode(html, "text/html; charset=utf-8"),
  csp,
  framed,
  app,
});
export function sendShell(req: Request, s: Shell, cache = "private, no-cache", extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Cache-Control": cache,
    "Content-Security-Policy": s.csp,
    ...(s.framed ? { "X-Frame-Options": "SAMEORIGIN" } : {}),
    ...(s.app ? { "X-App-Shell": "1" } : {}),
    ...extra,
  };
  if (s.index) delete headers["X-Robots-Tag"];
  return respond(req, s.body, headers);
}
export async function readJson(req: Request, max = 5000): Promise<any | Response> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "Bad request." }, 415);
  const raw = await req.text();
  if (raw.length > max) return json({ error: "Too large." }, 413);
  try {
    return JSON.parse(raw);
  } catch {
    return json({ error: "Bad request." }, 400);
  }
}
const hitCounts = new Map<string, { n: number; reset: number }>();
export function underLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (hitCounts.size > 5000) for (const [k, v] of hitCounts) if (v.reset < now) hitCounts.delete(k);
  const h = hitCounts.get(key);
  if (!h || h.reset < now) {
    hitCounts.set(key, { n: 1, reset: now + windowMs });
    return true;
  }
  return ++h.n <= max;
}
export type Srv = { requestIP(r: Request): { address: string } | null; timeout(r: Request, seconds: number): void };
// The visitor's address, for the per-network limits. Railway's edge puts the real one in X-Real-IP; X-Forwarded-For is
// not used because a visitor can write anything at its start.
export const clientIp = (req: Request, srv: Srv) => (req.headers.get("x-real-ip") ?? "").trim() || srv.requestIP(req)?.address || "unknown";
