// Loads every page in Chromium and fails on script errors or Content-Security-Policy violations.
// Run: NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs   (needs the playwright package)
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = 4321;
const BASE = "http://127.0.0.1:" + PORT;
const dir = mkdtempSync(join(tmpdir(), "booking-form-smoke-"));
const start = new Date(Date.now() + 2 * 86400000);
start.setUTCHours(5, 0, 0, 0);
writeFileSync(join(dir, "bookings.json"), JSON.stringify({ bookings: [{ id: "00000000-0000-0000-0000-000000000001", name: "Priya Sharma", email: "priya@example.com", company: "Google", round: "1st round", start: start.toISOString(), end: new Date(+start + 1800000).toISOString(), duration: 30, createdAt: new Date().toISOString(), cancelled: false, cancelledAt: "" }] }));
const server = spawn("bun", ["run", join(__dirname, "../src/server.ts")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, RESEND_API_KEY: "" }, stdio: "ignore" });

const checks = [
  ["booking page", async (p) => {
    await p.goto(BASE + "/");
    await p.locator("button.day.open").nth(1).click();
    await p.locator("button.t").first().click();
    await p.locator("#go").click();
    await p.locator("#card input").first().waitFor();
    if (!(await p.evaluate(() => document.fonts.check("600 16px Inter")))) throw new Error("Inter did not load");
  }],
  ["admin calendar", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#status.live").waitFor({ state: "attached" });
  }],
  ["admin contacts", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#tabStats").click();
    const frame = p.frameLocator("iframe.la-frame");
    await frame.locator("#clist .crow").first().waitFor();
    await frame.locator("#pq").fill("priya");
    await frame.locator("#clist .crow").first().click();
    await frame.locator("#an:not([hidden]) .aitem").first().waitFor();
    await frame.locator("#tabAbout").click();
    await frame.locator("#tpAbout .agroup").first().waitFor();
    await frame.locator("#back").click();
    await frame.locator("#home:not([hidden]) .crow").first().waitFor();
  }],
  ["admin download menu", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    await p.locator("#dlMenu a[href='/admin/backup.json']").waitFor();
    await p.keyboard.press("Escape");
    if (await p.locator("#dlMenu").isVisible()) throw new Error("menu did not close");
  }],
];

(async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const browser = await chromium.launch();
  let failed = 0;
  for (const [name, run] of checks) {
    const page = await browser.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push("script error: " + e.message));
    page.on("console", (m) => m.type() === "error" && problems.push("console: " + m.text()));
    try { await run(page); await page.waitForTimeout(500); } catch (e) { problems.push(e.message.split("\n")[0]); }
    console.log((problems.length ? "FAIL " : "ok   ") + name + (problems.length ? "\n  " + problems.join("\n  ") : ""));
    failed += problems.length ? 1 : 0;
    await page.close();
  }
  await browser.close();
  server.kill();
  process.exit(failed ? 1 : 0);
})();
