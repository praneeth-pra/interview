import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";

// Everything under src/pages and src/fonts is fingerprinted, compressed and kept in memory at startup.
// Assets are served as /assets/<name>.<hash>.<ext> with a one-year immutable cache; the page shells
// are small and revalidate with an ETag, so a deploy is picked up on the next page load.
const ROOT = join(import.meta.dir, "..");
const PAGES = join(ROOT, "src/pages");
const FONTS = join(ROOT, "src/fonts");
const TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
  html: "text/html; charset=utf-8",
  json: "application/json",
};
// Every page uses Figtree, an open-source font close to the Calendly app's; the home page also uses Instrument Serif for
// headings. Each stylesheet starts with the @font-face rules of its fonts (names separated by spaces).
const FONT_OF_PAGE: Record<string, string> = {
  "book.css": "figtree.css",
  "admin.css": "figtree.css",
  "analytics.css": "figtree.css",
  "login.css": "figtree.css",
  "enquiry.css": "figtree.css",
  "home.css": "figtree.css serif.css",
};

type Encoded = { raw: Buffer; br?: Buffer; gz?: Buffer; etag: string; type: string };

export function encode(data: string | Buffer, type: string, fast = false): Encoded {
  const raw = typeof data === "string" ? Buffer.from(data) : data;
  const out: Encoded = { raw, type, etag: '"' + createHash("sha256").update(raw).digest("base64url").slice(0, 22) + '"' };
  if (raw.length > 1024 && /^text\/|json|javascript/.test(type)) {
    out.br = brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: fast ? 5 : 11, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } });
    out.gz = gzipSync(raw, { level: fast ? 6 : 9 });
  }
  return out;
}

export function respond(req: Request, body: Encoded, headers: Record<string, string>, status = 200): Response {
  const h: Record<string, string> = { ...headers, "Content-Type": body.type, ETag: body.etag, Vary: "Accept-Encoding" };
  if (status === 200 && req.headers.get("if-none-match") === body.etag) return new Response(null, { status: 304, headers: h });
  const accept = req.headers.get("accept-encoding") ?? "";
  let data = body.raw;
  if (body.br && /\bbr\b/.test(accept)) {
    data = body.br;
    h["Content-Encoding"] = "br";
  } else if (body.gz && /\bgzip\b/.test(accept)) {
    data = body.gz;
    h["Content-Encoding"] = "gzip";
  }
  return new Response(req.method === "HEAD" ? null : (data as Uint8Array<ArrayBuffer>), { status, headers: h });
}

const fingerprint = (name: string, data: Buffer) => {
  const dot = name.lastIndexOf(".");
  return "/assets/" + name.slice(0, dot) + "." + createHash("sha256").update(data).digest("hex").slice(0, 10) + name.slice(dot);
};

type Asset = { url: string; body: Encoded };
const byName = new Map<string, Asset>();
const byUrl = new Map<string, Asset>();
function add(name: string, data: Buffer) {
  const a = { url: fingerprint(name, data), body: encode(data, TYPES[name.split(".").pop()!]) };
  byName.set(name, a);
  byUrl.set(a.url, a);
}
const linkAssets = (text: string) => text.replace(/\/assets\/([\w-]+\.(?:css|js|woff2))\b/g, (m, n) => byName.get(n)?.url ?? m);

