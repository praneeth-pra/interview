import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

// Starts the real server twice (admin login off and on) against throwaway data folders.
const ROOT = join(import.meta.dir, "..");
const KEY = "cd".repeat(32);
const HOUR = 3600000;
// A future booking at 10:00 IST two days from now, well inside the booking window.
const istMidnight = () => {
  const now = new Date(Date.now() + 330 * 60000);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 330 * 60000;
};
const FUTURE = istMidnight() + 2 * 24 * HOUR + 10 * HOUR;
const booking = {
  id: "00000000-0000-0000-0000-000000000001", name: "Priya Sharma", email: "priya@example.com", company: "Google", round: "1st round",
  start: new Date(FUTURE).toISOString(), end: new Date(FUTURE + 30 * 60000).toISOString(), duration: 30,
  createdAt: new Date().toISOString(), cancelled: false, cancelledAt: "",
};
const manageToken = (id: string) => createHmac("sha256", KEY).update("manage:" + id).digest("hex").slice(0, 32);

type Srv = { url: string; dir: string; proc: ReturnType<typeof Bun.spawn> };
async function start(port: number, env: Record<string, string>, existing?: string): Promise<Srv> {
  const dir = existing ?? mkdtempSync(join(tmpdir(), "booking-form-"));
  if (!existing) seed(dir);
  const proc = Bun.spawn(["bun", "run", join(ROOT, "src/server.ts")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, RESEND_API_KEY: "", BACKUP_HOUR: "23", ADMIN_OPEN: "1", ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
  const url = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + "/healthz")).ok) return { url, dir, proc };
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
}
function seed(dir: string) {
  writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
  const many = Array.from({ length: 60 }, (_, i) => ({ ...booking, id: "10000000-0000-0000-0000-" + String(i).padStart(12, "0"), cancelled: true, start: new Date(FUTURE - (i + 1) * 24 * HOUR).toISOString() }));
  writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [booking, ...many] }));
}

