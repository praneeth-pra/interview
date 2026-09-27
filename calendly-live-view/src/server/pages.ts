// The HTML pages, built once at startup, and the app's icon, manifest and service worker.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetList, encode, template } from "../assets";
import { EVENT_DESCRIPTION, EVENT_LOCATION, EVENT_NAME, HOST_NAME, LOGIN_ON, RECEIPT_MAX } from "./config";
import { CSP, sendShell, shell } from "./http";
import { deflateSync } from "node:zlib";

export const ICON = encode(readFileSync(join(import.meta.dir, "../../public/icon.png")), "image/png");
// The browser-tab icon: the same drawing in orange with no tile, which reads on light and dark tab bars.
export const FAVICON = encode(readFileSync(join(import.meta.dir, "../../public/favicon.png")), "image/png");
// The service worker shows booking alerts, and makes the home-screen app open instantly and offline: admin pages are
// fetched from the network first (cached copy if offline or slower than 3s; only real admin shells are cached, never the
// sign-in page), fingerprinted /assets/ files come from the cache. Everything else, including the booking page and all
// API calls, goes straight to the network. Signing out empties the cache.
export const SW_JS = readFileSync(join(import.meta.dir, "sw.js"), "utf8");
const safeJson = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");
const fill = (html: string, vals: Record<string, string>) => html.replace(/__([A-Z]+)__/g, (m, k) => (k in vals ? vals[k] : m));
const HOST_HTML = Bun.escapeHTML(HOST_NAME);
const BOOK_TPL = template("book");
const ADMIN_TPL = template("admin");
// iPhone home-screen apps show a launch image while the page loads, white when there is none. These are plain images in
// the app's background colour, one per iPhone screen size, light and dark, drawn on first request.
const SPLASH_SIZES: [number, number, number][] = [
  [440, 956, 3],
  [430, 932, 3],
  [428, 926, 3],
  [420, 912, 3],
  [414, 896, 3],
  [414, 896, 2],
  [402, 874, 3],
  [393, 852, 3],
  [390, 844, 3],
  [375, 812, 3],
  [414, 736, 3],
  [375, 667, 2],
  [320, 568, 2],
];
const SPLASH_BG = { light: [0xf4, 0xf2, 0xec], dark: [0x16, 0x15, 0x13] } as const;
const SPLASH_LINKS = SPLASH_SIZES.flatMap(([w, h, r]) =>
  (["light", "dark"] as const).map(
    (s) =>
      `<link rel="apple-touch-startup-image" href="/splash/${w * r}x${h * r}-${s}.png" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait) and (prefers-color-scheme: ${s})">`,
  ),
).join("");
const splashCache = new Map<string, ReturnType<typeof encode>>();
function splashPng(width: number, height: number, [r, g, b]: readonly number[]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(Bun.hash.crc32(out.subarray(4, 8 + data.length)) >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function splash(name: string) {
  const m = name.match(/^(\d+)x(\d+)-(light|dark)\.png$/);
  if (!m || !SPLASH_SIZES.some(([w, h, r]) => w * r === +m[1] && h * r === +m[2])) return null;
  let body = splashCache.get(name);
  if (!body) splashCache.set(name, (body = encode(splashPng(+m[1], +m[2], SPLASH_BG[m[3] as "light" | "dark"]), "image/png")));
  return body;
}
// Changes with every deploy that changes a page. The admin app compares it with the live state and reloads itself when a
// phone kept the previous version open.
export const BUILD = Bun.hash(
  assetList()
    .map((a) => a.url)
    .join(",") +
    ADMIN_TPL +
    template("analytics"),
).toString(36);
const bookHtml = (manage: unknown, preload: string) =>
  fill(BOOK_TPL, {
    EVENT: Bun.escapeHTML(EVENT_NAME),
    HOST: HOST_HTML,
    PRELOAD: preload,
    BOOT: safeJson({ host: HOST_NAME, event: EVENT_NAME, manage, info: { loc: EVENT_LOCATION, desc: EVENT_DESCRIPTION } }),
  });
// The booking page asks for the 30-minute days list as soon as it starts; the preload starts that request with the HTML.
export const BOOK_HOME = shell(bookHtml(null, '<link rel="preload" href="/api/days?duration=30" as="fetch" crossorigin>'), CSP.page);
// Two versions of each admin page: an owner's, and one without the Enquiries, Payments and Analytics tabs for the admins
// owners add.
// The bottom bar's b3 class gives its three remaining buttons the full width.
const ADMIN_NOT_OWNER = ADMIN_TPL.replace(/<button (id="tab(?:Enq|Pay|Rev)"|type="button" data-go="(?:enq|pay)"|type="button" id="mRev")/g, "<button hidden $1").replace(
  '<nav class="bnav"',
  '<nav class="bnav b3"',
);
const adminPage = (tab: string, owner: boolean) =>
  shell(
    fill(owner ? ADMIN_TPL : ADMIN_NOT_OWNER, {
      HOST: HOST_HTML,
      SPLASH: SPLASH_LINKS,
      BOOT: safeJson({ tab, login: LOGIN_ON, build: BUILD, owner }),
    }),
    CSP.admin,
    false,
    true,
  );
const ADMIN_PAGES = {
  cal: [adminPage("cal", false), adminPage("cal", true)],
  allow: [adminPage("allow", false), adminPage("allow", true)],
};
export const adminShell = (tab: "cal" | "allow", owner: boolean) => ADMIN_PAGES[tab][owner ? 1 : 0];
export const ENQUIRY = shell(fill(template("enquiry"), { HOST: HOST_HTML }), CSP.page);
export const PAYMENT = shell(fill(template("payment"), { HOST: HOST_HTML, BOOT: safeJson({ max: RECEIPT_MAX }) }), CSP.page);
// the landing page is the one page search engines may list
export const HOME = { ...shell(fill(template("home"), { HOST: HOST_HTML }), CSP.page), index: true };
export const LOGIN = shell(fill(template("login"), { HOST: HOST_HTML, SPLASH: SPLASH_LINKS }), CSP.page);
export const ANALYTICS = shell(template("analytics"), CSP.frame, true, true);
// A manage link carries the candidate's booking, so that page is built per request and never cached.
export const bookPage = (req: Request, manage: unknown) =>
  sendShell(req, { body: encode(bookHtml(manage, ""), "text/html; charset=utf-8", true), csp: CSP.page }, "no-store");
