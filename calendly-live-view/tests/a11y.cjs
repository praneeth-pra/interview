// Accessibility: runs axe-core (WCAG 2.1 A and AA rules) on every page, at desktop and phone width, in light and dark.
// Fails on any violation, listing each rule once with where it happens.
// Run: NODE_PATH=$(npm root -g) node tests/a11y.cjs   (needs the playwright package; axe-core is a dev dependency)
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const AXE = require.resolve("axe-core/axe.min.js", { paths: [join(__dirname, "..")] });
const PORT = 4331;
const BASE = "http://127.0.0.1:" + PORT;
const LOCKED = "http://127.0.0.1:" + (PORT + 1);
const KEY = "ef".repeat(32);

// A few bookings around today, an enquiry and a payment, so every view has something in it.
const dir = mkdtempSync(join(tmpdir(), "booking-form-a11y-"));
const day = 86400000;
const at = (days, hour) => {
  const d = new Date(Date.now() + days * day);
  d.setUTCHours(hour - 5, 30, 0, 0); // hour:00 IST
  return d;
};
const bookings = [
  ["Priya Sharma", "priya@example.com", "Google", "1st round", 0, 11],
  ["Rahul Verma", "rahul@example.com", "Microsoft", "HR", 1, 14],
  ["Ananya Iyer", "ananya@example.com", "Amazon", "Final", -1, 10],
].map(([name, email, company, round, days, hour], i) => {
  const start = at(days, hour);
  return {
    id: "00000000-0000-0000-0000-00000000000" + (i + 1),
    name,
    email,
    company,
    round,
    start: start.toISOString(),
    end: new Date(+start + 3600000).toISOString(),
    duration: 60,
    createdAt: new Date(+start - 2 * day).toISOString(),
    cancelled: false,
    cancelledAt: "",
  };
});
writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings }));
writeFileSync(join(dir, "secret.json"), JSON.stringify({ key: KEY }));
const resume = { file: "e1.pdf", name: "cv.pdf", type: "application/pdf", size: 1000 };
writeFileSync(
  join(dir, "enquiries.json"),
  JSON.stringify({
    enquiries: [
      { id: "e0000000-0000-0000-0000-000000000001", name: "Asha Rao", email: "asha@example.com", phone: "9876543210", tech: "Java", experience: "3 years", createdAt: new Date().toISOString(), resume },
    ],
    seen: {},
  }),
);
// Unavailable times: tomorrow evening (a band on the calendar) and a whole day later in the week.
const istDay = (days) => new Date(Date.now() + 330 * 60000 + days * day).toISOString().slice(0, 10);
const istAt = (days, minutes) => new Date(Date.parse(istDay(days) + "T00:00:00Z") + (minutes - 330) * 60000).toISOString();
writeFileSync(
  join(dir, "unavailable.json"),
  JSON.stringify({
    blocks: [
      { id: "u1", start: istAt(1, 17 * 60), end: istAt(1, 20 * 60), note: "Dentist", createdAt: new Date().toISOString(), by: "" },
      { id: "u2", start: istAt(3, 0), end: istAt(4, 0), note: "", createdAt: new Date().toISOString(), by: "" },
    ],
  }),
);
const receipt = { file: "p1.png", name: "gpay.png", type: "image/png", size: 1000 };
writeFileSync(
  join(dir, "payments.json"),
  JSON.stringify({
    payments: [
      { id: "p0000000-0000-0000-0000-000000000001", name: "Rahul Verma", email: "rahul@example.com", amount: 5000, installment: "advance", check: "verified", createdAt: new Date().toISOString(), receipt },
    ],
  }),
);
const manage = "/b/" + bookings[1].id + "?t=" + require("node:crypto").createHmac("sha256", KEY).update("manage:" + bookings[1].id).digest("hex").slice(0, 32);

const env = { ...process.env, RESEND_API_KEY: "" };
const server = spawn("bun", ["run", join(__dirname, "../src/server.ts")], { env: { ...env, PORT: String(PORT), DATA_DIR: dir, ADMIN_OPEN: "1" }, stdio: "ignore" });
const locked = spawn("bun", ["run", join(__dirname, "../src/server.ts")], {
  env: { ...env, PORT: String(PORT + 1), DATA_DIR: mkdtempSync(join(tmpdir(), "booking-form-a11y-locked-")), ADMIN_EMAILS: "owner@example.com" },
  stdio: "ignore",
});

