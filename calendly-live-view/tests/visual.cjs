// Visual regression check: runs a base git ref (default origin/main) and the working tree side by side
// on identical seed data, drives the same flows in Chromium at desktop/phone x light/dark, and compares
// every screenshot pixel by pixel. Meant for refactors, where nothing on screen should change.
//
//   NODE_PATH=$(npm root -g) node tests/visual.cjs [--base origin/main] [--only book] [--out /tmp/visual]
//
// Exit code 1 if any screen differs by more than TOLERANCE pixels, or the working tree logs errors the base doesn't.
const { chromium } = require("playwright");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []),
);
const BASE_REF = args.base || "origin/main";
const OUT = args.out || path.join(os.tmpdir(), "booking-form-visual");
const ONLY = args.only ? new RegExp(args.only) : null;
const TOLERANCE = 60;
const APP = path.resolve(__dirname, "..");
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: APP }).toString().trim();
const SUBDIR = path.relative(REPO, APP);
const KEY = "ab".repeat(32);

// ---- seed data: four weeks of bookings around today (IST), a few cancelled / rescheduled ----
function seed(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const people = [
    ["Priya Sharma", "priya@example.com", "Google", "1st round"],
    ["Rahul Verma", "rahul@example.com", "Microsoft", "2nd round"],
    ["Ananya Iyer", "ananya@example.com", "Amazon", "HR"],
    ["Karthik Reddy", "karthik@example.com", "Infosys", "Final"],
    ["Sneha Patel", "sneha@example.com", "Flipkart", "1st round"],
    ["Vikram Singh", "vikram@example.com", "Google", "2nd round"],
    ["Divya Nair", "divya@example.com", "Swiggy", "Technical"],
    ["Arjun Mehta", "arjun@example.com", "Zoho", "1st round"],
  ];
  const ist = new Date(Date.now() + 330 * 60000);
  const midnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) - 330 * 60000;
  const iso = (ms) => new Date(ms).toISOString();
  const bookings = [];
  let n = 0;
  for (let day = -20; day < 7; day++)
    for (const hour of day % 2 === 0 ? [10, 14.5] : [11.5, 16]) {
      const [name, email, company, round] = people[n++ % people.length];
      const duration = [30, 60, 90][n % 3];
      const start = midnight + day * 86400000 + hour * 3600000;
      const b = {
        id: "00000000-0000-0000-0000-" + String(n).padStart(12, "0"),
        name,
        email,
        company,
        round,
        start: iso(start),
        end: iso(start + duration * 60000),
        duration,
        createdAt: iso(start - 3 * 86400000),
        cancelled: false,
        cancelledAt: "",
      };
      if (n % 7 === 0)
        Object.assign(b, {
          cancelled: true,
          cancelledAt: iso(start - 86400000),
          cancelledBy: "candidate",
          cancelReason: "Clash with another interview",
          seq: 1,
        });
      if (n % 5 === 0 && !b.cancelled)
        Object.assign(b, {
          prevStart: b.start,
          prevEnd: b.end,
          rescheduledAt: iso(start - 2 * 86400000),
          rescheduledBy: "candidate",
          seq: 1,
        });
      bookings.push(b);
    }
  const past = bookings.filter((b) => !b.cancelled && Date.parse(b.end) < Date.now()).slice(0, 10);
  const write = (f, d) => fs.writeFileSync(path.join(dir, f), JSON.stringify(d));
  write("bookings.json", { bookings });
  write("interviewers.json", {
    names: ["Praneeth", "Hareesh", "Shiva"],
    assign: Object.fromEntries(past.map((b, i) => [b.id, ["Praneeth", "Hareesh", "Shiva"][i % 3]])),
  });
  write("allowlist.json", { enabled: false, emails: ["priya@example.com", "rahul@example.com", "zara@example.com"] });
  write("secret.json", { key: KEY });
  write("results.json", {
    people: { "priya sharma": { results: { Google: "cleared" }, updated: "2026-09-20T10:00:00Z" } },
  });
  const next = bookings.find((b) => !b.cancelled && Date.parse(b.start) > Date.now() + 86400000);
  const token = crypto
    .createHmac("sha256", KEY)
    .update("manage:" + next.id)
    .digest("hex")
    .slice(0, 32);
  return "/b/" + next.id + "?t=" + token;
}