// Sign-in codes go out by email; a stand-in for the email API keeps them so the tests can read them.
const OWNER = "owner@example.com";
const mails: any[] = [];
const mailServer = Bun.serve({ port: 4315, fetch: async (req) => (mails.push(await req.json()), Response.json({ id: "x" })) });
const lockedEnv = { ADMIN_EMAILS: OWNER + ", boss@example.com chief@example.com", RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4315/emails" };
const postJson = (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.url + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const lastCode = (email: string) => {
  const mail = mails.filter((m) => m.to[0] === email).at(-1);
  return mail ? mail.subject.match(/(\d{6})$/)[1] : "";
};
// Asks for a code, reads it from the email and signs in; returns the session cookie.
async function signIn(s: Srv, email: string) {
  expect((await postJson(s, "/admin/login/code", { email })).status).toBe(200);
  const r = await postJson(s, "/admin/login", { email, code: lastCode(email) });
  expect(r.status).toBe(200);
  return r.headers.get("set-cookie")!.split(";")[0];
}

let open: Srv;
let locked: Srv;
let ownerCookie = "";
beforeAll(async () => {
  [open, locked] = await Promise.all([start(4311, { HOST_NAME: "Hi<Techie>" }), start(4312, lockedEnv)]);
});
afterAll(() => {
  open?.proc.kill();
  locked?.proc.kill();
  mailServer.stop(true);
});

const get = (s: Srv, path: string, headers: Record<string, string> = {}) => fetch(s.url + path, { headers, decompress: false } as RequestInit);
const assetsIn = (html: string) => [...html.matchAll(/(?:href|src)="(\/assets\/[^"]+)"/g)].map((m) => m[1]);
const boot = (html: string) => JSON.parse(html.match(/<script type="application\/json" id="boot">(.*?)<\/script>/)![1]);

describe("page sources", () => {
  test("no inline scripts or styles, so the nonce-free policy can't block anything", () => {
    for (const f of readdirSync(join(ROOT, "src/pages")).filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(join(ROOT, "src/pages", f), "utf8");
      expect(html).not.toContain("__NONCE__");
      expect(html).not.toMatch(/<style/);
      expect(html).not.toMatch(/ style="/);
      for (const m of html.matchAll(/<script([^>]*)>/g)) expect(m[1]).toMatch(/src="|type="application\/json"/);
      expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});

describe("booking page", () => {
  test("the home page links to booking and the enquiry page", async () => {
    const html = await (await get(open, "/")).text();
    expect(html).toContain('href="/booking"');
    expect(html).toContain('href="/enquiry"');
    for (const text of ["Land the job you", "Resume rewrite", "Interview proxy", "Get offer", "Big data engineering"]) expect(html).toContain(text);
    const css = html.match(/href="(\/assets\/home\.[^"]+\.css)"/)?.[1];
    expect(css).toBeTruthy();
    const style = await (await get(open, css!)).text();
    expect(style).toContain("Instrument Serif");
    expect(style).toContain("Figtree");
    const r = await fetch(open.url + "/booking/", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/booking");
  });

  test("search engines may list the landing page, and only the landing page", async () => {
    const home = await get(open, "/", { "x-forwarded-host": "www.hi-techie.dev" });
    expect(home.headers.get("x-robots-tag")).toBeNull();
    expect(home.headers.get("link")).toBe('<https://hi-techie.dev/>; rel="canonical"');
    for (const path of ["/booking", "/enquiry", "/payment", "/admin", "/api/companies"]) expect((await get(open, path)).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const robots = await (await get(open, "/robots.txt", { "x-forwarded-host": "hi-techie.dev" })).text();
    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain("Disallow: /b/");
    expect(robots).toContain("Sitemap: https://hi-techie.dev/sitemap.xml");
    const sitemap = await get(open, "/sitemap.xml", { "x-forwarded-host": "www.hi-techie.dev" });
    expect(sitemap.headers.get("content-type")).toContain("application/xml");
    expect(await sitemap.text()).toContain("<loc>https://hi-techie.dev/</loc>");
  });

  test("serves the shell with fingerprinted assets, a strict policy and revalidation", async () => {
    const r = await get(open, "/booking");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(r.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(assetsIn(html)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/assets\/book\.[0-9a-f]{10}\.css$/), expect.stringMatching(/^\/assets\/book\.[0-9a-f]{10}\.js$/)]));
    expect(html).toContain('<link rel="preload" href="/api/days?duration=30" as="fetch" crossorigin>');
    const again = await get(open, "/booking", { "if-none-match": r.headers.get("etag")! });
    expect(again.status).toBe(304);
  });

  test("escapes the host name in the title and in the boot data", async () => {
    const html = await (await get(open, "/booking")).text();
    expect(html).toContain("<title>Interview · Hi&lt;Techie&gt;</title>");
    expect(html).not.toContain("Hi<Techie>");
    expect(boot(html)).toEqual({ host: "Hi<Techie>", event: "Interview", manage: null, info: expect.objectContaining({ loc: expect.any(String) }) });
  });

  test("compresses with brotli or gzip when the browser accepts it", async () => {
    const br = await get(open, "/admin", { "accept-encoding": "gzip, deflate, br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toContain("<!doctype html>");
    const gz = await get(open, "/admin", { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString()).toContain("<!doctype html>");
  });

  test("every asset a page references is served with a one-year immutable cache", async () => {
    const pages = await Promise.all(["/", "/booking", "/enquiry", "/payment", "/admin", "/admin/analytics"].map(async (p) => (await get(open, p)).text()));
    const css = await Promise.all(pages.flatMap(assetsIn).filter((u) => u.endsWith(".css")).map(async (u) => (await get(open, u)).text()));
    const fonts = css.flatMap((c) => [...c.matchAll(/url\((\/assets\/[^)]+)\)/g)].map((m) => m[1]));
    expect(fonts.length).toBeGreaterThan(0);
    for (const u of new Set([...pages.flatMap(assetsIn), ...fonts])) {
      const r = await get(open, u);
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(r.headers.get("content-type")).toMatch(/text\/css|text\/javascript|font\/woff2/);
    }
  });

  test("an older fingerprint still gets the current file, but without the long cache", async () => {
    const js = assetsIn(await (await get(open, "/booking")).text()).find((u) => u.endsWith(".js"))!;
    const r = await get(open, js.replace(/\.[0-9a-f]{10}\.js$/, ".0000000000.js"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-cache");
    expect((await get(open, "/assets/nothing.0000000000.js")).status).toBe(404);
  });

  test("a manage link carries the booking and is never cached", async () => {
    const r = await get(open, `/b/${booking.id}?t=${manageToken(booking.id)}`);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(boot(html).manage).toMatchObject({ id: booking.id, name: "Priya Sharma", start: booking.start, cancelled: false, past: false });
    expect(html).not.toContain("/api/days?duration=30");
    const bad = boot(await (await get(open, `/b/${booking.id}?t=${"0".repeat(32)}`)).text());
    expect(bad.manage.error).toContain("isn't valid");
  });
});

describe("booking flow", () => {
  test("days, slots, book, reschedule and cancel", async () => {
    const days = await (await get(open, "/api/days?duration=30")).json();
    expect(days.days.length).toBe(7);
    const day = days.days.find((d: any) => d.open && d.key > days.days[0].key);
    const slots = (await (await get(open, `/api/slots?date=${day.key}&duration=30`)).json()).slots;
    expect(slots.length).toBeGreaterThan(1);
    expect(slots).not.toContain(FUTURE);
    expect(day.slots).toEqual(slots);
    const post = (path: string, body: unknown) => fetch(open.url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const made = await (await post("/api/book", { name: "Test Person", email: "test@example.com", company: "Acme", round: "HR", duration: 30, startMs: slots[0] })).json();
    expect(made.booking.manage).toMatch(/\/b\/[0-9a-f-]{36}\?t=[0-9a-f]{32}$/);
    const noCompany = await post("/api/book", { name: "Other", email: "o@example.com", company: "  ", duration: 30, startMs: slots[2] });
    expect(noCompany.status).toBe(400);
    expect((await noCompany.json()).field).toBe("company");
    const clash = await post("/api/book", { name: "Other", email: "o@example.com", company: "Beta", duration: 30, startMs: slots[0] });
    expect(clash.status).toBe(409);
    const t = made.booking.manage.split("t=")[1];
    const moved = await (await post("/api/manage/reschedule", { id: made.booking.id, t, startMs: slots[1], duration: 30 })).json();
    expect(moved.booking.start).toBe(new Date(slots[1]).toISOString());
    expect((await post("/api/manage/cancel", { id: made.booking.id, t, reason: "test" })).status).toBe(200);
    const state = await (await get(open, "/admin/api/state")).json();
    expect(state.events.find((e: any) => e.id === made.booking.id)).toBeUndefined();
    expect(state.changes[0]).toMatchObject({ id: made.booking.id, kind: "cancelled" });
  });

  test("company suggestions come from data/companies.json", async () => {
    const { companies } = await (await get(open, "/api/companies")).json();
    expect(companies.find((c: any) => c.n === "Google")).toMatchObject({ a: ["Alphabet"] });
  });

  test("a candidate's later rounds keep the company spelling they used before", async () => {
    const days = await (await get(open, "/api/days?duration=30")).json();
    const open2 = days.days.filter((d: any) => d.open).slice(-2);
    const slots = (await (await get(open, `/api/slots?date=${open2[open2.length - 1].key}&duration=30`)).json()).slots;
    const post = (body: unknown) => fetch(open.url + "/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const book = async (email: string, company: string, i: number) =>
      (await (await post({ name: "Round Test", email, company, round: "1st round", duration: 30, startMs: slots[i] })).json()).booking;
    expect((await book("rounds@example.com", "Infosys", 0)).company).toBe("Infosys");
    expect((await book("ROUNDS@example.com", "infosis", 1)).company).toBe("Infosys"); // near-spelling, same email
    expect((await book("rounds@example.com", "Wipro", 2)).company).toBe("Wipro"); // a different company stays
    expect((await book("someone-else@example.com", "infosis", 3)).company).toBe("infosis"); // only the same email
    expect((await book("tcs@example.com", "Tata Consultancy Services", 4)).company).toBe("Tata Consultancy Services");
    expect((await book("tcs@example.com", "TCS", 5)).company).toBe("Tata Consultancy Services"); // known alias
    expect((await book("typo@example.com", "Infosis", 6)).company).toBe("Infosis");
    expect((await book("typo@example.com", "Infosys", 7)).company).toBe("Infosys"); // a known name is never replaced by a typo
  });

  test("large API answers are compressed", async () => {
    const r = await get(open, "/admin/api/bookings", { "accept-encoding": "gzip" });
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString()).bookings.length).toBeGreaterThan(50);
  });
});

describe("enquiries", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\n% a tiny resume\n");
  const form = (fields: Record<string, string>, file?: { bytes: Uint8Array; name: string }) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    if (file) f.set("resume", new File([file.bytes], file.name));
    return f;
  };
  const good = { name: "Asha Rao", email: "Asha@Example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years" };
  const send = (f: FormData) => fetch(open.url + "/api/enquiry", { method: "POST", body: f });

  test("the page is served and its old spellings redirect to it", async () => {
    const page = await get(open, "/enquiry");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="cv"');
    expect(html).toContain("<title>Enquiry · Hi&lt;Techie&gt;</title>");
    const r = await fetch(open.url + "/inquiry", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/enquiry");
  });

  test("enquiries are checked, stored with the resume, listed for admins, downloadable and deletable", async () => {
    // a bot filling the hidden field is thanked and dropped
    expect((await send(form({ ...good, website: "spam.example" }, { bytes: PDF, name: "cv.pdf" }))).status).toBe(200);
    expect((await send(form({ ...good, name: "" }, { bytes: PDF, name: "cv.pdf" }))).status).toBe(400);
    const notPdf = await send(form(good, { bytes: new TextEncoder().encode("hello"), name: "cv.pdf" }));
    expect(notPdf.status).toBe(400);
    expect((await notPdf.json()).error).toContain("PDF or Word");
    const big = new Uint8Array(200 * 1024 + 1);
    big.set(PDF);
    const tooBig = await send(form(good, { bytes: big, name: "big.pdf" }));
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("Your resume is larger than 200 KB. Please upload a smaller file.");
    const ok = await send(form(good, { bytes: PDF, name: "Asha Rao résumé.pdf" }));
    expect(ok.status).toBe(200);
    const { enquiries } = await (await get(open, "/admin/api/enquiries")).json();
    expect(enquiries.length).toBe(1);
    const e = enquiries[0];
    expect(e).toMatchObject({ name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years" });
    expect(e.resume).toEqual({ name: "Asha Rao résumé.pdf", size: PDF.length });
    const file = await get(open, "/admin/api/enquiries/" + e.id + "/resume");
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toContain("filename*=UTF-8''Asha%20Rao%20r%C3%A9sum%C3%A9.pdf");
    expect(file.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
    // the download icon saves it under the candidate's name
    const saved = await get(open, "/admin/api/enquiries/" + e.id + "/resume?download=1");
    expect(saved.headers.get("content-disposition")).toBe("attachment; filename=\"Asha Rao resume.pdf\"; filename*=UTF-8''Asha%20Rao%20resume.pdf");
    expect(new Uint8Array(await saved.arrayBuffer())).toEqual(PDF);
    expect(existsSync(join(open.dir, "resumes", e.id + ".pdf"))).toBe(true);
    expect((await postJson(open, "/admin/api/enquiries/delete", { id: e.id })).status).toBe(200);
    expect((await (await get(open, "/admin/api/enquiries")).json()).enquiries).toEqual([]);
    expect(existsSync(join(open.dir, "resumes", e.id + ".pdf"))).toBe(false);
    // behind sign-in when it is on
    expect((await get(locked, "/admin/api/enquiries")).status).toBe(401);
  });

  test("the live state lists when enquiries came in, and opening Enquiries marks them seen", async () => {
    const PDF2 = new TextEncoder().encode("%PDF-1.7\n");
    // from another address: the earlier test used up this one's five an hour
    const sent = await fetch(open.url + "/api/enquiry", { method: "POST", body: form({ ...good, name: "Ravi Teja" }, { bytes: PDF2, name: "ravi.pdf" }), headers: { "x-real-ip": "10.0.0.2" } });
    expect(sent.status).toBe(200);
    const state = await (await get(open, "/admin/api/state")).json();
    expect(state.enquiries.length).toBe(1);
    const before = await (await get(open, "/admin/api/enquiries/seen")).json();
    expect(before.seenAt === "" || Date.parse(before.seenAt) < Date.parse(state.enquiries[0])).toBe(true);
    const after = await (await postJson(open, "/admin/api/enquiries/seen", {})).json();
    expect(Date.parse(after.seenAt)).toBeGreaterThanOrEqual(Date.parse(state.enquiries[0]));
    expect((await (await get(open, "/admin/api/enquiries/seen")).json()).seenAt).toBe(after.seenAt);
  });
});

describe("payments", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const PDF = new TextEncoder().encode("%PDF-1.4\n% a receipt\n");
  const form = (fields: Record<string, string>, file?: { bytes: Uint8Array; name: string }) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    if (file) f.set("receipt", new File([file.bytes], file.name));
    return f;
  };
  const good = { email: "Kiran@Example.com", name: "Kiran Kumar", installment: "advance", amount: "12,500" };
  const send = (f: FormData, ip = "10.1.0.1") => fetch(open.url + "/api/payment", { method: "POST", body: f, headers: { "x-real-ip": ip } });

  test("the page is served, kept out of search engines, and /pay redirects to it", async () => {
    const page = await get(open, "/payment");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain('id="rc"');
    expect(html).toContain('"max":1048576');
    expect(html).toContain("<title>Payment · Hi&lt;Techie&gt;</title>");
    const r = await fetch(open.url + "/pay", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/payment");
  });

  test("payments are checked, stored with the receipt, listed newest first for admins, and confirmed or discarded once", async () => {
    expect((await send(form({ ...good, website: "spam.example" }, { bytes: PNG, name: "r.png" }))).status).toBe(200);
    expect((await send(form({ ...good, amount: "abc" }, { bytes: PNG, name: "r.png" }))).status).toBe(400);
    expect((await send(form({ ...good, amount: "0" }, { bytes: PNG, name: "r.png" }))).status).toBe(400);
    // which installment it is: one of the four, and required
    for (const installment of ["", "4", "toString"]) {
      const r = await send(form({ ...good, installment }, { bytes: PNG, name: "r.png" }), "10.1.0.3");
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "Choose which installment this is.", field: "installment" });
    }
    const notImage = await send(form(good, { bytes: new TextEncoder().encode("<svg></svg>"), name: "r.svg" }));
    expect(notImage.status).toBe(400);
    expect((await notImage.json()).error).toContain("image or a PDF");
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(PNG);
    const tooBig = await send(form(good, { bytes: big, name: "big.png" }), "10.1.0.2");
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("Your receipt is larger than 1 MB. Please upload a smaller file.");
    expect((await send(form(good, { bytes: PNG, name: "gpay.png" }), "10.1.0.2")).status).toBe(200);
    expect((await send(form({ ...good, name: "Meena Iyer", installment: "2", amount: "999.50" }, { bytes: PDF, name: "bank.pdf" }), "10.1.0.2")).status).toBe(200);
    const { payments } = await (await get(open, "/admin/api/payments")).json();
    expect(payments.map((p: any) => p.name)).toEqual(["Meena Iyer", "Kiran Kumar"]);
    expect(payments[1]).toMatchObject({ email: "kiran@example.com", amount: 12500, receipt: { name: "gpay.png", type: "image/png", size: PNG.length } });
    expect(payments[0].amount).toBe(999.5);
    expect(payments.map((p: any) => p.installment)).toEqual(["2", "advance"]);
    const file = await get(open, "/admin/api/payments/" + payments[1].id + "/receipt");
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    const saved = await get(open, "/admin/api/payments/" + payments[0].id + "/receipt?download=1");
    expect(saved.headers.get("content-disposition")).toBe("attachment; filename=\"Meena Iyer receipt.pdf\"; filename*=UTF-8''Meena%20Iyer%20receipt.pdf");
    expect(existsSync(join(open.dir, "receipts", payments[0].id + ".pdf"))).toBe(true);
    expect(payments[0].decision).toBe("");
    expect(await (await get(open, "/admin/api/state")).json()).toMatchObject({ payments: 2, paymentsPending: 2 });
    // no deleting: each payment is confirmed or discarded once, and that's final
    expect((await postJson(open, "/admin/api/payments/delete", { id: payments[0].id })).status).toBe(404);
    expect((await postJson(open, "/admin/api/payments/decide", { id: payments[0].id, decision: "maybe" })).status).toBe(400);
    expect((await postJson(open, "/admin/api/payments/decide", { id: "nope", decision: "confirm" })).status).toBe(404);
    const confirmed = await postJson(open, "/admin/api/payments/decide", { id: payments[1].id, decision: "confirm" });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).payment).toMatchObject({ id: payments[1].id, decision: "confirmed" });
    const again = await postJson(open, "/admin/api/payments/decide", { id: payments[1].id, decision: "discard" });
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This payment was already confirmed. It can't be changed.");
    expect((await postJson(open, "/admin/api/payments/decide", { id: payments[0].id, decision: "discard" })).status).toBe(200);
    expect((await postJson(open, "/admin/api/payments/decide", { id: payments[0].id, decision: "confirm" })).status).toBe(409);
    const after = (await (await get(open, "/admin/api/payments")).json()).payments;
    expect(after.map((p: any) => p.decision)).toEqual(["discarded", "confirmed"]);
    expect(after[1].decidedAt).toBeTruthy();
    expect((await (await get(open, "/admin/api/state")).json()).paymentsPending).toBe(0);
    // a discarded payment keeps its receipt
    expect(existsSync(join(open.dir, "receipts", payments[0].id + ".pdf"))).toBe(true);
    // admin-only, like resumes
    expect((await get(locked, "/admin/api/payments")).status).toBe(401);
    expect((await get(locked, "/admin/api/payments/" + payments[1].id + "/receipt")).status).toBe(401);
  });

  test("Revenue counts confirmed payments, keeps pending ones apart, suggests candidates, narrows to a search, and exports CSV", async () => {
    expect((await send(form({ ...good, installment: "1", amount: "5000" }, { bytes: PNG, name: "r.png" }), "10.1.0.4")).status).toBe(200);
    const v = await (await get(open, "/admin/api/revenue")).json();
    expect(v.months).toHaveLength(12);
    // Kiran's advance was confirmed; Meena's payment was discarded and doesn't count anywhere
    expect(v.revenue).toMatchObject({ total: 12500, count: 1, pending: 5000, pendingCount: 1, payers: 1 });
    expect(v.revenue.byMonth.at(-1)).toBe(12500);
    expect(v.revenue.before).toBe(0);
    expect(v.found).toEqual([]);
    // the suggestions: everyone with a payment that wasn't discarded, with what they've paid (confirmed only)
    expect(v.candidates).toEqual([{ name: "Kiran Kumar", email: "kiran@example.com", total: 12500 }]);
    expect(v).not.toHaveProperty("bookings");
    const csv = await get(open, "/admin/api/revenue.csv");
    expect(csv.headers.get("content-disposition")).toStartWith('attachment; filename="payments-');
    const lines = (await csv.text()).trim().split("\r\n");
    expect(lines[0]).toBe("Date,Month,Name,Email,Installment,Amount (INR),Status,Confirmed on");
    expect(lines.slice(1).map((l) => l.split(",").slice(2, 7).join(","))).toEqual([
      "Kiran Kumar,kiran@example.com,Advance,12500,Confirmed",
      "Kiran Kumar,kiran@example.com,1st installment,5000,Pending",
    ]);
    // the search narrows everything to candidates whose name or email contains it, and says whom it found
    const kiran = await (await get(open, "/admin/api/revenue?q=KIRAN@")).json();
    expect(kiran.found).toEqual([{ name: "Kiran Kumar", email: "kiran@example.com" }]);
    expect(kiran.revenue).toMatchObject({ total: 12500, pending: 5000, payers: 1 });
    const nobody = await (await get(open, "/admin/api/revenue?q=zzz")).json();
    expect(nobody.found).toEqual([]);
    expect(nobody.revenue).toMatchObject({ total: 0, pending: 0, payers: 0 });
    expect(nobody.candidates).toHaveLength(1);
    expect((await (await get(open, "/admin/api/revenue.csv?q=meena")).text()).trim().split("\r\n")).toHaveLength(1);
    expect((await get(locked, "/admin/api/revenue")).status).toBe(401);
    expect((await get(locked, "/admin/api/revenue.csv")).status).toBe(401);
  });
});

describe("payments: the amount on the receipt", () => {
  const receipt = (name: string) => Bun.file(join(ROOT, "tests", "receipts", name));
  const send = async (amount: string, file: string, ip: string) => {
    const d = new FormData();
    d.set("email", "asha@example.com");
    d.set("name", "Asha Rao");
    d.set("installment", "1");
    d.set("amount", amount);
    d.set("receipt", new File([await receipt(file).arrayBuffer()], file));
    return fetch(open.url + "/api/payment", { method: "POST", body: d, headers: { "x-real-ip": ip } });
  };
  test.skipIf(!Bun.which("tesseract"))("a screenshot showing another amount is refused; the right amount is saved as verified", async () => {
    const wrong = await send("6000", "gpay-5000.jpg", "10.1.8.1");
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({ error: "The receipt shows \u20B95,000, not \u20B96,000. Enter the amount on your receipt.", field: "amount" });
    expect((await send("5,000", "gpay-5000.jpg", "10.1.8.1")).status).toBe(200);
    const { payments } = await (await get(open, "/admin/api/payments")).json();
    expect(payments.find((p: any) => p.email === "asha@example.com").check).toBe("verified");
  });
  test("a receipt with no readable amount is saved as needing a check", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const d = new FormData();
    d.set("email", "ravi@example.com");
    d.set("name", "Ravi Teja");
    d.set("installment", "3");
    d.set("amount", "700");
    d.set("receipt", new File([PNG], "blurry.png"));
    expect((await fetch(open.url + "/api/payment", { method: "POST", body: d, headers: { "x-real-ip": "10.1.8.2" } })).status).toBe(200);
    const { payments } = await (await get(open, "/admin/api/payments")).json();
    expect(payments.find((p: any) => p.email === "ravi@example.com").check).toBe("unread");
  });
});

describe("payments and the invite list", () => {
  test("when the Candidates list is on, only its emails can send a payment, as with booking", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const f = (email: string) => {
      const d = new FormData();
      d.set("email", email);
      d.set("name", "Someone Else");
      d.set("installment", "advance");
      d.set("amount", "500");
      d.set("receipt", new File([PNG], "r.png"));
      return d;
    };
    const send = (email: string) => fetch(open.url + "/api/payment", { method: "POST", body: f(email), headers: { "x-real-ip": "10.1.9.1" } });
    expect((await postJson(open, "/admin/api/allowlist", { action: "add", text: "listed@example.com" })).status).toBe(200);
    expect((await postJson(open, "/admin/api/allowlist", { action: "enable", on: true })).status).toBe(200);
    try {
      const refused = await send("stranger@example.com");
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "This email isn't on the invite list. Use the email address your invitation was sent to.", field: "email" });
      expect((await send("Listed@Example.com")).status).toBe(200);
    } finally {
      await postJson(open, "/admin/api/allowlist", { action: "enable", on: false });
    }
  });
});

describe("admin", () => {
  test("without a session /admin shows the sign-in page and the APIs refuse", async () => {
    const html = await (await get(locked, "/admin")).text();
    expect(html).toContain('id="em"');
    expect((await get(locked, "/admin/api/state")).status).toBe(401);
  });

  test("signing in gives the admin page, and analytics loads as a same-origin frame", async () => {
    expect((await postJson(locked, "/admin/login/code", { email: OWNER })).status).toBe(200);
    const code = lastCode(OWNER);
    expect(code).toMatch(/^\d{6}$/);
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await postJson(locked, "/admin/login", { email: OWNER, code: wrong });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error).toContain("isn't right");
    const ok = await postJson(locked, "/admin/login", { email: " Owner@Example.com ", code });
    expect(ok.headers.get("set-cookie")).toMatch(/^bf_admin=[a-f0-9]{64}; Path=\/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+$/);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    ownerCookie = cookie;
    // a code works once
    expect((await postJson(locked, "/admin/login", { email: OWNER, code })).status).toBe(401);
    const admin = await get(locked, "/admin", { cookie });
    const html = await admin.text();
    expect(boot(html)).toEqual({ tab: "cal", login: true, build: expect.stringMatching(/^[0-9a-z]+$/), owner: true });
    const state = await (await get(locked, "/admin/api/state", { cookie })).json();
    expect(state.build).toBe(boot(html).build);
    expect(admin.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(boot(await (await get(locked, "/admin/allowlist", { cookie })).text()).tab).toBe("allow");
    const la = await get(locked, "/admin/analytics", { cookie });
    expect(await la.text()).toContain("<title>Contacts</title>");
    expect(la.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(la.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const out = await get(locked, "/admin/analytics");
    expect(await out.text()).toContain('id="em"');
    expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    // only real admin pages may be kept for offline use; the sign-in page never is
    expect(admin.headers.get("x-app-shell")).toBe("1");
    expect(la.headers.get("x-app-shell")).toBe("1");
    expect(out.headers.get("x-app-shell")).toBeNull();
    expect((await get(locked, "/admin")).headers.get("x-app-shell")).toBeNull();
  });

  test("codes are emailed only to admins, with the same answer for anyone else", async () => {
    const before = mails.length;
    const r = await postJson(locked, "/admin/login/code", { email: "stranger@example.com" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, minutes: 10 });
    await Bun.sleep(100);
    expect(mails.length).toBe(before);
    // asking again straight away is refused for anyone, so the answer never tells who is an admin
    expect((await postJson(locked, "/admin/login/code", { email: "stranger@example.com" })).status).toBe(429);
    expect((await postJson(locked, "/admin/login/code", { email: "not an email" })).status).toBe(400);
    // the email's subject carries the code, for the phone's notification
    await postJson(locked, "/admin/login/code", { email: "boss@example.com" });
    const mail = mails.at(-1);
    expect(mail.to).toEqual(["boss@example.com"]);
    expect(mail.subject).toMatch(/^Sign-in code: \d{6}$/);
    expect(mail.text).toContain(lastCode("boss@example.com"));
  });

  test("five wrong codes end the code", async () => {
    const email = "boss@example.com";
    const code = lastCode(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await postJson(locked, "/admin/login", { email, code: wrong })).status).toBe(401);
    // even the right code no longer works
    expect((await postJson(locked, "/admin/login", { email, code })).status).toBe(401);
  });

  test("owners add and remove admins; a removed admin is signed out everywhere", async () => {
    const cookie = ownerCookie;
    const owners = ["boss@example.com", "chief@example.com", OWNER];
    const list = await (await get(locked, "/admin/api/admins", { cookie })).json();
    expect(list).toEqual({ owners, emails: [], me: OWNER });
    const added = await postJson(locked, "/admin/api/admins", { emails: ["Helper@Example.com", OWNER] }, { cookie });
    expect(await added.json()).toEqual({ owners, emails: ["helper@example.com"], me: OWNER });
    const helper = await signIn(locked, "helper@example.com");
    expect((await get(locked, "/admin/api/state", { cookie: helper })).status).toBe(200);
    // the volume keeps only a hash of the cookie
    const stored = readFileSync(join(locked.dir, "sessions.json"), "utf8");
    expect(stored).toContain("helper@example.com");
    expect(stored).not.toContain(helper.split("=")[1]);
    // a helper can't change the list at all, themselves included
    const self = await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie: helper });
    expect(self.status).toBe(403);
    expect((await postJson(locked, "/admin/api/admins", { emails: ["bad"] }, { cookie })).status).toBe(400);
    // their live updates stop too
    const live = await get(locked, "/admin/stream", { cookie: helper });
    const reader = live.body!.getReader();
    await reader.read();
    expect((await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie })).status).toBe(200);
    for (let r = await reader.read(); !r.done; r = await reader.read());
    expect((await get(locked, "/admin/api/state", { cookie: helper })).status).toBe(401);
    expect((await get(locked, "/admin/api/state", { cookie })).status).toBe(200);
  });

  test("only owners see enquiries, payments and revenue; the admins they add get neither the tabs nor the data", async () => {
    const cookie = ownerCookie;
    expect((await postJson(locked, "/admin/api/admins", { emails: ["aide@example.com"] }, { cookie })).status).toBe(200);
    const aide = await signIn(locked, "aide@example.com");
    const id = "00000000-0000-0000-0000-00000000abcd";
    // every enquiry and payment API refuses them, before looking anything up
    const gets = ["/admin/api/revenue", "/admin/api/revenue.csv", "/admin/api/enquiries", "/admin/api/enquiries/seen", "/admin/api/enquiries/" + id + "/resume", "/admin/api/payments", "/admin/api/payments/" + id + "/receipt?download=1"];
    for (const path of gets) {
      const r = await get(locked, path, { cookie: aide });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toContain("Only the owner");
    }
    for (const path of ["/admin/api/enquiries/seen", "/admin/api/enquiries/delete", "/admin/api/payments/decide"])
      expect((await postJson(locked, path, { id }, { cookie: aide })).status).toBe(403);
    // the owner still gets them (the made-up id isn't there, so its file is a 404, not a 403)
    for (const path of ["/admin/api/enquiries", "/admin/api/enquiries/seen", "/admin/api/payments", "/admin/api/revenue", "/admin/api/revenue.csv"])
      expect((await get(locked, path, { cookie })).status).toBe(200);
    expect((await get(locked, "/admin/api/enquiries/" + id + "/resume", { cookie })).status).toBe(404);
    expect((await get(locked, "/admin/api/payments/" + id + "/receipt", { cookie })).status).toBe(404);
    // the page has no Enquiries or Payments tabs for them, in the header or the phone's bottom bar
    const page = await (await get(locked, "/admin", { cookie: aide })).text();
    expect(boot(page).owner).toBe(false);
    expect(page).toContain('<button hidden id="tabEnq"');
    expect(page).toContain('<button hidden id="tabPay"');
    expect(page).toContain('<button hidden id="tabRev"');
    expect(page).toContain('<button hidden type="button" id="mRev"');
    expect(page).toContain('<button hidden type="button" data-go="enq"');
    expect(page).toContain('<button hidden type="button" data-go="pay"');
    expect(page).toContain('<nav class="bnav b3"');
    expect(boot(await (await get(locked, "/admin/allowlist", { cookie: aide })).text()).owner).toBe(false);
    const ownerPage = await (await get(locked, "/admin", { cookie })).text();
    expect(ownerPage).not.toContain("<button hidden");
    expect(ownerPage).toContain('<nav class="bnav"');
    // the live state leaves out when enquiries came in and how many payments there are
    const mine = await (await get(locked, "/admin/api/state", { cookie: aide })).json();
    expect(mine.owner).toBe(false);
    expect(mine.enquiries).toBeUndefined();
    expect(mine.payments).toBeUndefined();
    const theirs = await (await get(locked, "/admin/api/state", { cookie })).json();
    expect(theirs.owner).toBe(true);
    expect(Array.isArray(theirs.enquiries)).toBe(true);
    expect(typeof theirs.payments).toBe("number");
    const live = await get(locked, "/admin/stream", { cookie: aide });
    const reader = live.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"owner":false');
    expect(first).not.toContain('"enquiries"');
    expect(first).not.toContain('"payments"');
    await reader.cancel();
    // the backup they can download has no enquiries or payments; the owner's has both
    const backup = await (await get(locked, "/admin/backup.json", { cookie: aide })).json();
    expect(Object.keys(backup.files)).not.toContain("enquiries.json");
    expect(Object.keys(backup.files)).not.toContain("payments.json");
    expect(Object.keys(backup.files)).toContain("bookings.json");
    const full = await (await get(locked, "/admin/backup.json", { cookie })).json();
    expect(Object.keys(full.files)).toEqual(expect.arrayContaining(["enquiries.json", "payments.json"]));
    // a device's alerts are recorded for the admin who turned them on, so enquiry and payment alerts go only to owners'
    const endpoint = "https://fcm.googleapis.com/fcm/send/aide-device";
    const sub = { endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) }, label: "Test" };
    const view = await (await postJson(locked, "/admin/api/push/subscribe", sub, { cookie: aide })).json();
    expect(view.endpoints).toContain(endpoint);
    expect(view.yours).toEqual([endpoint]);
    expect((await (await get(locked, "/admin/api/push", { cookie })).json()).yours).not.toContain(endpoint);
    expect(JSON.parse(readFileSync(join(locked.dir, "push.json"), "utf8")).subs.find((x: any) => x.endpoint === endpoint).email).toBe("aide@example.com");
    await postJson(locked, "/admin/api/push/unsubscribe", { endpoint }, { cookie: aide });
    expect((await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie })).status).toBe(200);
  });

  test("only owners add and remove admins; other admins see the list but can't change it or the owners", async () => {
    const cookie = ownerCookie;
    await postJson(locked, "/admin/api/admins", { emails: ["aide2@example.com", "aide3@example.com"] }, { cookie });
    const aide = await signIn(locked, "aide2@example.com");
    const owners = ["boss@example.com", "chief@example.com", OWNER];
    const before = { owners, emails: ["aide2@example.com", "aide3@example.com"] };
    expect(await (await get(locked, "/admin/api/admins", { cookie: aide })).json()).toMatchObject(before);
    // adding, removing another admin, or trying to change the owners are all refused
    for (const emails of [["aide2@example.com", "aide3@example.com", "new@example.com"], ["aide2@example.com"], ["aide2@example.com", "aide3@example.com", "boss@example.com"], []]) {
      const r = await postJson(locked, "/admin/api/admins", { emails }, { cookie: aide });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe("Only the owner can add or remove admins.");
    }
    expect(await (await get(locked, "/admin/api/admins", { cookie })).json()).toMatchObject(before);
    expect(JSON.parse(readFileSync(join(locked.dir, "admins.json"), "utf8")).emails).toEqual(["aide2@example.com", "aide3@example.com"]);
    // the owner still can
    expect(await (await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie })).json()).toMatchObject({ owners, emails: [] });
    expect((await get(locked, "/admin/api/state", { cookie: aide })).status).toBe(401);
  });

  test("signing out ends the session on the server too", async () => {
    const cookie = await signIn(locked, "chief@example.com");
    expect((await get(locked, "/admin/api/state", { cookie })).status).toBe(200);
    const out = await postJson(locked, "/admin/logout", {}, { cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await get(locked, "/admin/api/state", { cookie })).status).toBe(401);
  });

  test("a started interview can be marked as a no-show or as not happened through its round status, and unmarked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-missed-"));
    const past = istMidnight() - 24 * HOUR + 10 * HOUR;
    const done = { ...booking, id: "00000000-0000-0000-0000-000000000009", start: new Date(past).toISOString(), end: new Date(past + 30 * 60000).toISOString() };
    const helped = { ...done, id: "00000000-0000-0000-0000-000000000008" };
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [booking, done, helped] }));
    writeFileSync(join(dir, "interviewers.json"), JSON.stringify({ names: ["Praneeth"], assign: { [helped.id]: "Praneeth" } }));
    const srv = await start(4316, {}, dir);
    try {
      const mark = (id: string, status: string) => postJson(srv, "/admin/api/round-status", { id, status });
      // not before it starts, not once support is recorded, and only known values
      expect((await mark(booking.id, "noshow")).status).toBe(409);
      expect((await mark(helped.id, "noshow")).status).toBe(409);
      expect((await mark(done.id, "maybe")).status).toBe(400);
      expect((await mark(done.id, "noshow")).status).toBe(200);
      let state = await (await get(srv, "/admin/api/state")).json();
      expect(state.events.find((e: any) => e.id === done.id).missed).toBe("noshow");
      // no support can be recorded for it, and the download says what happened
      const iv = await fetch(srv.url + "/admin/api/interviewers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: { [done.id]: "Praneeth" } }) });
      expect(iv.status).toBe(409);
      expect(await (await get(srv, "/admin/export.csv")).text()).toContain("No-show");
      expect((await mark(done.id, "other")).status).toBe(200);
      expect(await (await get(srv, "/admin/export.csv")).text()).toContain("Didn't happen");
      expect((await mark(done.id, "")).status).toBe(200);
      state = await (await get(srv, "/admin/api/state")).json();
      expect(state.events.find((e: any) => e.id === done.id).missed).toBe("");
      expect(JSON.parse(readFileSync(join(dir, "bookings.json"), "utf8")).bookings.find((b: any) => b.id === done.id).missed).toBeUndefined();
    } finally {
      srv.proc.kill();
    }
  });

  test("once an interview starts, an admin sets the round's status, and can clear it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-round-"));
    const past = istMidnight() - 24 * HOUR + 10 * HOUR;
    const done = { ...booking, id: "00000000-0000-0000-0000-000000000009", start: new Date(past).toISOString(), end: new Date(past + 30 * 60000).toISOString() };
    const helped = { ...done, id: "00000000-0000-0000-0000-000000000008" };
    const gone = { ...done, id: "00000000-0000-0000-0000-000000000007", cancelled: true, cancelledAt: new Date(past).toISOString() };
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [booking, done, helped, gone] }));
    writeFileSync(join(dir, "interviewers.json"), JSON.stringify({ names: ["Praneeth"], assign: { [helped.id]: "Praneeth" } }));
    const srv = await start(4317, {}, dir);
    try {
      const set = (id: string, status: string) => postJson(srv, "/admin/api/round-status", { id, status });
      const saved = (id: string) => JSON.parse(readFileSync(join(dir, "bookings.json"), "utf8")).bookings.find((b: any) => b.id === id);
      // existing bookings have no status stored
      let state = await (await get(srv, "/admin/api/state")).json();
      expect(state.events.find((e: any) => e.id === done.id).outcome).toBe("");
      expect((await set(done.id, "maybe")).status).toBe(400);
      expect((await set(done.id, "cancelled")).status).toBe(400);
      expect((await set(gone.id, "cleared")).status).toBe(409);
      // nothing before the start; no-show and didn't happen only without support recorded
      expect((await set(booking.id, "hold")).status).toBe(409);
      expect((await set(booking.id, "noshow")).status).toBe(409);
      expect((await set(helped.id, "noshow")).status).toBe(409);
      expect((await set(helped.id, "other")).status).toBe(409);
      expect((await set(helped.id, "rejected")).status).toBe(200);
      expect((await set(done.id, "cleared")).status).toBe(200);
      state = await (await get(srv, "/admin/api/state")).json();
      expect(state.events.find((e: any) => e.id === done.id).outcome).toBe("cleared");
      expect(await (await get(srv, "/admin/export.csv")).text()).toContain("Cleared");
      // a no-show or didn't happen replaces the result, and "" clears everything
      expect((await set(done.id, "noshow")).status).toBe(200);
      expect(saved(done.id).missed).toBe("noshow");
      expect(saved(done.id).outcome).toBeUndefined();
      expect((await set(done.id, "other")).status).toBe(200);
      expect(saved(done.id).missed).toBe("other");
      expect((await set(done.id, "")).status).toBe(200);
      expect(saved(done.id).missed).toBeUndefined();
      expect(saved(done.id).outcome).toBeUndefined();
      expect(saved(helped.id).outcome).toBe("rejected");
    } finally {
      srv.proc.kill();
    }
  });

  test("the service worker caches admin pages and assets only, and forgets them on sign-out", async () => {
    const sw = await get(open, "/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const js = await sw.text();
    expect(js).toContain('"/admin": 1, "/admin/allowlist": 1, "/admin/analytics": 1');
    expect(js).toContain('res.headers.get("X-App-Shell")');
    expect(js).toContain('e.data === "signed-out"');
    expect(js).toContain('self.addEventListener("push"');
    new Function(js); // parses
  });

  test("the admin page has the logo link and the frame points at /admin/analytics", async () => {
    const html = await (await get(open, "/admin")).text();
    expect(html).toContain('<a class="brand" href="/booking" target="_blank" rel="noopener" title="Open the booking page">');
    const js = await (await get(open, assetsIn(html).find((u) => /\/admin\.[0-9a-f]+\.js$/.test(u))!)).text();
    expect(js).toMatch(/\.src="\/admin\/analytics"/);
    expect(js).not.toContain("srcdoc");
  });
});

