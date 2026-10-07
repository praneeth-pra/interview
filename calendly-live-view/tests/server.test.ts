import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, RESEND_API_KEY: "", BACKUP_HOUR: "23", MONTHLY_REPORT: "off", ADMIN_OPEN: "1", ...env },
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
// A payment from this email through /payment, confirmed (or discarded, or left waiting with null) by an owner
async function paidFor(srv: Srv, email: string, ip: string, decision: "confirm" | "discard" | null = "confirm") {
  const d = new FormData();
  for (const [k, v] of Object.entries({ email, name: "Paid Person", installment: "advance", amount: "500" })) d.set(k, v);
  d.set("receipt", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7])], "r.png"));
  expect((await fetch(srv.url + "/api/payment", { method: "POST", body: d, headers: { "x-real-ip": ip } })).status).toBe(200);
  if (!decision) return;
  const { payments } = await (await get(srv, "/admin/api/payments")).json();
  const id = payments.find((p: any) => p.email === email.toLowerCase() && !p.decision).id;
  expect((await postJson(srv, "/admin/api/payments/decide", { id, decision })).status).toBe(200);
}
function seed(dir: string) {
  writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
  const many = Array.from({ length: 60 }, (_, i) => ({ ...booking, id: "10000000-0000-0000-0000-" + String(i).padStart(12, "0"), cancelled: true, start: new Date(FUTURE - (i + 1) * 24 * HOUR).toISOString() }));
  writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [booking, ...many] }));
}

// The text of a PDF, read with pdftotext (poppler-utils, which the Docker image and CI install for receipts).
function pdfText(pdf: Buffer) {
  const file = join(mkdtempSync(join(tmpdir(), "booking-form-pdf-")), "r.pdf");
  writeFileSync(file, pdf);
  const r = Bun.spawnSync(["pdftotext", "-layout", file, "-"]);
  expect(r.exitCode).toBe(0);
  return r.stdout.toString();
}