// ---- servers ----
const procs = [];
// onOutput gets the server's log; with email off, admin sign-in codes are printed there.
async function startServer(dir, port, dataDir, env = {}, onOutput) {
  const p = spawn("bun", ["run", path.join(dir, "src/server.ts")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, RESEND_API_KEY: "", BACKUP_HOUR: "23", ADMIN_OPEN: "1", ...env },
    stdio: ["ignore", onOutput ? "pipe" : "ignore", "ignore"],
  });
  if (onOutput) p.stdout.on("data", (d) => onOutput(String(d)));
  procs.push(p);
  for (let i = 0; i < 200; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return `http://127.0.0.1:${port}`;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server on " + port + " did not start");
}

// ---- flows ----
const wait = (p, ms) => p.waitForTimeout(ms);
// The booking page is at /booking now; origin/main may still serve it at /.
async function gotoBooking(p, s) {
  const r = await p.goto(s.main + "/booking");
  if (r && r.status() === 404) await p.goto(s.main + "/");
}
async function pickTime(p, s, dayIndex = 1, slotIndex = 2) {
  await gotoBooking(p, s);
  await wait(p, 700);
  await p.locator("button.day.open").nth(dayIndex).click();
  await wait(p, 700);
  await p.locator("button.t").nth(slotIndex).click();
  await wait(p, 300);
}
// Contacts (Analytics before): type a name in the search and open the first match. Works on both the old page
// (a dropdown of matches) and the new one (the contacts list filters as you type).
async function pickPerson(p, f, name) {
  await showSearch(p, f);
  await f.locator("#pq").fill(name);
  await f.locator("#plistbox .rrow, #clist .crow").first().click();
}
// On phones the contact search is behind the header's search button (always shown on the old page).
async function showSearch(p, f) {
  if (!(await f.locator("#pq").isVisible())) {
    await p.locator("#qbtn").click();
    await wait(p, 300);
  }
}
async function openStats(p, s) {
  await p.goto(s.main + "/admin");
  await wait(p, 1200);
  await p.locator("#tabStats:visible, .bnav [data-go=stats]:visible").first().click();
  await wait(p, 2200);
}
async function openAgendaPanel(p, s, index = 0) {
  await p.goto(s.main + "/admin");
  await wait(p, 1200);
  await p.locator("#vAg").click();
  await wait(p, 400);
  await p.locator("#agenda button").nth(index).click();
  await wait(p, 1500);
}
const CASES = [
  [
    "book-load",
    async (p, s) => {
      await gotoBooking(p, s);
      await wait(p, 900);
    },
  ],
  [
    "book-60min",
    async (p, s) => {
      await gotoBooking(p, s);
      await wait(p, 700);
      await p.click("#dur60");
      await wait(p, 800);
    },
  ],
  [
    "book-nextmonth",
    async (p, s) => {
      await gotoBooking(p, s);
      await wait(p, 700);
      await p.click("#nextm");
      await wait(p, 600);
    },
  ],
  [
    "book-slots",
    async (p, s) => {
      await pickTime(p, s);
    },
  ],
  [
    "book-form",
    async (p, s) => {
      await pickTime(p, s);
      await p.click("#go");
      await wait(p, 700);
    },
  ],
  [
    "book-form-errors",
    async (p, s) => {
      await pickTime(p, s);
      await p.click("#go");
      await wait(p, 500);
      await p.click("#submitb");
      await wait(p, 600);
    },
  ],
  [
    "book-company-suggest",
    async (p, s) => {
      await pickTime(p, s);
      await p.click("#go");
      await wait(p, 500);
      const c = p.locator("#card input").nth(2);
      await c.click();
      await c.fill("Goo");
      await wait(p, 900);
    },
  ],
  [
    "book-done",
    async (p, s) => {
      await pickTime(p, s, 2, 4);
      await p.click("#go");
      await wait(p, 600);
      const vals = { email: "test.candidate@example.com", name: "Test Candidate", company: "Acme", round: "1st round" };
      for (const inp of await p.locator("#card input:visible").all()) {
        const key = ["id", "name", "autocomplete", "type"].map((a) => inp.getAttribute(a));
        const k = (await Promise.all(key)).join(" ");
        const f = /mail/i.test(k)
          ? "email"
          : /comp|org/i.test(k)
            ? "company"
            : /round/i.test(k)
              ? "round"
              : /name/i.test(k)
                ? "name"
                : null;
        if (f) await inp.fill(vals[f]);
      }
      await p.keyboard.press("Escape");
      await wait(p, 300);
      await p.click("#submitb");
      await wait(p, 1500);
    },
  ],
  [
    "manage",
    async (p, s) => {
      await p.goto(s.main + s.manage);
      await wait(p, 900);
    },
  ],
  [
    "manage-resched",
    async (p, s) => {
      await p.goto(s.main + s.manage + "&a=reschedule");
      await wait(p, 1200);
    },
  ],
  [
    "manage-cancel",
    async (p, s) => {
      await p.goto(s.main + s.manage + "&a=cancel");
      await wait(p, 900);
    },
  ],
  [
    "bad-link",
    async (p, s) => {
      await p.goto(s.main + "/b/00000000-0000-0000-0000-000000000001?t=nope");
      await wait(p, 700);
    },
  ],
  [
    "admin-cal",
    async (p, s) => {
      await p.goto(s.main + "/admin");
      await wait(p, 1500);
    },
  ],
  [
    "admin-prevweek",
    async (p, s) => {
      await p.goto(s.main + "/admin");
      await wait(p, 1200);
      await p.click("#prev");
      await wait(p, 600);
    },
  ],
  [
    "admin-agenda",
    async (p, s) => {
      await p.goto(s.main + "/admin");
      await wait(p, 1200);
      await p.click("#vAg");
      await wait(p, 600);
    },
  ],
  [
    "admin-panel",
    async (p, s) => {
      await openAgendaPanel(p, s, 0);
    },
  ],
  [
    "admin-assign",
    async (p, s) => {
      await openAgendaPanel(p, s, 1);
      const chip = p.locator("#pbody button", { hasText: "Hareesh" }).first();
      if (await chip.count()) {
        await chip.click();
        await wait(p, 1200);
      }
    },
  ],
  [
    "admin-allow",
    async (p, s) => {
      await p.goto(s.main + "/admin/allowlist");
      await wait(p, 1500);
    },
  ],
  [
    "admin-allow-add",
    async (p, s) => {
      await p.goto(s.main + "/admin/allowlist");
      await wait(p, 1200);
      await p.fill("#add", "new.person@example.com, bad-email");
      await p.click("#addb");
      await wait(p, 1000);
    },
  ],
  [
    "admin-download",
    async (p, s) => {
      await p.goto(s.main + "/admin");
      await wait(p, 1200);
      if (await p.locator("#dlBtn:visible").count()) {
        await p.click("#dlBtn");
        await wait(p, 300);
      }
    },
  ],
  [
    "stats-empty",
    async (p, s) => {
      await openStats(p, s);
    },
  ],
  [
    "stats-person",
    async (p, s) => {
      await openStats(p, s);
      const f = p.frameLocator("iframe.la-frame");
      await pickPerson(p, f, "Vikram");
      await wait(p, 1800);
    },
  ],
  [
    "stats-search",
    async (p, s) => {
      await openStats(p, s);
      const f = p.frameLocator("iframe.la-frame");
      await showSearch(p, f);
      const i = f.locator("input").first();
      await i.click();
      await i.fill("Priya");
      await wait(p, 800);
    },
  ],
  [
    "stats-history",
    async (p, s) => {
      await openStats(p, s);
      const f = p.frameLocator("iframe.la-frame");
      await pickPerson(p, f, "Vikram");
      await wait(p, 1800);
      await f.locator("#hist:visible, #tabAbout").first().click();
      await wait(p, 1200);
    },
  ],
  [
    "stats-results",
    async (p, s) => {
      await openStats(p, s);
      const f = p.frameLocator("iframe.la-frame");
      await pickPerson(p, f, "Vikram");
      await wait(p, 1800);
      // the Results panel is gone from Contacts; there this screen shows the contact's About tab
      if (await f.locator("#reslink").count()) {
        await f.locator("#reslink").click();
        await wait(p, 400);
        await f.locator("#rq").fill("o");
        await wait(p, 400);
        await f.locator("#rsug .rrow").first().click();
        await wait(p, 300);
        await f.locator(".rsel2").selectOption("offer");
      } else {
        await f.locator("#tabAbout").click();
      }
      await wait(p, 1500);
    },
  ],
  [
    "login",
    async (p, s) => {
      await p.goto(s.login + "/admin");
      await wait(p, 700);
    },
  ],
  [
    "login-wrong",
    async (p, s) => {
      await p.goto(s.login + "/admin");
      await wait(p, 500);
      // the old page asks for a password; the new one for an email, then the code sent to it
      if (await p.locator("#pw").count()) {
        await p.fill("#pw", "nope");
        await p.click("#go");
      } else {
        // a new address each attempt: codes can be asked for only every 30 seconds per address
        await p.fill("#em", "wrong" + s.attempt("wrong") + "@example.com");
        await p.click("#go");
        await wait(p, 600);
        await p.fill("#code", "000000");
      }
      await wait(p, 800);
    },
  ],
  [
    "login-ok",
    async (p, s) => {
      await p.goto(s.login + "/admin");
      await wait(p, 500);
      if (await p.locator("#pw").count()) {
        await p.fill("#pw", "pw123");
        await p.click("#go");
      } else {
        const email = "admin" + s.attempt("ok") + "@example.com";
        await p.fill("#em", email);
        await p.click("#go");
        await wait(p, 600);
        const codes = [...s.loginLog().matchAll(/sign-in code for (\S+): (\d{6})/g)].filter((m) => m[1] === email);
        await p.fill("#code", codes.at(-1)[2]);
      }
      await wait(p, 2200);
    },
  ],
];
const VIEWS = [
  { tag: "desk", viewport: { width: 1280, height: 860 } },
  { tag: "phone", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
];

// ---- pixel diff, done in the browser so no image libraries are needed ----
async function diff(page, a, b, outPath) {
  return page.evaluate(
    async ({ a, b, outPath }) => {
      const load = (src) =>
        new Promise((ok, err) => {
          const i = new Image();
          i.onload = () => ok(i);
          i.onerror = err;
          i.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      if (ia.width !== ib.width || ia.height !== ib.height)
        return { size: [ia.width, ia.height, ib.width, ib.height], px: Infinity };
      const ctx = (img) => {
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        return x;
      };
      const ca = ctx(ia),
        cb = ctx(ib);
      const da = ca.getImageData(0, 0, ia.width, ia.height),
        db = cb.getImageData(0, 0, ia.width, ia.height).data;
      let px = 0;
      for (let i = 0; i < db.length; i += 4) {
        if (da.data[i] !== db[i] || da.data[i + 1] !== db[i + 1] || da.data[i + 2] !== db[i + 2]) {
          px++;
          da.data[i] = 255;
          da.data[i + 1] = 0;
          da.data[i + 2] = 0;
        }
      }
      if (!px) return { px };
      ca.putImageData(da, 0, 0);
      return { px, image: ca.canvas.toDataURL("image/png"), outPath };
    },
    { a, b, outPath },
  );
}

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "visual-"));
  const baseTree = path.join(tmp, "base");
  execFileSync("git", ["worktree", "add", "--detach", baseTree, BASE_REF], { cwd: REPO, stdio: "ignore" });
  const cleanup = () => {
    for (const p of procs) p.kill();
    try {
      execFileSync("git", ["worktree", "remove", "--force", baseTree], { cwd: REPO, stdio: "ignore" });
    } catch {}
  };
  process.on("exit", cleanup);
  let failed = 0;
  try {
    const dirs = { base: path.join(baseTree, SUBDIR), head: APP };
    const browser = await chromium.launch();
    const scratch = await browser.newPage();
    const fixed = Date.now();
    const variants = VIEWS.flatMap((v) => ["light", "dark"].map((scheme) => ({ ...v, scheme })));
    // One worker per viewport/scheme, each with its own servers and data, so flows that change data stay independent.
    const runVariant = async (v, vi) => {
      const servers = {};
      let port = 5101 + vi * 10;
      for (const which of ["base", "head"]) {
        const data = path.join(tmp, `${vi}-${which}`);
        const manage = seed(data + "-open");
        seed(data + "-login");
        let loginLog = "";
        const attempts = {};
        servers[which] = {
          manage,
          main: await startServer(dirs[which], port++, data + "-open"),
          // both kinds of sign-in are configured: the password one (origin/main) and email codes (this branch)
          login: await startServer(
            dirs[which],
            port++,
            data + "-login",
            { ADMIN_PASSWORD: "pw123", ADMIN_LOGIN: "on", ADMIN_EMAILS: "admin1@example.com admin2@example.com admin3@example.com" },
            (text) => (loginLog += text),
          ),
          loginLog: () => loginLog,
          // counts runs of a flow on this server (a flow runs again when its first screenshot differs)
          attempt: (flow) => (attempts[flow] = (attempts[flow] || 0) + 1),
        };
      }
      const results = [];
      for (const [name, run] of CASES) {
        if (ONLY && !ONLY.test(name)) continue;
        const tag = `${v.tag}-${v.scheme}-${name}`;
        let shots, errors, r, newErrors;
        // Text anti-aliasing occasionally jitters by a few dozen pixels; a real change differs on the retry too.
        for (let attempt = 0; attempt < 2; attempt++) {
          shots = {};
          errors = {};
          await Promise.all(
            ["base", "head"].map(async (which) => {
              const ctx = await browser.newContext({
                viewport: v.viewport,
                isMobile: v.isMobile,
                hasTouch: v.hasTouch,
                colorScheme: v.scheme,
                deviceScaleFactor: 1,
                timezoneId: "Asia/Kolkata",
                serviceWorkers: "block",
                acceptDownloads: true,
              });
              const page = await ctx.newPage();
              await page.clock.setFixedTime(fixed);
              errors[which] = [];
              page.on("pageerror", (e) => errors[which].push("pageerror: " + e.message));
              page.on(
                "console",
                (m) =>
                  m.type() === "error" &&
                  !/status of 40[01]/.test(m.text()) &&
                  errors[which].push("console: " + m.text()),
              );
              try {
                await run(page, servers[which]);
                await page.mouse.move(0, 0); // no leftover hover effects
                await page.evaluate(() => document.fonts.ready);
                shots[which] =
                  "data:image/png;base64," +
                  (await page.screenshot({ fullPage: true, animations: "disabled" })).toString("base64");
              } catch (e) {
                errors[which].push("flow failed: " + e.message.split("\n")[0]);
              }
              await ctx.close();
            }),
          );
          newErrors = errors.head.filter((e) => !errors.base.includes(e));
          r = { px: 0 };
          if (shots.base && shots.head) r = await diff(scratch, shots.base, shots.head);
          else if (shots.base || shots.head) r = { px: Infinity };
          if (r.px <= TOLERANCE || !Number.isFinite(r.px) || newErrors.length) break;
        }
        const bad = r.px > TOLERANCE || newErrors.length > 0 || errors.base.some((e) => e.startsWith("flow failed"));
        if (r.image) fs.writeFileSync(path.join(OUT, tag + "-DIFF.png"), Buffer.from(r.image.split(",")[1], "base64"));
        if (bad) {
          if (shots.base)
            fs.writeFileSync(path.join(OUT, tag + "-base.png"), Buffer.from(shots.base.split(",")[1], "base64"));
          if (shots.head)
            fs.writeFileSync(path.join(OUT, tag + "-head.png"), Buffer.from(shots.head.split(",")[1], "base64"));
        }
        results.push({
          tag,
          px: r.px,
          size: r.size,
          newErrors,
          bad,
          baseFailed: errors.base.filter((e) => e.startsWith("flow failed")),
        });
      }
      return results;
    };
    const all = (await Promise.all(variants.map(runVariant))).flat();
    for (const r of all) {
      if (r.bad) failed++;
      const note = r.px ? ` (${r.size ? "size " + r.size.join("x") : r.px + " px"})` : "";
      console.log(
        `${r.bad ? "DIFF" : "ok  "} ${r.tag}${note}${r.baseFailed.length ? "  [flow also fails on base: " + r.baseFailed[0] + "]" : ""}${r.newErrors.length ? "\n     " + r.newErrors.join("\n     ") : ""}`,
      );
    }
    await browser.close();
    console.log(
      `\n${all.length - failed}/${all.length} screens match ${BASE_REF}` +
        (failed ? `; differences saved in ${OUT}` : ""),
    );
  } finally {
    cleanup();
  }
  process.exit(failed ? 1 : 0);
})();