test("iPhone launch screens: the admin page links light and dark ones, and they are real PNGs of the linked size", async () => {
  const html = await (await get(open, "/admin")).text();
  expect(html).toContain('<meta name="color-scheme" content="light dark">');
  const links = [...html.matchAll(/<link rel="apple-touch-startup-image" href="([^"]+)" media="([^"]+)">/g)];
  expect(links.length).toBe(26);
  expect(links.some(([, , media]) => media.includes("(device-width: 430px)") && media.includes("prefers-color-scheme: dark"))).toBe(true);
  const r = await get(open, "/splash/1290x2796-dark.png");
  expect(r.headers.get("content-type")).toBe("image/png");
  const png = Buffer.from(await r.arrayBuffer());
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1290, 2796]);
  expect((await get(open, "/splash/999x999-dark.png")).status).toBe(404);
});

test("the icon is served from public/icon.png and revalidates", async () => {
  const png = readFileSync(join(ROOT, "public/icon.png"));
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  const r = await get(open, "/icon.png");
  expect(r.headers.get("content-type")).toBe("image/png");
  expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
  expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
  expect((await get(open, "/icon.png", { "if-none-match": r.headers.get("etag")! })).status).toBe(304);
  for (const alias of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) expect(Buffer.from(await (await get(open, alias)).arrayBuffer()).equals(png)).toBe(true);
});