// Sign-in codes go out by email; a stand-in for the email API keeps them so the tests can read them.
const OWNER = "owner@example.com";
const mails: any[] = [];
const mailServer = Bun.serve({ port: 4315, fetch: async (req) => (mails.push(await req.json()), Response.json({ id: "x" })) });
const lockedEnv = { ADMIN_EMAILS: OWNER + ", boss@example.com chief@example.com", RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4315/emails" };
const postJson = (s: Srv, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(s.url + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
// A booking from the booking page: a multipart form with the interview invite (a stand-in PNG unless one is given).
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const bookForm = (s: Srv, body: Record<string, unknown>, headers: Record<string, string> = {}, invite: Blob | null = new Blob([PNG])) => {
  const form = new FormData();
  for (const [k, v] of Object.entries({ hrVisible: "yes", ...body })) form.set(k, String(v));
  if (invite) form.set("invite", invite, "invite.png");
  return fetch(s.url + "/api/book", { method: "POST", headers, body: form });
};
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
    expect(boot(html)).toEqual({ host: "Hi<Techie>", event: "Interview", manage: null, info: expect.objectContaining({ loc: expect.any(String) }), inviteMax: 1572864 });
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
    const made = await (await bookForm(open, { name: "Test Person", email: "test@example.com", company: "Acme", round: "HR", duration: 30, startMs: slots[0] })).json();
    expect(made.booking.manage).toMatch(/\/b\/[0-9a-f-]{36}\?t=[0-9a-f]{32}$/);
    const noCompany = await bookForm(open, { name: "Other", email: "o@example.com", company: "  ", duration: 30, startMs: slots[2] });
    expect(noCompany.status).toBe(400);
    expect((await noCompany.json()).field).toBe("company");
    const clash = await bookForm(open, { name: "Other", email: "o@example.com", company: "Beta", duration: 30, startMs: slots[0] });
    expect(clash.status).toBe(409);
    const t = made.booking.manage.split("t=")[1];
    const moved = await (await post("/api/manage/reschedule", { id: made.booking.id, t, startMs: slots[1], duration: 30 })).json();
    expect(moved.booking.start).toBe(new Date(slots[1]).toISOString());
    expect((await post("/api/manage/cancel", { id: made.booking.id, t, reason: "test" })).status).toBe(200);
    const state = await (await get(open, "/admin/api/state")).json();
    expect(state.events.find((e: any) => e.id === made.booking.id)).toBeUndefined();
    expect(state.changes[0]).toMatchObject({ id: made.booking.id, kind: "cancelled" });
  });

  test("candidates' bookings need the interview invite, which admins can open", async () => {
    const days = await (await get(open, "/api/days?duration=60")).json();
    const day = days.days.filter((d: any) => d.open).at(-1);
    const slots = (await (await get(open, `/api/slots?date=${day.key}&duration=60`)).json()).slots;
    const body = { name: "Invite Test", email: "invite@example.com", company: "Acme", round: "HR", duration: 60, startMs: slots.at(-1) };
    // without the invite, as JSON or as a form, and with a file that isn't a picture or a PDF
    for (const r of [await postJson(open, "/api/book", body), await bookForm(open, body, {}, null)]) {
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({ field: "invite", error: "Add a screenshot or PDF of your interview invite." });
    }
    const unticked = await bookForm(open, { ...body, hrVisible: "" });
    expect(await unticked.json()).toMatchObject({ field: "inviteHr" });
    const text = await bookForm(open, body, {}, new Blob(["just text"]));
    expect(text.status).toBe(400);
    expect((await text.json()).field).toBe("invite");
    const made = await (await bookForm(open, body)).json();
    const id = made.booking.id;
    const file = await get(open, "/admin/api/bookings/" + id + "/invite");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    expect((await get(open, "/admin/api/bookings/" + id + "/invite?download=1")).headers.get("content-disposition")).toContain(
      "Invite Test interview invite.png",
    );
    // the invite is read after the booking is saved; a stand-in picture has no contacts
    let saved: any;
    for (let i = 0; i < 100 && !saved?.inviteRead; i++) {
      await Bun.sleep(50);
      saved = (await (await get(open, "/admin/api/bookings")).json()).bookings.find((b: any) => b.id === id);
    }
    expect(saved).toMatchObject({ invite: { name: "invite.png", type: "image/png" }, hrEmails: [], hrPhones: [], inviteRead: true });
    expect((await get(open, "/admin/api/bookings/" + crypto.randomUUID() + "/invite")).status).toBe(404);
    const t = made.booking.manage.split("t=")[1];
    expect((await postJson(open, "/api/manage/cancel", { id, t, reason: "test" })).status).toBe(200);
  });

  test("only admins book a demo, and a demo has no interview invite", async () => {
    const days = await (await get(open, "/api/days?duration=30")).json();
    const day = days.days.filter((d: any) => d.open).at(-1);
    const slots = (await (await get(open, `/api/slots?date=${day.key}&duration=30`)).json()).slots;
    const body = { name: "Demo Test", email: "demo@example.com", company: "", round: "Demo", duration: 30, startMs: slots.at(-2) };
    // the booking page refuses a demo, however the round is written, with or without an invite
    const ip = { "x-real-ip": "10.9.0.1" };
    for (const r of [
      await bookForm(open, body, ip),
      await bookForm(open, { ...body, round: "demo session" }, ip),
      await postJson(open, "/api/book", body, ip),
    ]) {
      expect(r.status).toBe(403);
      expect(await r.json()).toMatchObject({ field: "round", error: "Only admins can book a demo." });
    }
    // the booking page asks whether an admin is signed in before offering Demo
    expect(await (await get(open, "/admin/api/me")).json()).toEqual({ admin: true });
    expect(await (await get(locked, "/admin/api/me")).json()).toEqual({ admin: false });
    const made = await (await postJson(open, "/admin/api/book", body)).json();
    const saved = (await (await get(open, "/admin/api/bookings")).json()).bookings.find((b: any) => b.id === made.booking.id);
    expect(saved).toMatchObject({ round: "Demo", source: "admin", invite: null });
    expect((await postJson(open, "/admin/api/cancel", { id: made.booking.id, reason: "test" })).status).toBe(200);
  });

  test("on start, a demo booked with an invite loses it; other bookings keep theirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-demo-"));
    const ref = (id: string) => ({ file: id + "-invite.png", name: "invite.png", type: "image/png", size: PNG.length });
    const demo = { ...booking, id: "00000000-0000-0000-0000-0000000000d1", round: "Demo", invite: ref("00000000-0000-0000-0000-0000000000d1"), hrEmails: [], hrPhones: [], inviteRead: true };
    const real = { ...booking, invite: ref(booking.id) };
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [real, demo] }));
    mkdirSync(join(dir, "invites"));
    for (const b of [real, demo]) writeFileSync(join(dir, "invites", b.invite.file), PNG);
    const srv = await start(4352, {}, dir);
    try {
      const list = (await (await get(srv, "/admin/api/bookings")).json()).bookings;
      expect(list.find((b: any) => b.id === demo.id)).toMatchObject({ invite: null, inviteRead: false });
      expect(list.find((b: any) => b.id === real.id).invite).toMatchObject({ name: "invite.png" });
      expect(readdirSync(join(dir, "invites"))).toEqual([real.invite.file]);
    } finally {
      srv.proc.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unavailable times: candidates can't book or move into them, admins still can, and removing one frees it", async () => {
    const dayMs = istMidnight() + 3 * 24 * HOUR;
    const key = new Date(dayMs + 330 * 60000).toISOString().slice(0, 10);
    const freeBefore = (await (await get(open, `/api/slots?date=${key}&duration=30`)).json()).slots;
    expect(freeBefore.length).toBeGreaterThan(4);
    // validation
    expect((await postJson(open, "/admin/api/unavailable", { startMs: dayMs + HOUR, endMs: dayMs })).status).toBe(400);
    expect((await postJson(open, "/admin/api/unavailable", { startMs: dayMs - 9 * 24 * HOUR, endMs: dayMs - 8 * 24 * HOUR })).status).toBe(400);
    expect((await postJson(open, "/admin/api/unavailable", { startMs: "x", endMs: dayMs })).status).toBe(400);
    // the whole day, and the afternoon two days before it, where Priya's interview is (10:00 IST) → one clash
    const day = await (await postJson(open, "/admin/api/unavailable", { startMs: dayMs, endMs: dayMs + 24 * HOUR, note: "Travelling" })).json();
    expect(day.clashes).toBe(0);
    const morning = await (await postJson(open, "/admin/api/unavailable", { startMs: FUTURE - HOUR, endMs: FUTURE + 2 * HOUR })).json();
    expect(morning.clashes).toBe(1);
    const state = await (await get(open, "/admin/api/state")).json();
    expect(state.blocks.map((b: any) => b.id)).toEqual([morning.id, day.id]);
    expect(state.blocks[1]).toMatchObject({ note: "Travelling", start: new Date(dayMs).toISOString() });
    expect(state.events.some((e: any) => e.id === booking.id)).toBe(true); // the interview already booked stays
    // candidates: no times that day, none in the morning block, and booking or moving into them is refused
    const days = (await (await get(open, "/api/days?duration=30")).json()).days;
    expect(days.find((d: any) => d.key === key)).toMatchObject({ open: false, slots: [] });
    expect((await (await get(open, `/api/slots?date=${key}&duration=30`)).json()).slots).toEqual([]);
    const futureKey = new Date(FUTURE + 330 * 60000).toISOString().slice(0, 10);
    const near = (await (await get(open, `/api/slots?date=${futureKey}&duration=30`)).json()).slots;
    expect(near.filter((s: number) => s >= FUTURE - HOUR && s < FUTURE + 2 * HOUR)).toEqual([]);
    const refused = await bookForm(open, { name: "Ravi", email: "ravi@example.com", company: "Acme", duration: 30, startMs: freeBefore[2] });
    expect(refused.status).toBe(409);
    const made = await (await bookForm(open, { name: "Ravi", email: "ravi@example.com", company: "Acme", duration: 30, startMs: near.at(-1) })).json();
    const t = made.booking.manage.split("t=")[1];
    expect((await postJson(open, "/api/manage/reschedule", { id: made.booking.id, t, startMs: freeBefore[3], duration: 30 })).status).toBe(409);
    // admins still see and can book those times
    const adminSlots = (await (await get(open, `/admin/api/slots?date=${key}&duration=30`)).json()).slots;
    expect(adminSlots).toEqual(freeBefore);
    // removing the day frees it again; removing twice says it's gone
    expect((await postJson(open, "/admin/api/unavailable/delete", { id: day.id })).status).toBe(200);
    expect((await postJson(open, "/admin/api/unavailable/delete", { id: day.id })).status).toBe(404);
    expect((await (await get(open, `/api/slots?date=${key}&duration=30`)).json()).slots).toEqual(freeBefore);
    expect((await postJson(open, "/admin/api/unavailable/delete", { id: morning.id })).status).toBe(200);
    expect((await postJson(open, "/api/manage/cancel", { id: made.booking.id, t, reason: "test" })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(open.dir, "unavailable.json"), "utf8")).blocks).toEqual([]);
  });

  test("company suggestions come from data/companies.json", async () => {
    const { companies } = await (await get(open, "/api/companies")).json();
    expect(companies.find((c: any) => c.n === "Google")).toMatchObject({ a: ["Alphabet"] });
  });

  test("a candidate's later rounds keep the company spelling they used before", async () => {
    const days = await (await get(open, "/api/days?duration=30")).json();
    const open2 = days.days.filter((d: any) => d.open).slice(-2);
    const slots = (await (await get(open, `/api/slots?date=${open2[open2.length - 1].key}&duration=30`)).json()).slots;
    const book = async (email: string, company: string, i: number) =>
      (await (await bookForm(open, { name: "Round Test", email, company, round: "1st round", duration: 30, startMs: slots[i] })).json()).booking;
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
  const good = { name: "Asha Rao", email: "Asha@Example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years", genuine: "yes" };
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
    // from another network, so the hourly limit stays for the checks below
    const notSaid = await fetch(open.url + "/api/enquiry", {
      method: "POST",
      body: form({ ...good, genuine: "maybe" }, { bytes: PDF, name: "cv.pdf" }),
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(notSaid.status).toBe(400);
    expect((await notSaid.json()).error).toBe("Tell us whether your recent experience is genuine.");
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
    expect(e).toMatchObject({ name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years", genuine: "yes" });
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

describe("onboarding", () => {
  // its own server, so the payments these tests confirm don't change the payment and Revenue totals tested below
  let srv: Srv;
  beforeAll(async () => {
    srv = await start(4344, { HOST_NAME: "Hi<Techie>" });
  });
  afterAll(() => srv?.proc.kill());
  const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const PDF = new TextEncoder().encode("%PDF-1.5\n% an e-PAN\n");
  const form = (fields: Record<string, string>, cards: Record<string, { bytes: Uint8Array; name: string }>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    for (const [k, c] of Object.entries(cards)) f.set(k, new File([c.bytes], c.name));
    return f;
  };
  const good = { name: "Lakshmi Devi", email: "Lakshmi@Example.com", phone: "98765 43210", tech: "Python", experience: "2 years", genuine: "yes", linkedin: "https://www.linkedin.com/in/lakshmi-devi" };
  const both = { aadhaar: { bytes: JPG, name: "aadhaar front.jpg" }, pan: { bytes: PDF, name: "pan.pdf" } };
  const send = (f: FormData, ip = "10.2.0.1") => fetch(srv.url + "/api/onboarding", { method: "POST", body: f, headers: { "x-real-ip": ip } });

  test("a form is accepted only from an email with a confirmed payment", async () => {
    const unpaid = await send(form({ ...good, email: "unpaid@example.com" }, both), "10.2.0.4");
    expect(unpaid.status).toBe(403);
    expect(await unpaid.json()).toEqual({ error: "We couldn't find a payment from this email. Use the email you paid with.", field: "email", payment: "none" });
    await paidFor(srv, "pending@example.com", "10.2.0.5", null);
    const pending = await send(form({ ...good, email: "Pending@example.com" }, both), "10.2.0.4");
    expect(pending.status).toBe(403);
    expect(await pending.json()).toEqual({ error: "We're still checking your payment. Please send this form once it's confirmed.", field: "email", payment: "pending" });
    await paidFor(srv, "discarded@example.com", "10.2.0.5", "discard");
    expect((await (await send(form({ ...good, email: "discarded@example.com" }, both), "10.2.0.4")).json()).payment).toBe("none");
  });

  test("the page is served with the card limit and kept out of search engines", async () => {
    const page = await get(srv, "/onboarding");
    expect(page.status).toBe(200);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain('name="aadhaar"');
    expect(html).toContain('name="pan"');
    expect(html).toContain('"max":1572864');
    expect(html).toContain("<title>Onboarding · Hi&lt;Techie&gt;</title>");
    const r = await fetch(srv.url + "/onboarding/", { redirect: "manual" });
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe("/onboarding");
  });

  test("forms are checked, stored with both cards, listed for owners, downloadable and deletable", async () => {
    await paidFor(srv, good.email, "10.2.0.6");
    expect((await send(form({ ...good, website: "spam.example" }, both))).status).toBe(200);
    const noPan = await send(form(good, { aadhaar: both.aadhaar }));
    expect(noPan.status).toBe(400);
    expect(await noPan.json()).toEqual({ error: "Add your PAN card.", field: "pan" });
    const notImage = await send(form(good, { ...both, aadhaar: { bytes: new TextEncoder().encode("hello"), name: "a.jpg" } }));
    expect(notImage.status).toBe(400);
    expect((await notImage.json()).error).toBe("Your Aadhaar card must be a photo or a PDF.");
    expect((await send(form({ ...good, phone: "12" }, both))).status).toBe(400);
    // every field is required
    expect(await (await send(form({ ...good, genuine: "" }, both))).json()).toEqual({ error: "Tell us whether your recent experience is genuine.", field: "genuine" });
    expect((await (await send(form({ ...good, linkedin: "" }, both), "10.2.0.3")).json()).field).toBe("linkedin");
    const badLink = await send(form({ ...good, linkedin: "facebook.com/lakshmi" }, both), "10.2.0.3");
    expect(await badLink.json()).toEqual({ error: "Enter your LinkedIn profile link, like linkedin.com/in/your-name.", field: "linkedin" });
    const big = new Uint8Array(1536 * 1024 + 1);
    big.set(JPG);
    const tooBig = await send(form(good, { ...both, pan: { bytes: big, name: "pan.jpg" } }), "10.2.0.3");
    expect(tooBig.status).toBe(413);
    expect((await tooBig.json()).error).toBe("Your PAN card file is larger than 1.5 MB. Please upload a smaller file.");
    expect((await send(form(good, both), "10.2.0.2")).status).toBe(200);
    // a LinkedIn address typed without https:// is kept as a full address
    expect((await send(form({ ...good, name: "Arjun Reddy", genuine: "no", linkedin: "www.LinkedIn.com/in/arjun-reddy" }, both), "10.2.0.2")).status).toBe(200);
    // the newest first, after the seeded forms and any from the booking tests
    const all = (await (await get(srv, "/admin/api/onboarding")).json()).forms;
    const forms = all.slice(0, 2);
    expect(forms.map((x: any) => x.name)).toEqual(["Arjun Reddy", "Lakshmi Devi"]);
    expect(forms[0]).toMatchObject({ name: "Arjun Reddy", genuine: "no", linkedin: "https://www.linkedin.com/in/arjun-reddy" });
    expect((await postJson(srv, "/admin/api/onboarding/delete", { id: forms[0].id })).status).toBe(200);
    const v = forms[1];
    expect(v).toMatchObject({ genuine: "yes", linkedin: "https://www.linkedin.com/in/lakshmi-devi" });
    expect(v).toMatchObject({ name: "Lakshmi Devi", email: "lakshmi@example.com", phone: "98765 43210", tech: "Python", experience: "2 years" });
    expect(v.aadhaar).toEqual({ name: "aadhaar front.jpg", type: "image/jpeg", size: JPG.length });
    expect(v.pan).toEqual({ name: "pan.pdf", type: "application/pdf", size: PDF.length });
    expect((await (await get(srv, "/admin/api/state")).json()).onboarding).toBe(all.length - 1);
    expect(existsSync(join(srv.dir, "id-cards", forms[0].id + "-pan.pdf"))).toBe(false);
    const aadhaar = await get(srv, "/admin/api/onboarding/" + v.id + "/aadhaar");
    expect(aadhaar.headers.get("content-type")).toBe("image/jpeg");
    expect(aadhaar.headers.get("content-disposition")).toStartWith("inline;");
    expect(new Uint8Array(await aadhaar.arrayBuffer())).toEqual(JPG);
    const pan = await get(srv, "/admin/api/onboarding/" + v.id + "/pan?download=1");
    expect(pan.headers.get("content-disposition")).toBe("attachment; filename=\"Lakshmi Devi PAN card.pdf\"; filename*=UTF-8''Lakshmi%20Devi%20PAN%20card.pdf");
    expect((await get(srv, "/admin/api/onboarding/" + v.id + "/resume")).status).toBe(404);
    expect(existsSync(join(srv.dir, "id-cards", v.id + "-aadhaar.jpg"))).toBe(true);
    expect(existsSync(join(srv.dir, "id-cards", v.id + "-pan.pdf"))).toBe(true);
    // the backup carries the cards, and restoring accepts them
    const backup = await (await get(srv, "/admin/backup.json")).json();
    expect(Object.keys(backup.uploads)).toEqual(expect.arrayContaining(["id-cards/" + v.id + "-aadhaar.jpg", "id-cards/" + v.id + "-pan.pdf"]));
    expect(backup.files["onboarding.json"].forms.length).toBe(all.length - 1);
    expect((await postJson(srv, "/admin/api/onboarding/delete", { id: v.id })).status).toBe(200);
    expect((await (await get(srv, "/admin/api/onboarding")).json()).forms.length).toBe(all.length - 2);
    expect(existsSync(join(srv.dir, "id-cards", v.id + "-aadhaar.jpg"))).toBe(false);
    expect((await postJson(srv, "/admin/api/onboarding/delete", { id: v.id })).status).toBe(404);
    // behind sign-in when it is on
    expect((await get(locked, "/admin/api/onboarding")).status).toBe(401);
  });

  test("with the Candidates list on, an email books only after an accepted onboarding form; admins can book anyone", async () => {
    const days = await (await get(srv, "/api/days?duration=30")).json();
    const slots: number[] = days.days.filter((d: any) => d.open).flatMap((d: any) => d.slots).slice(-6);
    const book = (email: string, i: number, path = "/api/book") => {
      const body = { name: "New Person", email, company: "Acme", duration: 30, startMs: slots[i] };
      return path === "/api/book" ? bookForm(srv, body, { "x-real-ip": "10.3.0.1" }) : postJson(srv, path, body, { "x-real-ip": "10.3.0.1" });
    };
    expect((await postJson(srv, "/admin/api/allowlist", { action: "add", text: "listed@example.com" })).status).toBe(200);
    expect((await postJson(srv, "/admin/api/allowlist", { action: "enable", on: true })).status).toBe(200);
    try {
      const refused = await book("brand-new@example.com", 0);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "This email isn't registered yet. Please fill in the onboarding form with this email first, then book your slot.", field: "email", onboarding: true });
      // an admin can book anyone
      expect((await book("admin-booked@example.com", 1, "/admin/api/book")).status).toBe(200);
      // a confirmed payment alone doesn't let them book; the onboarding form after it does (any capitals)
      await paidFor(srv, "Brand-New@example.com", "10.3.0.3");
      expect((await book("brand-new@example.com", 0)).status).toBe(403);
      const f = new FormData();
      for (const [k, v] of Object.entries({ name: "New Person", email: "Brand-New@example.com", phone: "9876543210", tech: "Java", experience: "1 year", genuine: "yes", linkedin: "linkedin.com/in/new" })) f.set(k, v);
      f.set("aadhaar", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "a.jpg"));
      f.set("pan", new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "p.jpg"));
      expect((await fetch(srv.url + "/api/onboarding", { method: "POST", body: f, headers: { "x-real-ip": "10.3.0.2" } })).status).toBe(200);
      expect((await (await get(srv, "/admin/api/allowlist")).json()).state.emails).toContain("brand-new@example.com");
      expect((await book("brand-new@example.com", 2)).status).toBe(200);
    } finally {
      await postJson(srv, "/admin/api/allowlist", { action: "enable", on: false });
    }
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
    // which installment it is: Advance, First or Final, and required (2nd and 3rd are no longer offered)
    for (const installment of ["", "2", "3", "4", "toString"]) {
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
    expect((await send(form({ ...good, name: "Meena Iyer", installment: "final", amount: "999.50" }, { bytes: PDF, name: "bank.pdf" }), "10.1.0.2")).status).toBe(200);
    const { payments } = await (await get(open, "/admin/api/payments")).json();
    expect(payments.map((p: any) => p.name)).toEqual(["Meena Iyer", "Kiran Kumar"]);
    expect(payments[1]).toMatchObject({ email: "kiran@example.com", amount: 12500, receipt: { name: "gpay.png", type: "image/png", size: PNG.length } });
    expect(payments[0].amount).toBe(999.5);
    expect(payments.map((p: any) => p.installment)).toEqual(["final", "advance"]);
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
    // nothing last month, so "This month" has nothing to compare with
    expect(v.revenue.lastToDate).toBe(0);
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
      "Kiran Kumar,kiran@example.com,First installment,5000,Pending",
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
    // the monthly report as a PDF, for the month asked for (a month that isn't one falls back to last month)
    const thisMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()).slice(0, 7);
    const pdf = await get(open, "/admin/api/revenue.pdf?month=" + thisMonth);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="revenue-report-' + thisMonth + '.pdf"');
    const text = pdfText(Buffer.from(await pdf.arrayBuffer()));
    expect(text).toContain("MONTHLY REVENUE REPORT");
    expect(text).toContain("\u20b912,500");
    expect(text).toContain("Kiran Kumar");
    expect((await get(open, "/admin/api/revenue.pdf?month=junk")).headers.get("content-disposition")).not.toContain(thisMonth);
    expect((await get(locked, "/admin/api/revenue.pdf")).status).toBe(401);
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
    d.set("installment", "final");
    d.set("amount", "700");
    d.set("receipt", new File([PNG], "blurry.png"));
    expect((await fetch(open.url + "/api/payment", { method: "POST", body: d, headers: { "x-real-ip": "10.1.8.2" } })).status).toBe(200);
    const { payments } = await (await get(open, "/admin/api/payments")).json();
    expect(payments.find((p: any) => p.email === "ravi@example.com").check).toBe("unread");
  });
});

describe("payments and the invite list", () => {
  test("payments are open to any email; confirming one doesn't add the email to the Candidates list", async () => {
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
      // anyone can send a payment, listed or not
      expect((await send("Stranger@Example.com")).status).toBe(200);
      // confirming it leaves the list alone: the onboarding form adds the email
      const allow = async () => (await (await get(open, "/admin/api/allowlist")).json()).state.emails;
      const { payments } = await (await get(open, "/admin/api/payments")).json();
      const id = payments.find((p: any) => p.email === "stranger@example.com").id;
      expect(await (await postJson(open, "/admin/api/payments/decide", { id, decision: "confirm" })).json()).not.toHaveProperty("allowed");
      expect(await allow()).not.toContain("stranger@example.com");
      // one email can't pile up payments waiting for a decision
      for (const ip of ["10.1.9.3", "10.1.9.4", "10.1.9.5"])
        expect((await fetch(open.url + "/api/payment", { method: "POST", body: f("pile@example.com"), headers: { "x-real-ip": ip } })).status).toBe(200);
      const fourth = await fetch(open.url + "/api/payment", { method: "POST", body: f("pile@example.com"), headers: { "x-real-ip": "10.1.9.6" } });
      expect(fourth.status).toBe(429);
      expect((await fourth.json()).error).toContain("waiting to be checked");
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
    const gets = ["/admin/api/revenue", "/admin/api/revenue.csv", "/admin/api/revenue.pdf", "/admin/api/enquiries", "/admin/api/enquiries/seen", "/admin/api/enquiries/" + id + "/resume", "/admin/api/payments", "/admin/api/payments/" + id + "/receipt?download=1", "/admin/api/onboarding", "/admin/api/onboarding/" + id + "/aadhaar"];
    for (const path of gets) {
      const r = await get(locked, path, { cookie: aide });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toContain("Only the owner");
    }
    // the owner's interview sheet too; signed out, it shows the sign-in page
    expect((await get(locked, "/admin/praneeth", { cookie: aide })).status).toBe(403);
    expect(await (await get(locked, "/admin/praneeth", { cookie })).text()).toContain("Praneeth's interviews");
    expect(await (await get(locked, "/admin/praneeth")).text()).toContain("/assets/login");
    for (const path of ["/admin/api/enquiries/seen", "/admin/api/enquiries/delete", "/admin/api/payments/decide", "/admin/api/onboarding/delete"])
      expect((await postJson(locked, path, { id }, { cookie: aide })).status).toBe(403);
    // the owner still gets them (the made-up id isn't there, so its file is a 404, not a 403)
    for (const path of ["/admin/api/enquiries", "/admin/api/enquiries/seen", "/admin/api/payments", "/admin/api/revenue", "/admin/api/revenue.csv", "/admin/api/revenue.pdf"])
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
    expect(page).toContain('<button hidden type="button" id="mPay"');
    expect(page).toContain('<button hidden type="button" id="mOnb"');
    expect(page).toContain('<button hidden type="button" data-go="rev"');
    // nor the ⋯ menu: the aide class hides it and keeps the Alerts bell in the header
    expect(page).toContain('<body class="aide">');
    expect(page).toContain('<nav class="bnav b3"');
    // the Candidates address opens the calendar for them
    const allowPage = boot(await (await get(locked, "/admin/allowlist", { cookie: aide })).text());
    expect(allowPage.owner).toBe(false);
    expect(allowPage.tab).toBe("cal");
    const ownerPage = await (await get(locked, "/admin", { cookie })).text();
    expect(ownerPage).not.toContain("<button hidden");
    expect(ownerPage).not.toContain('class="aide"');
    expect(ownerPage).toContain('<nav class="bnav"');
    // the live state leaves out when enquiries came in and how many payments there are
    const mine = await (await get(locked, "/admin/api/state", { cookie: aide })).json();
    expect(mine.owner).toBe(false);
    expect(mine.enquiries).toBeUndefined();
    expect(mine.payments).toBeUndefined();
    expect(mine.onboarding).toBeUndefined();
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
    // they can't download the backup at all; the owner's has enquiries and payments
    expect((await get(locked, "/admin/backup.json", { cookie: aide })).status).toBe(403);
    const full = await (await get(locked, "/admin/backup.json", { cookie })).json();
    expect(Object.keys(full.files)).toEqual(expect.arrayContaining(["enquiries.json", "payments.json", "onboarding.json"]));
    // a device's alerts are recorded for the admin who turned them on, so enquiry and payment alerts go only to owners'
    const endpoint = "https://fcm.googleapis.com/fcm/send/aide-device";
    const sub = { endpoint, keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) }, label: "Test" };
    const view = await (await postJson(locked, "/admin/api/push/subscribe", sub, { cookie: aide })).json();
    expect(view.endpoints).toEqual([endpoint]);
    expect(view.yours).toEqual([endpoint]);
    // other admins' devices aren't listed, only counted, and can't be turned off or tested by anyone else
    const ownerView = await (await get(locked, "/admin/api/push", { cookie })).json();
    expect(ownerView.yours).not.toContain(endpoint);
    expect(ownerView.endpoints).not.toContain(endpoint);
    expect(ownerView.devices).toBe(view.devices);
    expect((await postJson(locked, "/admin/api/push/test", { endpoint }, { cookie })).status).toBe(404);
    await postJson(locked, "/admin/api/push/unsubscribe", { endpoint }, { cookie });
    expect(JSON.parse(readFileSync(join(locked.dir, "push.json"), "utf8")).subs.find((x: any) => x.endpoint === endpoint).email).toBe("aide@example.com");
    await postJson(locked, "/admin/api/push/unsubscribe", { endpoint }, { cookie: aide });
    expect((await postJson(locked, "/admin/api/admins", { emails: [] }, { cookie })).status).toBe(200);
  });

  test("only owners see and change admins, unavailable times and supporter names; other admins are refused", async () => {
    const cookie = ownerCookie;
    await postJson(locked, "/admin/api/admins", { emails: ["aide2@example.com", "aide3@example.com"] }, { cookie });
    const aide = await signIn(locked, "aide2@example.com");
    const owners = ["boss@example.com", "chief@example.com", OWNER];
    const before = { owners, emails: ["aide2@example.com", "aide3@example.com"] };
    const refused = "Only the owner can open this.";
    const list = await get(locked, "/admin/api/admins", { cookie: aide });
    expect(list.status).toBe(403);
    expect((await list.json()).error).toBe(refused);
    // adding, removing another admin, or trying to change the owners are all refused
    for (const emails of [["aide2@example.com", "aide3@example.com", "new@example.com"], ["aide2@example.com"], ["aide2@example.com", "aide3@example.com", "boss@example.com"], []]) {
      const r = await postJson(locked, "/admin/api/admins", { emails }, { cookie: aide });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe(refused);
    }
    // so are unavailable times, renaming supporters and the Candidates list, before the body is read
    const day = Date.now() + 3 * 86400000;
    for (const [path, body] of [
      ["/admin/api/unavailable", { startMs: day, endMs: day + 3600000 }],
      ["/admin/api/unavailable/delete", { id: "x" }],
      ["/admin/api/interviewer-names", { list: [{ to: "Someone" }] }],
      ["/admin/api/allowlist", { enabled: false }],
    ] as const)
      expect((await postJson(locked, path, body, { cookie: aide })).status).toBe(403);
    for (const path of ["/admin/api/allowlist", "/admin/export.csv"]) {
      expect((await get(locked, path, { cookie: aide })).status).toBe(403);
      expect((await get(locked, path, { cookie })).status).toBe(200);
    }
    // recording who supported an interview is still theirs
    const assign = await fetch(locked.url + "/admin/api/interviewers", { method: "PUT", headers: { "Content-Type": "application/json", cookie: aide }, body: JSON.stringify({ set: {} }) });
    expect(assign.status).not.toBe(403);
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

  test("booking the next round with a company marks the round before it Cleared, unless an admin already decided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-next-"));
    const past = istMidnight() - 24 * HOUR + 10 * HOUR;
    const round = (n: number, email: string, company: string, extra: Record<string, unknown> = {}) => ({
      ...booking, id: "00000000-0000-0000-0000-0000000001" + String(n).padStart(2, "0"), email, company, round: "1st round",
      start: new Date(past).toISOString(), end: new Date(past + 30 * 60000).toISOString(), ...extra,
    });
    const rounds = [
      round(1, "asha@example.com", "Google"), // no result yet: becomes Cleared
      round(2, "ravi@example.com", "Infosys", { outcome: "rejected", outcomeAt: new Date(past).toISOString() }), // stays Rejected
      round(3, "meena@example.com", "TCS", { outcome: "hold", outcomeAt: new Date(past).toISOString() }), // On hold: becomes Cleared
      round(4, "arun@example.com", "Amazon"), // the next round is with another company: untouched
      round(5, "kiran@example.com", "Wipro", { missed: "noshow", missedAt: new Date(past).toISOString() }), // a no-show: untouched
      round(6, "neha@example.com", "Adobe", { start: new Date(FUTURE).toISOString(), end: new Date(FUTURE + 30 * 60000).toISOString() }), // not held yet
    ];
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: rounds }));
    const srv = await start(4319, {}, dir);
    try {
      const days = await (await get(srv, "/api/days?duration=30")).json();
      const slots: number[] = days.days.filter((d: any) => d.open).flatMap((d: any) => d.slots).filter((ms: number) => ms > FUTURE + HOUR);
      const book = async (i: number, email: string, company: string) =>
        (await bookForm(srv, { name: "Someone", email, company, round: "2nd round", duration: 30, startMs: slots[i] })).status;
      const saved = (n: number) => JSON.parse(readFileSync(join(dir, "bookings.json"), "utf8")).bookings.find((b: any) => b.id === rounds[n - 1].id);
      expect(await book(0, "Asha@Example.com", "google")).toBe(200);
      expect(await book(1, "ravi@example.com", "Infosys")).toBe(200);
      expect(await book(2, "meena@example.com", "TCS")).toBe(200);
      expect(await book(3, "arun@example.com", "Microsoft")).toBe(200);
      expect(await book(4, "kiran@example.com", "Wipro")).toBe(200);
      expect(await book(5, "neha@example.com", "Adobe")).toBe(200);
      expect(saved(1)).toMatchObject({ outcome: "cleared", outcomeBy: "next-round" });
      expect(saved(2).outcome).toBe("rejected");
      expect(saved(3)).toMatchObject({ outcome: "cleared", outcomeBy: "next-round" });
      expect(saved(4).outcome).toBeUndefined();
      expect(saved(5).outcome).toBeUndefined();
      expect(saved(5).missed).toBe("noshow");
      expect(saved(6).outcome).toBeUndefined();
      // the admin page sees it, and an admin's own choice replaces the automatic one
      const state = await (await get(srv, "/admin/api/state")).json();
      expect(state.events.find((e: any) => e.id === rounds[0].id)).toMatchObject({ outcome: "cleared", outcomeBy: "next-round" });
      expect((await postJson(srv, "/admin/api/round-status", { id: rounds[0].id, status: "hold" })).status).toBe(200);
      expect(saved(1).outcome).toBe("hold");
      expect(saved(1).outcomeBy).toBeUndefined();
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

  test("/praneeth is a sheet of the interviews Praneeth takes: a row per candidate and company, a cell per round", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-sheet-"));
    const day = (n: number, h = 10) => new Date(istMidnight() + n * 24 * HOUR + h * HOUR).toISOString();
    const b = (n: number, name: string, email: string, company: string, round: string, start: string, extra = {}) => ({
      ...booking, id: "20000000-0000-0000-0000-" + String(n).padStart(12, "0"), name, email, company, round, start, end: start, ...extra,
    });
    const rows = [
      b(1, "Jeevan", "jeevan@example.com", "PwC", "1st round", day(-9), { outcome: "cleared" }),
      b(2, "Jeevan", "jeevan@example.com", "PwC Pvt Ltd", "2nd round", day(-5, 11.5), { outcome: "hold" }),
      b(3, "Jeevan", "jeevan@example.com", "PwC", "HR round", day(2)),
      b(4, "Syam", "syam@example.com", "Trianz", "1st round", day(-3), { outcome: "rejected" }),
      b(5, "Rohit", "rohit@example.com", "Paytm", "1st round", day(-2)), // only Hareesh's: not listed
      b(6, "Mohan", "mohan@example.com", "KPMG", "1st round", day(-1), { missed: "noshow" }),
      b(7, "Mohan", "mohan@example.com", "Ey", "1st round", day(-1), { cancelled: true }),
      b(8, "Syam", "syam@example.com", "Trianz", "2nd round", day(-2)),
    ];
    writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
    writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: rows }));
    const assign = { [rows[0].id]: "Praneeth", [rows[1].id]: "Praneeth", [rows[3].id]: "praneeth", [rows[4].id]: "Hareesh", [rows[6].id]: "Praneeth", [rows[7].id]: "Hareesh" };
    writeFileSync(join(dir, "interviewers.json"), JSON.stringify({ names: ["Praneeth", "Hareesh"], assign }));
    const srv = await start(4350, {}, dir);
    try {
      const moved = await fetch(srv.url + "/praneeth", { redirect: "manual" });
      expect(moved.status).toBe(302);
      expect(moved.headers.get("location")).toBe("/admin/praneeth");
      const r = await get(srv, "/admin/praneeth");
      expect(r.headers.get("cache-control")).toBe("no-store");
      const html = await r.text();
      expect(html).toContain('<script src="/assets/sheet.');
      const sheet = boot(html);
      expect(sheet.columns).toBe(3) // always at least three round columns, like the sheet;
      // only Praneeth's rounds, newest first, one PwC row for both spellings: Hareesh's rounds, rounds with no supporter
      // recorded (the upcoming HR round, Mohan's no-show) and the cancelled Ey round aren't there
      expect(sheet.rows.map((x: any) => x.candidate + " · " + x.company)).toEqual(["Syam · Trianz", "Jeevan · PwC"]);
      const [trianz, pwc] = sheet.rows;
      expect(pwc.rounds.map((c: any) => c.result)).toEqual(["cleared", "hold"]);
      expect(pwc.rounds[1].when).toMatch(/^\d+(st|nd|rd|th) [A-Z][a-z]+ (\d{4} )?11:30am$/);
      expect(pwc.rounds[0].when).toMatch(/ 10am$/);
      expect(trianz.rounds).toEqual([{ when: expect.any(String), round: "1st round", result: "rejected" }]);
    } finally {
      srv.proc.kill();
    }
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