const wait = (p, ms) => p.waitForTimeout(ms);
// [name, url, what to do before checking, phone only?]
const screens = [
  ["landing", BASE + "/", null],
  ["booking: calendar", BASE + "/booking", null],
  ["booking: times", BASE + "/booking", async (p) => p.locator("button.day.open").first().click()],
  [
    "booking: details form",
    BASE + "/booking",
    async (p) => {
      await p.locator("button.day.open").first().click();
      await p.locator("button.t").first().click();
      await p.locator("#go").click();
      await p.locator("#card input").first().waitFor();
    },
  ],
  ["manage link", BASE + manage, null],
  ["manage link: cancel", BASE + manage + "&a=cancel", null],
  ["enquiry", BASE + "/enquiry", null],
  ["payment", BASE + "/payment", null],
  ["sign-in", LOCKED + "/admin", null],
  ["admin: calendar", BASE + "/admin", async (p) => p.locator("#status.live").waitFor({ state: "attached" })],
  ["admin: agenda", BASE + "/admin?view=agenda", async (p) => p.locator("#agenda .ag-grid").waitFor()],
  [
    "admin: booking panel",
    BASE + "/admin?view=agenda",
    async (p) => {
      await p.locator("#agenda .ag-i").first().click();
      await p.locator("#panel:not([hidden])").waitFor();
    },
  ],
  [
    "admin: unavailable",
    BASE + "/admin",
    async (p) => {
      await p.locator("#dlBtn").click();
      await p.locator("#mUn").click();
      await p.locator("#pbody .unrow").first().waitFor();
    },
  ],
  ["admin: enquiries", BASE + "/admin?view=enquiries", async (p) => p.locator("#enqBody .enqitem, #enqBody .enqlist").first().waitFor()],
  ["admin: payments", BASE + "/admin?view=payments", async (p) => p.locator("#payBody .paysw").first().waitFor()],
  ["contacts", BASE + "/admin/analytics", async (p) => p.locator("#clist .crow").first().waitFor()],
  [
    "contacts: a person",
    BASE + "/admin/analytics",
    async (p) => {
      await p.locator("#clist .crow").first().click();
      await p.locator("#an:not([hidden]) .aitem").first().waitFor();
    },
  ],
];
const views = [
  ["desktop", { width: 1280, height: 860 }, false],
  ["phone", { width: 390, height: 844 }, true],
];

(async () => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + "/healthz")).ok && (await fetch(LOCKED + "/healthz")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const browser = await chromium.launch();
  const found = new Map(); // rule id -> { impact, help, where: Set }
  let checked = 0;
  for (const [viewName, viewport, mobile] of views)
    for (const scheme of ["light", "dark"]) {
      // bypassCSP only lets the test inject axe; the pages' own policy is checked by the server tests
      const ctx = await browser.newContext({ viewport, colorScheme: scheme, bypassCSP: true, hasTouch: mobile, isMobile: mobile });
      for (const [name, url, prepare] of screens) {
        const p = await ctx.newPage();
        try {
          await p.goto(url);
          await wait(p, 400);
          if (prepare) await prepare(p);
          await wait(p, 500);
          // Contacts is transparent: in the admin it sits in a frame over the admin's background, so give it that here
          if (url.includes("/admin/analytics"))
            await p.evaluate((dark) => (document.documentElement.style.background = dark ? "#161513" : "#f4f2ec"), scheme === "dark");
          await p.addScriptTag({ path: AXE });
          const result = await p.evaluate(() =>
            // @ts-ignore axe is injected above
            axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] }),
          );
          for (const v of result.violations) {
            const entry = found.get(v.id) || { impact: v.impact, help: v.help, where: new Set(), targets: new Set() };
            entry.where.add(name + " (" + viewName + ", " + scheme + ")");
            v.nodes.slice(0, process.env.A11Y_ALL ? 50 : 3).forEach((n) =>
              entry.targets.add(
                (process.env.A11Y_ALL ? "[" + name + ", " + viewName + ", " + scheme + "] " : "") +
                  n.target.join(" ") +
                  (n.failureSummary ? " — " + n.failureSummary.split("\n").slice(1, 2).join("").trim() : ""),
              ),
            );
            found.set(v.id, entry);
          }
          checked++;
        } catch (e) {
          console.log("could not check " + name + " (" + viewName + ", " + scheme + "): " + e.message.split("\n")[0]);
          found.set("check-failed:" + name, { impact: "error", help: e.message.split("\n")[0], where: new Set([viewName + ", " + scheme]), targets: new Set() });
        }
        await p.close();
      }
      await ctx.close();
    }
  await browser.close();
  server.kill();
  locked.kill();
  console.log(checked + " screens checked against WCAG 2.1 A/AA");
  if (!found.size) {
    console.log("no accessibility violations");
    process.exit(0);
  }
  for (const [id, v] of found) {
    console.log("\n" + v.impact.toUpperCase() + "  " + id + ": " + v.help);
    console.log("  on: " + [...v.where].slice(0, process.env.A11Y_ALL ? 99 : 6).join("; ") + (v.where.size > 6 ? " (+" + (v.where.size - 6) + " more)" : ""));
    for (const t of [...v.targets].slice(0, process.env.A11Y_ALL ? 200 : 4)) console.log("  - " + t);
  }
  process.exit(1);
})();
