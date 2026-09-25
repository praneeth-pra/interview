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

let open: Srv;
let locked: Srv;
beforeAll(async () => {
  [open, locked] = await Promise.all([
    start(4311, { HOST_NAME: "Hi<Techie>" }),
    start(4312, { ADMIN_PASSWORD: "pw123", ADMIN_LOGIN: "on" }),
  ]);
});
afterAll(() => {
  open?.proc.kill();
  locked?.proc.kill();
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
  test("serves the shell with fingerprinted assets, a strict policy and revalidation", async () => {
    const r = await get(open, "/");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-cache");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self';");
    expect(r.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(assetsIn(html)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/assets\/book\.[0-9a-f]{10}\.css$/), expect.stringMatching(/^\/assets\/book\.[0-9a-f]{10}\.js$/)]));
    expect(html).toContain('<link rel="preload" href="/api/days?duration=30" as="fetch" crossorigin>');
    const again = await get(open, "/", { "if-none-match": r.headers.get("etag")! });
    expect(again.status).toBe(304);
  });

  test("escapes the host name in the title and in the boot data", async () => {
    const html = await (await get(open, "/")).text();
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
    const pages = [await (await get(open, "/")).text(), await (await get(open, "/admin")).text(), await (await get(open, "/admin/analytics")).text()];
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
    const js = assetsIn(await (await get(open, "/")).text()).find((u) => u.endsWith(".js"))!;
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
    const clash = await post("/api/book", { name: "Other", email: "o@example.com", duration: 30, startMs: slots[0] });
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

  test("large API answers are compressed", async () => {
    const r = await get(open, "/admin/api/bookings", { "accept-encoding": "gzip" });
    expect(r.headers.get("content-encoding")).toBe("gzip");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(gunzipSync(Buffer.from(await r.arrayBuffer())).toString()).bookings.length).toBeGreaterThan(50);
  });
});

describe("admin", () => {
  test("without a session /admin shows the sign-in page and the APIs refuse", async () => {
    const html = await (await get(locked, "/admin")).text();
    expect(html).toContain('id="pw"');
    expect((await get(locked, "/admin/api/state")).status).toBe(401);
  });

  test("signing in gives the admin page, and analytics loads as a same-origin frame", async () => {
    const bad = await fetch(locked.url + "/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    expect(bad.status).toBe(401);
    const ok = await fetch(locked.url + "/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw123" }) });
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    const admin = await get(locked, "/admin", { cookie });
    const html = await admin.text();
    expect(boot(html)).toEqual({ tab: "cal", login: true });
    expect(admin.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(boot(await (await get(locked, "/admin/allowlist", { cookie })).text()).tab).toBe("allow");
    const la = await get(locked, "/admin/analytics", { cookie });
    expect(await la.text()).toContain("<title>Person analytics</title>");
    expect(la.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(la.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    const out = await get(locked, "/admin/analytics");
    expect(await out.text()).toContain('id="pw"');
    expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("the admin page has the logo link and the frame points at /admin/analytics", async () => {
    const html = await (await get(open, "/admin")).text();
    expect(html).toContain('<a class="brand" href="/" title="Open the booking page">');
    const js = await (await get(open, assetsIn(html).find((u) => u.endsWith(".js"))!)).text();
    expect(js).toContain('fr.src="/admin/analytics"');
    expect(js).not.toContain("srcdoc");
  });
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
  const env = { RESEND_API_KEY: "test", RESEND_API_URL: "http://127.0.0.1:4314/emails", BACKUP_EMAIL: "owner@example.com", BACKUP_HOUR: "0", ADMIN_PASSWORD: "pw123", ADMIN_LOGIN: "on" };
  const istDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const waitFor = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await Bun.sleep(30);
  };
  beforeAll(async () => {
    resend = Bun.serve({ port: 4314, fetch: async (req) => (sent.push(await req.json()), Response.json({ id: "x" })) });
    srv = await start(4313, env);
    await waitFor(() => sent.length > 0);
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
    expect(Object.keys(data.files).sort()).toEqual(["allowlist.json", "bookings.json", "interviewers.json", "results.json", "secret.json"]);
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
    const ok = await fetch(srv.url + "/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "pw123" }) });
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
