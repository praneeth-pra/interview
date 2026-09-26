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
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, RESEND_API_KEY: "", BACKUP_HOUR: "23", ...env },
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
    for (const text of ["Land the job you", "Resume rewrite", "Interview proxy", "Get offer", "Big data engineering", "Your next opportunity is closer than it looks."]) expect(html).toContain(text);
    const css = html.match(/href="(\/assets\/home\.[^"]+\.css)"/)?.[1];
    expect(css).toBeTruthy();
    const style = await (await get(open, css!)).text();
    expect(style).toContain("Instrument Serif");
    expect(style).toContain("Figtree");
    const r = await fetch(open.url + "/booking/", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/booking");
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
    const pages = await Promise.all(["/", "/booking", "/enquiry", "/admin", "/admin/analytics"].map(async (p) => (await get(open, p)).text()));
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

  test("company joins are saved with the results, and loops are refused quietly", async () => {
    const post = (body: unknown) => fetch(open.url + "/admin/api/company-joins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await (await post({ from: "Apple via Infosys", to: "Infosys" })).json()).joins).toEqual({ "apple via infosys": "infosys" });
    expect((await (await post({ from: "infosys", to: "apple via infosys" })).json()).joins).toEqual({ "apple via infosys": "infosys" });
    expect((await post({ from: "", to: "x" })).status).toBe(400);
    expect((await (await get(open, "/admin/api/results")).json()).joins).toEqual({ "apple via infosys": "infosys" });
    expect(JSON.parse(readFileSync(join(open.dir, "results.json"), "utf8")).joins).toEqual({ "apple via infosys": "infosys" });
    expect((await (await post({ from: "apple via infosys", to: "" })).json()).joins).toEqual({});
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
    const big = new Uint8Array(1024 * 1024 + 10);
    big.set(PDF);
    expect((await send(form(good, { bytes: big, name: "big.pdf" }))).status).toBe(413);
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
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
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
    const sent = await fetch(open.url + "/api/enquiry", { method: "POST", body: form({ ...good, name: "Ravi Teja" }, { bytes: PDF2, name: "ravi.pdf" }), headers: { "x-forwarded-for": "10.0.0.2" } });
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
    expect(boot(html)).toEqual({ tab: "cal", login: true, build: expect.stringMatching(/^[0-9a-z]+$/) });
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
    // a helper can't take themselves off the list
    const self = await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie: helper });
    expect(self.status).toBe(400);
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

  test("signing out ends the session on the server too", async () => {
    const cookie = await signIn(locked, "chief@example.com");
    expect((await get(locked, "/admin/api/state", { cookie })).status).toBe(200);
    const out = await postJson(locked, "/admin/logout", {}, { cookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await get(locked, "/admin/api/state", { cookie })).status).toBe(401);
  });

  test("a started interview can be marked as a no-show or as not happened, and unmarked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-missed-"));
    const past = istMidnight() - 24 * HOUR + 10 * HOUR;
    const done = { ...booking, id: "00000000-0000-0000-0000-000000000009", start: new Date(past).toISOString(), end: new Date(past + 30 * 60000).toISOString() };
    const helped = { ...done, id: "00000000-0000-0000-0000-000000000008" };
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [booking, done, helped] }));
    writeFileSync(join(dir, "interviewers.json"), JSON.stringify({ names: ["Praneeth"], assign: { [helped.id]: "Praneeth" } }));
    const srv = await start(4316, {}, dir);
    try {
      const mark = (id: string, missed: string) => postJson(srv, "/admin/api/missed", { id, missed });
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
    expect(html).toContain('<a class="brand" href="/booking" title="Open the booking page">');
    const js = await (await get(open, assetsIn(html).find((u) => u.endsWith(".js"))!)).text();
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
    expect(Object.keys(data.files).sort()).toEqual(["admins.json", "allowlist.json", "bookings.json", "enquiries.json", "interviewers.json", "results.json", "secret.json"]);
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