test("the tab icon is served from public/favicon.png at /favicon.png and /favicon.ico", async () => {
  const png = readFileSync(join(ROOT, "public/favicon.png"));
  for (const path of ["/favicon.png", "/favicon.ico"]) {
    const r = await get(open, path);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
  }
});

describe("backups", () => {
  const sent: any[] = [];
  let resend: ReturnType<typeof Bun.serve>;
  let srv: Srv;
  const env = { RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4314/emails", BACKUP_EMAIL: "owner@example.com", BACKUP_HOUR: "0", ADMIN_EMAILS: "owner@example.com" };
  const istDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(30);
  };
  beforeAll(async () => {
    resend = Bun.serve({ port: 4314, fetch: async (req) => (sent.push(await req.json()), Response.json({ id: "x" })) });
    srv = await start(4313, env);
    // the server records the day in backup-state.json just after the email goes out; wait for both, or a quick
    // restart in the next tests could land in between and send the backup a second time
    const stateFile = join(srv.dir, "backup-state.json");
    await waitFor(() => sent.length > 0 && existsSync(stateFile) && readFileSync(stateFile, "utf8").includes('"emailed"'));
  });
  afterAll(() => {
    srv?.proc.kill();
    resend?.stop(true);
  });

  test("the daily backup is emailed with the bookings CSV and the data, without the push keys", () => {
    expect(sent.length).toBe(1);
    const mail = sent[0];
    expect(mail.to).toEqual(["owner@example.com"]);
    expect(mail.subject).toBe("Backup: Hi-Techie bookings \u2013 " + istDay());
    const files = Object.fromEntries(mail.attachments.map((a: any) => [a.filename, Buffer.from(a.content, "base64").toString("utf8")]));
    expect(Object.keys(files).sort()).toEqual(["backup-" + istDay() + ".json", "bookings-" + istDay() + ".csv"]);
    expect(files["bookings-" + istDay() + ".csv"]).toContain("Priya Sharma,priya@example.com,Google,1st round");
    const data = JSON.parse(files["backup-" + istDay() + ".json"]);
    expect(data.app).toBe("booking-form");
    expect(Object.keys(data.files).sort()).toEqual(["admins.json", "allowlist.json", "bookings.json", "enquiries.json", "interviewers.json", "payments.json", "results.json", "secret.json"]);
    expect(data.files["bookings.json"].bookings.length).toBe(61);
    expect(data.files["secret.json"].key).toBe(KEY);
  });

  test("a full snapshot (with push keys) is kept on the volume and the day is recorded", () => {
    const snap = JSON.parse(readFileSync(join(srv.dir, "backups", istDay() + ".json"), "utf8"));
    expect(Object.keys(snap.files)).toContain("push.json");
    expect(JSON.parse(readFileSync(join(srv.dir, "backup-state.json"), "utf8"))).toEqual({ saved: istDay(), emailed: istDay() });
  });

  test("a restart on the same day doesn't send it again", async () => {
    srv.proc.kill();
    await srv.proc.exited;
    srv = await start(4313, env, srv.dir);
    await Bun.sleep(400);
    expect(sent.length).toBe(1);
  });

  test("old snapshots are pruned to the last 14", async () => {
    for (let d = 1; d <= 20; d++) writeFileSync(join(srv.dir, "backups", "2020-01-" + String(d).padStart(2, "0") + ".json"), "{}");
    writeFileSync(join(srv.dir, "backup-state.json"), JSON.stringify({ saved: "", emailed: istDay() }));
    srv.proc.kill();
    await srv.proc.exited;
    srv = await start(4313, env, srv.dir);
    await waitFor(() => readdirSync(join(srv.dir, "backups")).length === 14);
    const left = readdirSync(join(srv.dir, "backups")).sort();
    expect(left.length).toBe(14);
    expect(left.at(-1)).toBe(istDay() + ".json");
    expect(left[0]).toBe("2020-01-08.json");
    expect(sent.length).toBe(1);
  });

  test("the admin can download a backup, and only when signed in", async () => {
    expect((await get(srv, "/admin/backup.json")).status).toBe(401);
    expect((await postJson(srv, "/admin/login/code", { email: "owner@example.com" })).status).toBe(200);
    const code = sent.at(-1).subject.match(/(\d{6})$/)[1];
    const ok = await postJson(srv, "/admin/login", { email: "owner@example.com", code });
    const r = await get(srv, "/admin/backup.json", { cookie: ok.headers.get("set-cookie")!.split(";")[0] });
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="backup-' + istDay() + '.json"');
    const data = await r.json();
    expect(data.files["bookings.json"].bookings.length).toBe(61);
    expect(data.files["push.json"]).toBeUndefined();
  });

  test("scripts/restore.ts puts a backup back into a data folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-restore-"));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [] }));
    const file = join(dir, "in.json");
    writeFileSync(file, readFileSync(join(srv.dir, "backups", istDay() + ".json")));
    const p = Bun.spawn(["bun", "run", join(ROOT, "scripts/restore.ts"), file, dir], { stdout: "ignore", stderr: "inherit" });
    expect(await p.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "bookings.json"), "utf8")).bookings.length).toBe(61);
    expect(existsSync(join(dir, "bookings.json.pre-restore"))).toBe(true);
    expect(existsSync(join(dir, "push.json"))).toBe(true);
  });
});

