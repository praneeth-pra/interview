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
const FONT_CSS_PAGES = new Set(["book.css", "admin.css", "analytics.css", "login.css"]);

export type Encoded = { raw: Buffer; br?: Buffer; gz?: Buffer; etag: string; type: string };

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
  return new Response(req.method === "HEAD" ? null : data, { status, headers: h });
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
const fontCss = readFileSync(join(FONTS, "inter.css"), "utf8").replace(/url\(fonts\//g, "url(/assets/");
// Page scripts are readable sources (src/pages/<page>.js, or src/pages/<page>/main.ts split into modules);
// they are bundled and minified here, so what the browser gets is one small file per page.
async function bundle(entry: string) {
  const out = await Bun.build({ entrypoints: [entry], format: "iife", target: "browser", minify: true });
  if (!out.success) throw new AggregateError(out.logs, "could not build " + entry);
  return out.outputs[0].text();
}
for (const f of readdirSync(PAGES, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (f.isDirectory() && existsSync(join(PAGES, f.name, "main.ts"))) add(f.name + ".js", Buffer.from(await bundle(join(PAGES, f.name, "main.ts"))));
  else if (f.name.endsWith(".js")) add(f.name, Buffer.from(await bundle(join(PAGES, f.name))));
  else if (f.name.endsWith(".css")) {
    const css = readFileSync(join(PAGES, f.name), "utf8");
    add(f.name, Buffer.from(linkAssets(FONT_CSS_PAGES.has(f.name) ? fontCss + css : css)));
  }
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
export const assetList = () => [...byName.entries()].map(([name, a]) => ({ name, url: a.url, raw: a.body.raw.length, br: a.body.br?.length ?? a.body.raw.length }));

// API answers (JSON, CSV) are compressed on the way out when they are big enough to benefit.
export async function compressed(req: Request, res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "";
  const accept = req.headers.get("accept-encoding") ?? "";
  if (!/^(application\/json|text\/csv)/.test(type) || res.headers.has("content-encoding") || !res.body || !/\b(br|gzip)\b/.test(accept)) return res;
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