for (const f of readdirSync(FONTS)) if (f.endsWith(".woff2")) add(f, readFileSync(join(FONTS, f)));
const fontCss = (name: string) => (name ? readFileSync(join(FONTS, name), "utf8").replace(/url\(fonts\//g, "url(/assets/") : "");
// Page scripts are readable sources (src/pages/<page>.ts, or src/pages/<page>/main.ts split into modules);
// they are bundled and minified here, so what the browser gets is one small file per page.
async function bundle(entry: string) {
  const out = await Bun.build({ entrypoints: [entry], format: "iife", target: "browser", minify: true });
  if (!out.success) throw new AggregateError(out.logs, "could not build " + entry);
  return out.outputs[0].text();
}
// The admin, Contacts and sign-in pages have a light/dark switch (theme.js sets <html data-theme>). Their stylesheets keep
// writing dark styles as @media (prefers-color-scheme: dark); here each such block is scoped to "no light choice", and a
// copy without the colour-scheme condition is scoped to "dark chosen". :where() adds no specificity, so the cascade is
// the same as before.
const THEMED = new Set(["admin.css", "analytics.css", "login.css"]);
const AUTO = ':not([data-theme="light"])';
const DARK = '[data-theme="dark"]';
function blocks(css: string) {
  const out: { pre: string; body: string | null }[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css.startsWith("/*", i)) {
      i = css.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (css[i] !== "{") continue;
    let depth = 1;
    let j = i + 1;
    for (; depth; j++) {
      if (css.startsWith("/*", j)) j = css.indexOf("*/", j + 2) + 1;
      else if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    out.push({ pre: css.slice(start, i), body: css.slice(i + 1, j - 1) });
    start = i = j;
    i--;
  }
  out.push({ pre: css.slice(start), body: null });
  return out;
}
function scope(css: string, when: string): string {
  return blocks(css)
    .map(({ pre, body }) => {
      if (body === null) return pre;
      const sel = pre.trim();
      if (sel.startsWith("@keyframes")) return pre + "{" + body + "}";
      if (sel.startsWith("@")) return pre + "{" + scope(body, when) + "}";
      const scoped = sel
        .split(",")
        .map((part) => {
          const p = part.trim();
          const m = p.match(/^(:root|html)(.*)$/s);
          return m ? m[1] + ":where(" + when + ")" + m[2] : ":where(:root" + when + ") " + p;
        })
        .join(",\n");
      return pre.slice(0, pre.length - pre.trimStart().length) + scoped + " {" + body + "}";
    })
    .join("");
}
export function themed(css: string): string {
  const out = blocks(css)
    .map(({ pre, body }) => {
      if (body === null) return pre;
      const q = pre.trim();
      if (!/^@media\b.*\(prefers-color-scheme:\s*dark\)/.test(q)) return pre + "{" + body + "}";
      const rest = q
        .replace(/^@media\s*/, "")
        .replace(/\(prefers-color-scheme:\s*dark\)/, "")
        .replace(/^\s*and\s+|\s+and\s*$/g, "")
        .replace(/\s+and\s+and\s+/, " and ")
        .trim();
      const forced = scope(body, DARK);
      return pre + "{" + scope(body, AUTO) + "}\n" + (rest ? "@media " + rest + " {" + forced + "}" : forced);
    })
    .join("");
  return out + ':root[data-theme="light"] {\n  color-scheme: light;\n}\n:root[data-theme="dark"] {\n  color-scheme: dark;\n}\n';
}
function addCss(name: string, source: string) {
  const css = THEMED.has(name) ? themed(source) : source;
  const fonts = (FONT_OF_PAGE[name] ?? "").split(" ").filter(Boolean).map(fontCss).join("");
  add(name, Buffer.from(linkAssets(fonts + css)));
}
// A page's stylesheet is src/pages/<page>.css, or the files in src/pages/<page>/css/ joined in name order (01-…, 02-…),
// which keeps the cascade in that order.
const sorted = (dir: string) => readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
for (const f of sorted(PAGES)) {
  if (f.isDirectory()) {
    if (existsSync(join(PAGES, f.name, "main.ts"))) add(f.name + ".js", Buffer.from(await bundle(join(PAGES, f.name, "main.ts"))));
    const cssDir = join(PAGES, f.name, "css");
    if (existsSync(cssDir))
      addCss(
        f.name + ".css",
        sorted(cssDir)
          .filter((c) => c.name.endsWith(".css"))
          .map((c) => readFileSync(join(cssDir, c.name), "utf8"))
          .join(""),
      );
  } else if (/\.(js|ts)$/.test(f.name)) add(f.name.replace(/\.ts$/, ".js"), Buffer.from(await bundle(join(PAGES, f.name))));
  else if (f.name.endsWith(".css")) addCss(f.name, readFileSync(join(PAGES, f.name), "utf8"));
}

// A request for an older fingerprint (a tab opened before a deploy) gets the current file, without the long cache.
export function asset(path: string): { body: Encoded; current: boolean } | null {
  const a = byUrl.get(path);
  if (a) return { body: a.body, current: true };
  const m = path.match(/^\/assets\/([\w-]+)\.[0-9a-f]{10}\.(css|js|woff2)$/);
  const old = m && byName.get(m[1] + "." + m[2]);
  return old ? { body: old.body, current: false } : null;
}

export const template = (name: string) => linkAssets(readFileSync(join(PAGES, name + ".html"), "utf8"));
export const readData = (name: string) => readFileSync(join(ROOT, "data", name), "utf8");
export const assetList = () =>
  [...byName.entries()].map(([name, a]) => ({ name, url: a.url, raw: a.body.raw.length, br: a.body.br?.length ?? a.body.raw.length }));

// API answers (JSON, CSV) are compressed on the way out when they are big enough to benefit.
export async function compressed(req: Request, res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept-encoding") ?? "";
  if (!/^(application\/json|text\/csv)/.test(type) || res.headers.has("content-encoding") || !res.body || !/\b(br|gzip)\b/.test(accept))
    return res;
  const raw = Buffer.from(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  if (raw.length <= 1024) return new Response(raw, { status: res.status, headers });
  const br = /\bbr\b/.test(accept);
  headers.set("Content-Encoding", br ? "br" : "gzip");
  headers.append("Vary", "Accept-Encoding");
  headers.delete("content-length");
  const data = br ? brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(raw, { level: 6 });
  return new Response(data, { status: res.status, headers });
}
