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
const server = spawn("bun", ["run", join(__dirname, "../src/server.ts")], { env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, RESEND_API_KEY: "", ADMIN_OPEN: "1" }, stdio: "ignore" });
// A second server with admin sign-in on. Email is off there, so it prints sign-in codes to its output.
const LOCKED = "http://127.0.0.1:" + (PORT + 1);
const lockedDir = mkdtempSync(join(tmpdir(), "booking-form-smoke-locked-"));
const locked = spawn("bun", ["run", join(__dirname, "../src/server.ts")], {
  env: { ...process.env, PORT: String(PORT + 1), DATA_DIR: lockedDir, RESEND_API_KEY: "", ADMIN_EMAILS: "owner@example.com" },
  stdio: ["ignore", "pipe", "ignore"],
});
let lockedLog = "";
locked.stdout.on("data", (d) => (lockedLog += d));

const checks = [
  ["booking page", async (p) => {
    await p.goto(BASE + "/booking");
    await p.locator("button.day.open").nth(1).click();
    await p.locator("button.t").first().click();
    await p.locator("#go").click();
    await p.locator("#card input").first().waitFor();
    if (!(await p.evaluate(() => document.fonts.check("600 16px Figtree")))) throw new Error("Figtree did not load");
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
    if (!(await frame.locator("#pq").isVisible())) await p.locator("#qbtn").click();
    await frame.locator("#pq").fill("priya");
    await frame.locator("#clist .crow").first().click();
    await frame.locator("#an:not([hidden]) .aitem").first().waitFor();
    await frame.locator("#tabAbout").click();
    await frame.locator("#tpAbout .agroup").first().waitFor();
    await frame.locator("#back").click();
    await frame.locator("#home:not([hidden]) .crow").first().waitFor();
  }],
  ["admin sign-in with an emailed code", async (p) => {
    await p.goto(LOCKED + "/admin");
    await p.fill("#em", "owner@example.com");
    await p.click("#go");
    await p.locator("#code").waitFor();
    for (let i = 0; i < 40 && !/sign-in code for owner@example.com: \d{6}/.test(lockedLog); i++) await p.waitForTimeout(50);
    const code = lockedLog.match(/sign-in code for owner@example.com: (\d{6})/)[1];
    await p.fill("#code", code); // signs in once all six digits are in
    await p.locator("#status").waitFor({ state: "attached" });
    await p.locator("#dlBtn").click();
    await p.locator("#mAdm").click();
    await p.locator(".admrow").first().waitFor();
    await p.fill(".admadd input", "helper@example.com");
    await p.click(".admadd button");
    await p.locator(".admrow", { hasText: "helper@example.com" }).waitFor();
  }],
  ["enquiry page, and its response in the admin", async (p) => {
    await p.goto(BASE + "/enquiry");
    await p.fill("#nm", "Asha Rao");
    await p.fill("#em", "asha@example.com");
    await p.fill("#ph", "98765 43210");
    await p.fill("#tc", "Java");
    await p.selectOption("#yx", "3 years");
    await p.setInputFiles("#cv", { name: "asha.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
    await p.click("#go");
    await p.locator("#done:not([hidden])").waitFor();
    if (!(await p.evaluate(() => document.fonts.check("600 16px Figtree")))) throw new Error("Figtree did not load");
    await p.goto(BASE + "/admin");
    await p.locator("#tabEnq .nbadge:not([hidden])").waitFor(); // the red count for the new enquiry
    await p.locator("#tabEnq").click();
    await p.locator(".enq", { hasText: "Asha Rao" }).waitFor();
    const [saved] = await Promise.all([p.waitForEvent("download"), p.locator(".enq .bk-act.dl").first().click()]);
    if (saved.suggestedFilename() !== "Asha Rao resume.pdf") throw new Error("resume saved as " + saved.suggestedFilename());
    await p.locator("#tabEnq .nbadge[hidden]").waitFor({ state: "attached" }); // seen now
  }],
  ["payment page, and the payment in the admin", async (p) => {
    await p.goto(BASE + "/payment");
    await p.fill("#em", "kiran@example.com");
    await p.fill("#nm", "Kiran Kumar");
    await p.fill("#am", "12,500");
    // a receipt over the size limit is refused in the browser, with a clear message
    await p.setInputFiles("#rc", { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
    await p.locator("#dropbox.bad").waitFor();
    if (!/larger than 1 MB/.test(await p.locator("#rchint").textContent())) throw new Error("no size message");
    await p.setInputFiles("#rc", { name: "gpay.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) });
    await p.click("#go");
    await p.locator("#done:not([hidden])").waitFor();
    await p.goto(BASE + "/admin?view=payments");
    await p.locator("#viewPay .enq", { hasText: "Kiran Kumar" }).waitFor();
    if (!(await p.locator(".paytot b").textContent()).includes("12,500")) throw new Error("total is wrong");
    const [saved] = await Promise.all([p.waitForEvent("download"), p.locator("#viewPay .bk-act.dl").first().click()]);
    if (saved.suggestedFilename() !== "Kiran Kumar receipt.png") throw new Error("receipt saved as " + saved.suggestedFilename());
    // the Table view: candidate, date and amount, with the total in the last row
    await p.locator(".paysw button", { hasText: "Table" }).click();
    if (!(await p.locator(".paytbl tfoot .num").textContent()).includes("12,500")) throw new Error("table total is wrong");
    await p.locator(".paytbl tbody tr", { hasText: "Kiran Kumar" }).waitFor();
  }],
  ["admin download menu", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    await p.locator("#dlMenu a[href='/admin/export.csv']").waitFor();
    await p.keyboard.press("Escape");
    if (await p.locator("#dlMenu").isVisible()) throw new Error("menu did not close");
  }],
  ["admin candidates from the menu", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    await p.locator("#mCand").click();
    await p.locator("#panel #viewAllow #addb").waitFor();
    if ((await p.locator("#ptitle").textContent()) !== "Candidates") throw new Error("panel title is not Candidates");
    if (!(await p.locator("#viewCal").isVisible())) throw new Error("calendar should stay behind the panel");
    await p.locator("#pclose").click();
    if (await p.locator("#viewAllow").isVisible()) throw new Error("candidates still showing after close");
    await p.locator("#dlBtn").click();
    await p.locator("#mIv").click();
    await p.locator("#ptitle", { hasText: "Interview supporters" }).waitFor();
    if (await p.locator("#pbody #viewAllow").count()) throw new Error("candidates left inside another panel");
    await p.locator("#pclose").click();
    await p.goto(BASE + "/admin/allowlist");
    await p.locator("#panel #viewAllow #addb").waitFor();
  }],
  ["admin desktop: Calendar is the week grid, Agenda is its own tab", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#week .grid").waitFor();
    if (await p.locator("#agenda").isVisible()) throw new Error("Calendar should show only the week grid");
    if (await p.locator(".vt").count()) throw new Error("the Week/Agenda switch should be gone");
    await p.locator("#tabAg").click();
    await p.locator("#agenda .ws").waitFor();
    if (await p.locator("#week").isVisible()) throw new Error("Agenda tab should show the agenda");
    if ((await p.locator("#tabAg").getAttribute("aria-selected")) !== "true") throw new Error("Agenda tab not selected");
    await p.reload();
    await p.locator("#agenda .ws").waitFor();
    await p.locator("#tabCal").click();
    await p.locator("#week .grid").waitFor();
  }],
  ["admin phone: Alerts in the menu, Calendar and Agenda in the bottom bar", async (p) => {
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    if (await p.locator("#dlMenu").getByText("New booking").count()) throw new Error("New booking should be gone from the menu");
    await p.locator("#mAlerts").click();
    await p.locator(".pushpop h3", { hasText: "Booking notifications" }).waitFor();
    if (await p.locator("#dlMenu").isVisible()) throw new Error("menu stayed open behind Alerts");
    await p.keyboard.press("Escape");
    if (await p.locator(".bnav").getByText("New booking").count()) throw new Error("New booking should be gone from the bottom bar");
    await p.locator(".bnav [data-go='cal']").click();
    await p.locator("#week .grid").waitFor();
    if (await p.locator("#agenda").isVisible()) throw new Error("Calendar tab should show the week grid");
    await p.locator(".bnav [data-go='ag']").click();
    await p.locator("#agenda .ws").waitFor();
    if (await p.locator("#week").isVisible()) throw new Error("Agenda tab should show the agenda");
    if ((await p.locator("#sect").textContent()) !== "Agenda") throw new Error("header should say Agenda");
    if (!(await p.locator(".bnav [data-go='ag']").evaluate((b) => b.classList.contains("on")))) throw new Error("Agenda tab not highlighted");
  }],
];

(async () => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + "/healthz")).ok && (await fetch(LOCKED + "/healthz")).ok) break; } catch {}
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
  locked.kill();
  process.exit(failed ? 1 : 0);
})();