describe("hardening", () => {
  let bare: Srv;
  const PDF = new TextEncoder().encode("%PDF-1.4\n% a tiny resume\n");
  const enquiry = (headers: Record<string, string> = {}) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years" })) f.set(k, v);
    f.set("resume", new File([PDF], "cv.pdf"));
    return fetch(bare.url + "/api/enquiry", { method: "POST", body: f, headers });
  };
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-bare-"));
    seed(dir);
    // two people typed "Quillsoft", one typed "Asha Rao Consulting"; 99 enquiries came in during the last day
    const typed = [
      { ...booking, id: "20000000-0000-0000-0000-000000000001", email: "a@example.com", company: "Quillsoft" },
      { ...booking, id: "20000000-0000-0000-0000-000000000002", email: "b@example.com", company: "Quillsoft" },
      { ...booking, id: "20000000-0000-0000-0000-000000000003", email: "c@example.com", company: "Asha Rao Consulting" },
    ].map((b, i) => ({ ...b, cancelled: true, start: new Date(FUTURE - (i + 100) * 24 * HOUR).toISOString() }));
    const bookings = JSON.parse(readFileSync(join(dir, "bookings.json"), "utf8")).bookings;
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [...bookings, ...typed] }));
    const recent = Array.from({ length: 99 }, (_, i) => ({
      id: "30000000-0000-0000-0000-" + String(i).padStart(12, "0"), name: "X", email: "x@example.com", phone: "9876543210", tech: "Java",
      experience: "1 year", createdAt: new Date(Date.now() - i * 60000).toISOString(), resume: { file: "none.pdf", name: "cv.pdf", type: "application/pdf", size: 10 },
    }));
    writeFileSync(join(dir, "enquiries.json"), JSON.stringify({ enquiries: recent, seen: {} }));
    // no ADMIN_EMAILS and no ADMIN_OPEN: what production would get if the variable were deleted
    bare = await start(4316, { ADMIN_OPEN: "" }, dir);
  });
  afterAll(() => bare?.proc.kill());

  test("without ADMIN_EMAILS the admin area stays locked", async () => {
    const page = await (await get(bare, "/admin")).text();
    expect(page).toContain('id="em"');
    expect((await get(bare, "/admin/api/state")).status).toBe(401);
    expect((await get(bare, "/admin/export.csv")).status).toBe(401);
    expect((await get(bare, "/admin/backup.json")).status).toBe(401);
    expect((await postJson(bare, "/admin/login/code", { email: "anyone@example.com" })).status).toBe(200);
    expect((await postJson(bare, "/admin/login", { email: "anyone@example.com", code: "000000" })).status).toBe(401);
  });

  test("security headers are on every response", async () => {
    for (const path of ["/", "/booking", "/api/companies", "/healthz"]) {
      const r = await get(bare, path);
      expect(r.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(r.headers.get("permissions-policy")).toContain("camera=()");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  test("company names only one candidate typed are not shared", async () => {
    const { companies } = await (await get(bare, "/api/companies")).json();
    const names = companies.map((c: any) => c.n);
    expect(names).toContain("Quillsoft");
    expect(names).not.toContain("Asha Rao Consulting");
  });

  test("oversized requests are refused before they are read", async () => {
    const big = "x".repeat(3 * 1024 * 1024);
    const r = await fetch(bare.url + "/api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: big }).catch(() => null);
    expect(r === null || r.status === 413).toBe(true);
  });

  test("a made-up X-Forwarded-For doesn't get round the enquiry limit, and there's a daily cap for everyone", async () => {
    // the 100th enquiry of the day is saved, the next is refused whatever network it comes from
    expect((await enquiry({ "x-real-ip": "10.9.0.1" })).status).toBe(200);
    const capped = await enquiry({ "x-real-ip": "10.9.0.2" });
    expect(capped.status).toBe(429);
    expect((await capped.json()).error).toContain("Try again tomorrow");
    // per network: five an hour, counted by the address Railway reports, not by X-Forwarded-For
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await enquiry({ "x-real-ip": "10.9.0.3", "x-forwarded-for": "172.16.0." + i })).status);
    expect(codes.at(-1)).toBe(429);
    expect((await (await enquiry({ "x-real-ip": "10.9.0.3" })).json()).error).toContain("from this network");
  });
});

describe("data safety", () => {
  let s: Srv;
  const GARBAGE = "{ not json";
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-safety-"));
    seed(dir);
    // neither the interview supporters file nor its backup reads; the Candidates list is one email short of full
    writeFileSync(join(dir, "interviewers.json"), GARBAGE);
    writeFileSync(join(dir, "interviewers.json.bak"), GARBAGE);
    const emails = Array.from({ length: 4999 }, (_, i) => "c" + i + "@example.com");
    writeFileSync(join(dir, "allowlist.json"), JSON.stringify({ enabled: false, emails }));
    s = await start(4318, {}, dir);
  });
  afterAll(() => s?.proc.kill());

  test("a store whose file and backup don't read is never overwritten", async () => {
    const r = await fetch(s.url + "/admin/api/interviewer-names", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ list: [{ to: "Asha" }] }),
    });
    expect(r.status).toBe(200);
    expect(readFileSync(join(s.dir, "interviewers.json"), "utf8")).toBe(GARBAGE);
  });

  test("adding more emails than fit changes nothing, not even in memory", async () => {
    const full = await postJson(s, "/admin/api/allowlist", { action: "add", text: "new1@example.com new2@example.com" });
    expect(full.status).toBe(400);
    expect((await postJson(s, "/admin/api/allowlist", { action: "remove", email: "nobody@example.com" })).status).toBe(200);
    const saved = JSON.parse(readFileSync(join(s.dir, "allowlist.json"), "utf8"));
    expect(saved.emails.length).toBe(4999);
    expect(saved.emails).not.toContain("new1@example.com");
  });

  test("JSON bodies that aren't objects are refused cleanly, not crashed on", async () => {
    for (const body of ["null", "[]", '"text"', "42"]) {
      const send = (path: string) =>
        fetch(s.url + path, { method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": "10.7.1.1" }, body });
      expect((await send("/api/book")).status).toBe(400);
      expect((await send("/api/manage/cancel")).status).toBe(403);
      expect((await send("/admin/api/allowlist")).status).toBe(400);
      expect((await send("/admin/api/round-status")).status).toBe(400);
    }
  });

  test("one network can make at most 20 bookings an hour", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await postJson(s, "/api/book", {}, { "x-real-ip": "10.7.0.1" })).status);
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
    expect((await postJson(s, "/api/book", {}, { "x-real-ip": "10.7.0.2" })).status).toBe(400);
  });
});