test("shared links of every public page get a preview with the picture at /og.jpg, also when asked with HEAD", async () => {
  for (const [path, title] of [
    ["/", "Hi&lt;Techie&gt; · Job assistance"],
    ["/booking", "Book an interview slot"],
    ["/enquiry", "Interview support"],
    ["/payment", "Payment · "],
    ["/onboarding", "Onboarding · "],
  ]) {
    const html = await (await get(open, path)).text();
    expect(html).toContain('<meta property="og:image" content="https://hi-techie.dev/og.jpg?v=2">');
    expect(html).toContain(title);
    expect(html).not.toContain("__OG__");
    const head = await fetch(open.url + path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  }
  const file = readFileSync(join(ROOT, "public/og.jpg"));
  const r = await get(open, "/og.jpg?v=2");
  expect(r.headers.get("content-type")).toBe("image/jpeg");
  expect(Buffer.from(await r.arrayBuffer()).equals(file)).toBe(true);
  const head = await fetch(open.url + "/og.jpg", { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe(String(file.length));
});

describe("backups", () => {
  const sent: any[] = [];
  let resend: ReturnType<typeof Bun.serve>;
  let srv: Srv;
  const env = { RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4314/emails", BACKUP_EMAIL: "owner@example.com", BACKUP_HOUR: "0", ADMIN_EMAILS: "owner@example.com" };
  const istDay = (daysAgo = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() - daysAgo * 24 * HOUR));
  const RESUME = new TextEncoder().encode("%PDF-1.4\n% a resume in the backup\n");
  const ENQ = {
    id: "40000000-0000-0000-0000-000000000001", name: "Asha Rao", email: "asha@example.com", phone: "9876543210", tech: "Java", experience: "3 years",
    resume: { file: "40000000-0000-0000-0000-000000000001.pdf", name: "cv.pdf", type: "application/pdf", size: RESUME.length },
  };
  // one sign-in for the whole block (codes are rate limited); the session outlives restarts
  let signedIn = "";
  const ownerCookie = async () => {
    if (signedIn) return signedIn;
    expect((await postJson(srv, "/admin/login/code", { email: "owner@example.com" })).status).toBe(200);
    const code = sent.at(-1).subject.match(/(\d{6})$/)[1];
    const ok = await postJson(srv, "/admin/login", { email: "owner@example.com", code });
    return (signedIn = ok.headers.get("set-cookie")!.split(";")[0]!);
  };
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(30);
  };
  beforeAll(async () => {
    resend = Bun.serve({ port: 4314, fetch: async (req) => (sent.push(await req.json()), Response.json({ id: "x" })) });
    // one enquiry with its resume on the volume, for the backups to carry
    const dir = mkdtempSync(join(tmpdir(), "booking-form-"));
    seed(dir);
    writeFileSync(join(dir, "enquiries.json"), JSON.stringify({ enquiries: [{ ...ENQ, createdAt: new Date().toISOString() }], seen: {} }));
    mkdirSync(join(dir, "resumes"));
    writeFileSync(join(dir, "resumes", ENQ.resume.file), RESUME);
    srv = await start(4313, env, dir);
    // the server records the day in backup-state.json just after the email goes out; wait for both, or a quick
    // restart in the next tests could land in between and send the backup a second time
    const stateFile = join(srv.dir, "backup-state.json");
    await waitFor(() => sent.length > 0 && existsSync(stateFile) && readFileSync(stateFile, "utf8").includes('"emailed"'));
  });
  afterAll(() => {
    srv?.proc.kill();
    resend?.stop(true);
  });

  test("the weekly backup is emailed with the bookings CSV and the data with the resumes, without the push keys", () => {
    expect(sent.length).toBe(1);
    const mail = sent[0];
    expect(mail.to).toEqual(["owner@example.com"]);
    expect(mail.subject).toBe("Backup: Hi-Techie bookings \u2013 " + istDay());
    const files = Object.fromEntries(mail.attachments.map((a: any) => [a.filename, Buffer.from(a.content, "base64").toString("utf8")]));
    expect(Object.keys(files).sort()).toEqual(["backup-" + istDay() + ".json", "bookings-" + istDay() + ".csv"]);
    expect(files["bookings-" + istDay() + ".csv"]).toContain("Priya Sharma,priya@example.com,Google,1st round");
    const data = JSON.parse(files["backup-" + istDay() + ".json"]);
    expect(data.app).toBe("booking-form");
    expect(Object.keys(data.files).sort()).toEqual(["admins.json", "allowlist.json", "bookings.json", "enquiries.json", "interviewers.json", "onboarding.json", "payments.json", "results.json", "secret.json", "unavailable.json"]);
    expect(data.files["bookings.json"].bookings.length).toBe(61);
    expect(data.files["secret.json"].key).toBe(KEY);
    expect(Object.keys(data.uploads)).toEqual(["resumes/" + ENQ.resume.file]);
    expect(Buffer.from(data.uploads["resumes/" + ENQ.resume.file], "base64").equals(Buffer.from(RESUME))).toBe(true);
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

  test("the email waits a week after the last one; the snapshot is still daily", async () => {
    const restart = async (state: object) => {
      writeFileSync(join(srv.dir, "backup-state.json"), JSON.stringify(state));
      srv.proc.kill();
      await srv.proc.exited;
      srv = await start(4313, env, srv.dir);
    };
    await restart({ saved: "", emailed: istDay(6) });
    await waitFor(() => readFileSync(join(srv.dir, "backup-state.json"), "utf8").includes('"saved":"' + istDay() + '"'));
    await Bun.sleep(200);
    expect(sent.length).toBe(1);
    expect(JSON.parse(readFileSync(join(srv.dir, "backup-state.json"), "utf8")).emailed).toBe(istDay(6));
    await restart({ saved: istDay(), emailed: istDay(7) });
    await waitFor(() => sent.length > 1 && readFileSync(join(srv.dir, "backup-state.json"), "utf8").includes('"emailed":"' + istDay() + '"'));
    expect(sent.length).toBe(2);
    expect(sent[1].subject).toBe("Backup: Hi-Techie bookings \u2013 " + istDay());
  });

  test("the admin can download a backup, and only when signed in", async () => {
    expect((await get(srv, "/admin/backup.json")).status).toBe(401);
    const r = await get(srv, "/admin/backup.json", { cookie: await ownerCookie() });
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="backup-' + istDay() + '.json"');
    const data = await r.json();
    expect(data.files["bookings.json"].bookings.length).toBe(61);
    expect(data.files["push.json"]).toBeUndefined();
    expect(data.files["unavailable.json"]).toEqual({ blocks: [] });
    expect(Object.keys(data.uploads)).toEqual(["resumes/" + ENQ.resume.file]);
  });

  test("the owner restores a backup from the admin page: the data, then each resume", async () => {
    const cookie = await ownerCookie();
    const backup = await (await get(srv, "/admin/backup.json", { cookie })).json();
    const post = (path: string, body: BodyInit, type: string, headers: Record<string, string> = { cookie }) =>
      fetch(srv.url + path, { method: "POST", body, headers: { "content-type": type, ...headers } });
    expect((await post("/admin/api/restore", JSON.stringify(backup), "application/json", {})).status).toBe(401);
    expect((await post("/admin/api/restore", JSON.stringify({ app: "other", files: {} }), "application/json")).status).toBe(400);
    // the site lost its data: one booking left and no resume
    writeFileSync(join(srv.dir, "bookings.json"), JSON.stringify({ bookings: [booking] }));
    rmSync(join(srv.dir, "resumes", ENQ.resume.file));
    const { uploads, ...data } = backup;
    const r = await post("/admin/api/restore", JSON.stringify(data), "application/json");
    expect(r.status).toBe(200);
    expect((await r.json()).bookings).toBe(61);
    expect(JSON.parse(readFileSync(join(srv.dir, "bookings.json"), "utf8")).bookings.length).toBe(61);
    expect(JSON.parse(readFileSync(join(srv.dir, "bookings.json.pre-restore"), "utf8")).bookings.length).toBe(1);
    const bytes = Buffer.from(uploads["resumes/" + ENQ.resume.file], "base64");
    expect((await post("/admin/api/restore-file?path=" + encodeURIComponent("../secret.json"), bytes, "application/octet-stream")).status).toBe(400);
    expect((await post("/admin/api/restore-file?path=resumes/" + ENQ.resume.file, bytes, "text/plain")).status).toBe(415);
    expect((await post("/admin/api/restore-file?path=resumes/" + ENQ.resume.file, bytes, "application/octet-stream")).status).toBe(200);
    expect(readFileSync(join(srv.dir, "resumes", ENQ.resume.file)).equals(Buffer.from(RESUME))).toBe(true);
    // ID cards from onboarding forms are restored into their own folder
    expect((await post("/admin/api/restore-file?path=id-cards/" + ENQ.id + "-pan.pdf", bytes, "application/octet-stream")).status).toBe(200);
    expect(readFileSync(join(srv.dir, "id-cards", ENQ.id + "-pan.pdf")).equals(Buffer.from(RESUME))).toBe(true);
    // a file that isn't what its name says (or a kind its form doesn't take) is refused
    expect((await post("/admin/api/restore-file?path=id-cards/" + ENQ.id + "-pan.jpg", bytes, "application/octet-stream")).status).toBe(400);
    expect((await post("/admin/api/restore-file?path=resumes/x.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]), "application/octet-stream")).status).toBe(
      400,
    );
    // the owner is still signed in, and the server serves the restored data
    expect((await (await get(srv, "/admin/api/bookings", { cookie })).json()).bookings.length).toBe(61);
    expect((await get(srv, "/admin/api/enquiries/" + ENQ.id + "/resume", { cookie })).status).toBe(200);
  });

  test("big backups are split over several emails, and the restore script takes all the parts", async () => {
    // two resumes and room for one per email: the data and the newer resume, then the older resume
    const dir = mkdtempSync(join(tmpdir(), "booking-form-"));
    seed(dir);
    const second = { ...ENQ, id: "40000000-0000-0000-0000-000000000002", resume: { ...ENQ.resume, file: "40000000-0000-0000-0000-000000000002.pdf" } };
    writeFileSync(
      join(dir, "enquiries.json"),
      JSON.stringify({ enquiries: [{ ...ENQ, createdAt: new Date(Date.now() - HOUR).toISOString() }, { ...second, createdAt: new Date().toISOString() }], seen: {} }),
    );
    mkdirSync(join(dir, "resumes"));
    for (const e of [ENQ, second]) writeFileSync(join(dir, "resumes", e.resume.file), RESUME);
    const before = sent.length;
    const big = await start(4329, { ...env, BACKUP_FILES_MB: String(RESUME.length / 1024 / 1024) }, dir);
    try {
      await waitFor(() => sent.length >= before + 2);
      const mails = sent.slice(before);
      expect(mails.map((m) => m.subject)).toEqual([1, 2].map((i) => "Backup: Hi-Techie bookings \u2013 " + istDay() + " (" + i + " of 2)"));
      const parts = mails.map((m) => JSON.parse(Buffer.from(m.attachments.find((a: any) => a.filename.endsWith(".json")).content, "base64").toString("utf8")));
      expect(mails[0].attachments.map((a: any) => a.filename).sort()).toEqual(["backup-" + istDay() + "-part1.json", "bookings-" + istDay() + ".csv"]);
      expect(parts.map((p) => [p.part, p.parts, !!p.files, Object.keys(p.uploads)])).toEqual([
        [1, 2, true, ["resumes/" + second.resume.file]],
        [2, 2, false, ["resumes/" + ENQ.resume.file]],
      ]);
      const out = mkdtempSync(join(tmpdir(), "booking-form-restore-"));
      const files = parts.map((p, i) => (writeFileSync(join(out, "p" + i + ".json"), JSON.stringify(p)), join(out, "p" + i + ".json")));
      const proc = Bun.spawn(["bun", "run", join(ROOT, "scripts/restore.ts"), files[1]!, files[0]!, out], { stdout: "ignore", stderr: "inherit" });
      expect(await proc.exited).toBe(0);
      for (const e of [ENQ, second]) expect(existsSync(join(out, "resumes", e.resume.file))).toBe(true);
      expect(JSON.parse(readFileSync(join(out, "enquiries.json"), "utf8")).enquiries.length).toBe(2);
    } finally {
      big.proc.kill();
    }
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

describe("monthly revenue report", () => {
  const sent: any[] = [];
  let resend: ReturnType<typeof Bun.serve>;
  let srv: Srv;
  const env = { RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4323/emails", ADMIN_EMAILS: "owner@example.com", MONTHLY_REPORT: "", REPORT_HOUR: "0" };
  // last month and the one before, in India time; payments at noon IST on a given day
  const ist = new Date(Date.now() + 330 * 60000);
  const monthAgo = (n: number) => new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - n, 1));
  const key = (d: Date) => d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
  const [last, before] = [monthAgo(1), monthAgo(2)];
  const at = (m: Date, day: number) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), day, 12) - 330 * 60000).toISOString();
  const name = (m: Date) => m.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const pay = (n: number, who: string, amount: number, createdAt: string, decision?: string) => ({
    id: "40000000-0000-0000-0000-" + String(n).padStart(12, "0"), name: who, email: who.toLowerCase() + "@example.com", amount, installment: "advance",
    createdAt, ...(decision ? { decision } : {}), receipt: { file: "none.png", name: "r.png", type: "image/png", size: 10 },
  });
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(30);
  };
  beforeAll(async () => {
    resend = Bun.serve({ port: 4323, fetch: async (req) => (sent.push(await req.json()), Response.json({ id: "x" })) });
    const dir = mkdtempSync(join(tmpdir(), "booking-form-report-"));
    seed(dir);
    const payments = [
      pay(1, "Kiran", 20000, at(last, 3), "confirmed"),
      pay(2, "Kiran", 10000, at(last, 17), "confirmed"),
      pay(3, "Meena", 15000, at(last, 17), "confirmed"),
      pay(4, "Ravi", 7000, at(last, 20)), // pending
      pay(5, "Sunil", 99000, at(last, 21), "discarded"),
      pay(6, "Meena", 30000, at(before, 9), "confirmed"),
      pay(7, "Asha", 5000, new Date().toISOString(), "confirmed"), // this month: in a later report
    ];
    writeFileSync(join(dir, "payments.json"), JSON.stringify({ payments }));
    srv = await start(4322, env, dir);
    await waitFor(() => sent.length > 0 && existsSync(join(dir, "report-state.json")));
  });
  afterAll(() => {
    srv?.proc.kill();
    resend?.stop(true);
  });

  test("the owners get last month's report, with its confirmed revenue against the month before", () => {
    const reports = sent.filter((m) => m.subject.startsWith("Revenue report"));
    expect(reports.length).toBe(1);
    const mail = reports[0];
    expect(mail.to).toEqual(["owner@example.com"]);
    expect(mail.subject).toBe("Revenue report: " + name(last) + " \u2013 \u20b945,000");
    expect(mail.html).toContain("\u25b2 50% from \u20b930,000 in " + before.toLocaleString("en-US", { month: "long", timeZone: "UTC" }));
    expect(mail.html).toContain("\u20b97,000</b> from 1 payment");
    expect(mail.html).toContain("Kiran");
    expect(mail.html).not.toContain("Sunil");
    expect(mail.html).not.toContain("Asha");
    expect(mail.html).not.toContain("<svg");
    expect(mail.html).not.toContain("<script");
    expect(mail.text).toContain("Confirmed since the first payment: \u20b975,000");
    expect(mail.text).toContain("Best day: " + last.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) + " 17, \u20b925,000");
    expect(mail.attachments.map((a: any) => a.filename)).toEqual(["payments-" + key(last) + ".csv", "revenue-report-" + key(last) + ".pdf"]);
    const pdf = pdfText(Buffer.from(mail.attachments[1].content, "base64"));
    expect(pdf).toContain(name(last));
    expect(pdf).toContain("\u20b945,000");
    expect(pdf).toContain("Meena");
    const csv = Buffer.from(mail.attachments[0].content, "base64").toString("utf8").trim().split("\r\n");
    expect(csv.length).toBe(5); // the header, three confirmed payments and the pending one
    expect(JSON.parse(readFileSync(join(srv.dir, "report-state.json"), "utf8"))).toEqual({ sent: key(last) });
  });

  test("a restart doesn't send it again", async () => {
    srv.proc.kill();
    await srv.proc.exited;
    srv = await start(4322, env, srv.dir);
    await Bun.sleep(400);
    expect(sent.filter((m) => m.subject.startsWith("Revenue report")).length).toBe(1);
  });
});

describe("hardening", () => {
  let bare: Srv;
  const PDF = new TextEncoder().encode("%PDF-1.4\n% a tiny resume\n");
  const enquiry = (headers: Record<string, string> = {}) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ name: "Asha Rao", email: "asha@example.com", phone: "+91 98765 43210", tech: "Java", experience: "3 years", genuine: "yes" })) f.set(k, v);
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

describe("deleting an onboarding form", () => {
  test("needs a code emailed to the owner, and takes the candidate's invite screenshots with it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "booking-form-delete-"));
    seed(dir);
    const card = (id: string, kind: string) => ({ file: id + "-" + kind + ".jpg", name: kind + ".jpg", type: "image/jpeg", size: 3 });
    const formId = "20000000-0000-0000-0000-000000000001";
    writeFileSync(
      join(dir, "onboarding.json"),
      JSON.stringify({
        forms: [{ id: formId, name: "Ravi Kumar", email: "ravi@example.com", phone: "98450 12345", tech: "Java", experience: "3 years", createdAt: new Date().toISOString(), aadhaar: card(formId, "aadhaar"), pan: card(formId, "pan") }],
      }),
    );
    const bookingsFile = join(dir, "bookings.json");
    const all = JSON.parse(readFileSync(bookingsFile, "utf8"));
    const inviteOf = (id: string) => ({ file: id + "-invite.png", name: "invite.png", type: "image/png", size: PNG.length });
    const mine = { ...booking, id: "30000000-0000-0000-0000-000000000001", email: "Ravi@Example.com", invite: inviteOf("30000000-0000-0000-0000-000000000001"), hrEmails: ["hr@acme.com"], inviteRead: true };
    const other = { ...booking, id: "30000000-0000-0000-0000-000000000002", email: "someone@example.com", invite: inviteOf("30000000-0000-0000-0000-000000000002") };
    all.bookings.push(mine, other);
    writeFileSync(bookingsFile, JSON.stringify(all));
    mkdirSync(join(dir, "invites"));
    for (const b of [mine, other]) writeFileSync(join(dir, "invites", b.invite.file), PNG);
    const s = await start(4351, lockedEnv, dir);
    try {
      const cookie = await signIn(s, OWNER);
      const send = (path: string, body: unknown) => postJson(s, path, body, { cookie });
      // no code, or a code nobody asked for, deletes nothing
      expect((await send("/admin/api/onboarding/delete", { id: formId })).status).toBe(403);
      const asked = await (await send("/admin/api/onboarding/delete-code", { id: formId })).json();
      expect(asked).toEqual({ needed: true, to: "ow…@example.com" });
      const mail = mails.filter((m) => m.to[0] === OWNER).at(-1);
      expect(mail.subject).toMatch(/^Delete code: \d{6}$/);
      const code = mail.subject.slice(-6);
      const wrong = await send("/admin/api/onboarding/delete", { id: formId, code: code === "000000" ? "111111" : "000000" });
      expect(wrong.status).toBe(403);
      expect((await wrong.json()).error).toContain("isn't right");
      expect(existsSync(join(dir, "invites", mine.invite.file))).toBe(true);
      expect((await send("/admin/api/onboarding/delete", { id: formId, code })).status).toBe(200);
      // the form and the candidate's invite are gone; the HR details read from it and other candidates' invites stay
      expect(JSON.parse(readFileSync(join(dir, "onboarding.json"), "utf8")).forms).toEqual([]);
      expect(existsSync(join(dir, "invites", mine.invite.file))).toBe(false);
      expect(existsSync(join(dir, "invites", other.invite.file))).toBe(true);
      const saved = JSON.parse(readFileSync(bookingsFile, "utf8")).bookings;
      expect(saved.find((b: any) => b.id === mine.id)).toMatchObject({ hrEmails: ["hr@acme.com"] });
      expect(saved.find((b: any) => b.id === mine.id).invite).toBeUndefined();
      expect(saved.find((b: any) => b.id === other.id).invite).toEqual(other.invite);
      // a used code doesn't work twice
      expect((await send("/admin/api/onboarding/delete", { id: formId, code })).status).toBe(404);
    } finally {
      s.proc.kill();
    }
  });
});
