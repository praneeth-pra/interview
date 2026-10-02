// Loads every page in Chromium and fails on script errors or Content-Security-Policy violations.
// Run: NODE_PATH=$(npm root -g) node tests/browser-smoke.cjs   (needs the playwright package)
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const PORT = 4321;
const BASE = "http://127.0.0.1:" + PORT;
// The booking calendar's open days, from next month when this month has none left (late on a month's last open day).
async function openDays(p) {
  const days = p.locator("button.day.open");
  await p.locator("button.day").first().waitFor();
  if (!(await days.count())) {
    await p.locator("#nextm").click();
    await days.first().waitFor();
  }
  return days;
}
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
    await (await openDays(p)).first().click();
    await p.locator("button.t").first().click();
    await p.locator("#go").click();
    await p.locator("#card input").first().waitFor();
    if (!(await p.evaluate(() => document.fonts.check("600 16px Figtree")))) throw new Error("Figtree did not load");
  }],
  ["booking page: a refresh keeps the time picked and what was typed", async (p) => {
    await p.goto(BASE + "/booking");
    await (await openDays(p)).first().click();
    const time = p.locator("button.t").first();
    const picked = await time.getAttribute("id");
    await time.click();
    await p.locator("#go").click();
    await p.locator("#fname").fill("Refresh Test");
    await p.reload();
    await p.locator("#fname").waitFor();
    if ((await p.locator("#fname").inputValue()) !== "Refresh Test") throw new Error("the typed name was lost");
    // the details step names the same time; back goes to the times with that time still picked
    await p.locator("#back").click();
    await p.locator(".slot.sel").waitFor();
    if ((await p.locator(".slot.sel button.t").getAttribute("id")) !== picked) throw new Error("a different time is picked after the refresh");
  }],
  ["booking page: book, book another, reschedule and cancel", async (p) => {
    const card = () => p.locator("#card").textContent();
    const expectText = async (re, what) => {
      for (let i = 0; i < 40 && !re.test(await card()); i++) await p.waitForTimeout(50);
      if (!re.test(await card())) throw new Error(what);
    };
    // Days and times are picked by what is open now, not by position: near the end of a day or a month the calendar
    // shows fewer open days.
    await p.goto(BASE + "/booking");
    const firstDay = (await openDays(p)).first();
    const bookedDay = await firstDay.getAttribute("aria-label");
    await firstDay.click();
    const booked = (await p.locator("button.t").first().textContent()).trim();
    await p.locator("button.t").first().click();
    await p.locator("#go").click();
    await p.locator("#card input").first().waitFor();
    for (const inp of await p.locator("#card input:visible").all()) {
      const k = (await Promise.all(["id", "name", "autocomplete", "type"].map((a) => inp.getAttribute(a)))).join(" ");
      const v = /mail/i.test(k) ? "smoke@example.com" : /comp|org/i.test(k) ? "Acme" : /round/i.test(k) ? "HR" : /name/i.test(k) ? "Smoke Test" : null;
      if (v) await inp.fill(v);
    }
    await p.keyboard.press("Escape");
    await p.click("#submitb");
    await p.locator('a[href*="/b/"]').first().waitFor();
    const manage = await p.locator('a[href*="/b/"]').first().getAttribute("href");
    // booking another starts over, without the time just taken (or the day is now full)
    await p.locator("button.pill").last().click();
    await p.locator("button.day").first().waitFor();
    const sameDay = p.locator(`button.day.open[aria-label="${bookedDay}"]`);
    if (await sameDay.count()) {
      await sameDay.click();
      await p.locator("button.t").first().waitFor();
      const times = (await p.locator("button.t").allTextContents()).map((s) => s.trim());
      if (times.includes(booked)) throw new Error("the booked time is still offered");
    }
    await p.goto(manage + "&a=reschedule");
    await (await openDays(p)).last().click();
    await p.locator("button.t").last().click();
    await p.locator("#go").click();
    await p.getByRole("button", { name: "Reschedule" }).click();
    await expectText(/rescheduled/i, "reschedule didn't finish");
    await p.goto(manage + "&a=cancel");
    await p.click("#cxgo");
    await expectText(/cancelled/i, "cancel didn't finish");
  }],
  ["admin phone: pulling down from the top refreshes the tab in place; short, sideways and sheet drags don't", async (p) => {
    const ctx = await p.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await ctx.newPage();
      const errors = [];
      m.on("pageerror", (e) => errors.push(e.message));
      let asked = [];
      // the page's own requests; the Contacts frame loads quietly in the background and asks for the state too
      m.on("request", (r) => r.frame() === m.mainFrame() && asked.push(new URL(r.url()).pathname));
      await m.goto(BASE + "/admin");
      await m.locator("#week .ev").first().waitFor();
      await m.waitForTimeout(600);
      const cdp = await ctx.newCDPSession(m);
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const pull = async (x1, y1, x2, y2) => {
        asked = [];
        await touch("touchStart", x1, y1);
        for (let i = 1; i <= 12; i++) await touch("touchMove", x1 + ((x2 - x1) * i) / 12, y1 + ((y2 - y1) * i) / 12);
        await touch("touchEnd");
        await m.waitForTimeout(1100);
        return asked;
      };
      if (!(await pull(195, 250, 195, 430)).includes("/admin/api/state")) throw new Error("a full pull didn't fetch the bookings again");
      if (await m.evaluate(() => scrollY) !== 0) throw new Error("the page moved");
      if ((await pull(195, 250, 195, 290)).includes("/admin/api/state")) throw new Error("a short pull refreshed");
      if ((await pull(320, 300, 80, 330)).includes("/admin/api/state")) throw new Error("a sideways swipe refreshed");
      // phones have Revenue in the bottom bar, and Payments in the ⋯ menu, opening in the bottom sheet
      await m.locator(".bnav [data-go=rev]").click();
      await m.waitForTimeout(400);
      if (await m.locator("#viewRev").isHidden()) throw new Error("the bottom bar's Revenue didn't open Revenue");
      if (!(await pull(195, 250, 195, 430)).includes("/admin/api/revenue")) throw new Error("pulling on Revenue didn't fetch the revenue");
      await m.locator("#dlBtn").click();
      await m.waitForTimeout(300);
      if ((await pull(195, 120, 195, 330)).includes("/admin/api/state")) throw new Error("pulling with the ⋯ menu open refreshed");
      // that swipe closed the menu; open it again for Payments
      if (!(await m.locator("#dlMenu").isVisible())) await m.locator("#dlBtn").click();
      await m.locator("#mPay").click();
      await m.locator("#panel #payBody .enqlist").waitFor();
      if ((await m.locator("#ptitle").textContent()) !== "Payments") throw new Error("the ⋯ menu's Payments didn't open the sheet");
      await m.locator("#pclose").click();
      if ((await m.locator("#viewPay #payBody").count()) !== 1) throw new Error("closing the sheet didn't put Payments back");
      if (errors.length) throw new Error(errors.join("; "));
    } finally {
      await ctx.close();
    }
  }],
  ["admin phone: swiping the agenda moves the day, not the week strip, and never leaves it stuck", async (p) => {
    const ctx = await p.context().browser().newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    try {
      const m = await ctx.newPage();
      const errors = [];
      m.on("pageerror", (e) => errors.push(e.message));
      await m.goto(BASE + "/admin?view=agenda");
      await m.locator("#agenda .ag-grid").waitFor();
      await m.waitForTimeout(600);
      const cdp = await ctx.newCDPSession(m);
      const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
      const shift = (sel) => m.evaluate((s) => getComputedStyle(document.querySelector(s)).transform, sel);
      const y = (await m.locator("#agenda .ag-grid").boundingBox()).y + 120;
      const before = Number(await m.locator("#agenda .ws-b.on b").textContent());
      await touch("touchStart", 300, y);
      for (let x = 290; x >= 150; x -= 20) await touch("touchMove", x, y);
      if ((await shift("#agenda .ag-grid")) === "none") throw new Error("the day didn't follow the finger");
      if ((await shift("#agenda .ws")) !== "none" || (await shift("#agenda")) !== "none") throw new Error("the week strip moved with the day");
      await touch("touchEnd");
      await m.waitForTimeout(700);
      const after = Number(await m.locator("#agenda .ws-b.on b").textContent());
      if (after !== before + 1 && after !== 1) throw new Error("a left swipe should pick the next day, got " + before + " → " + after);
      // a redraw in the middle of a swipe (as a live update does) must not leave the day half moved
      await touch("touchStart", 300, y);
      for (let x = 290; x >= 200; x -= 15) await touch("touchMove", x, y);
      await m.evaluate(() => {
        const a = document.getElementById("agenda");
        for (const c of Array.from(a.children)) a.replaceChild(c.cloneNode(true), c);
      });
      await touch("touchEnd");
      await m.waitForTimeout(700);
      for (const sel of ["#agenda", "#agenda .ws", "#agenda .ag-grid"])
        if ((await shift(sel)) !== "none") throw new Error(sel + " was left shifted after a redraw mid-swipe");
      if (errors.length) throw new Error(errors[0]);
    } finally {
      await ctx.close();
    }
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
    await p.selectOption("#in", "1");
    await p.fill("#am", "12,500");
    // a receipt over the size limit is refused in the browser, with a clear message
    await p.setInputFiles("#rc", { name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(2 * 1024 * 1024, 1) });
    await p.locator("#dropbox.bad").waitFor();
    if (!/larger than 1 MB/.test(await p.locator("#rchint").textContent())) throw new Error("no size message");
    await p.setInputFiles("#rc", { name: "gpay.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]) });
    await p.click("#go");
    await p.locator("#done:not([hidden])").waitFor();
    // the alert opens the new payment, pending, with Confirm and Discard
    const id = (await (await p.request.get(BASE + "/admin/api/payments")).json()).payments[0].id;
    await p.goto(BASE + "/admin?view=payments&pay=" + id);
    await p.locator("#tabPay .pbadge:not([hidden])").waitFor({ state: "attached" });
    const card = p.locator("#viewPay .enq.hl", { hasText: "Kiran Kumar" });
    await card.locator(".pst", { hasText: "Pending" }).waitFor();
    const [saved] = await Promise.all([p.waitForEvent("download"), card.locator(".bk-act.dl").click()]);
    if (saved.suggestedFilename() !== "Kiran Kumar receipt.png") throw new Error("receipt saved as " + saved.suggestedFilename());
    p.once("dialog", (d) => d.accept());
    await card.locator("button", { hasText: "Confirm" }).click();
    // confirmed is final: no buttons left, and it counts in the candidate's total
    await p.locator("#viewPay .enq .pdone", { hasText: "Confirmed" }).waitFor();
    if (await p.locator("#viewPay .pdec button").count()) throw new Error("buttons still there after confirming");
    await p.locator("#tabPay .pbadge[hidden]").waitFor({ state: "attached" });
    await p.locator(".paysw button", { hasText: "By candidate" }).click();
    await p.locator(".paytbl tbody tr", { hasText: "Kiran Kumar" }).click();
    if (!(await p.locator(".paytbl tfoot .num").textContent()).includes("12,500")) throw new Error("candidate total is wrong");
    // typing part of a name suggests candidates without narrowing the list; picking one shows their total
    await p.locator(".paysw button", { hasText: "List" }).click();
    await p.locator(".paysearch").fill("");
    await p.locator(".paysearch").pressSequentially("kir");
    if ((await p.locator(".paysearch").inputValue()) !== "kir") throw new Error("typing in search was interrupted");
    await p.locator("#payDrop li", { hasText: "Kiran Kumar" }).waitFor();
    if (await p.locator("#viewPay .paysum").count()) throw new Error("typing narrowed the payments before a pick");
    await p.locator("#payDrop li", { hasText: "Kiran Kumar" }).click();
    if (!(await p.locator("#viewPay .paysum").textContent()).includes("12,500")) throw new Error("picking didn't narrow to the candidate");
    if ((await p.locator(".paysearch").inputValue()) !== "Kiran Kumar") throw new Error("the picked name isn't in the box");
    await p.fill(".paysearch", "nobody");
    await p.locator("#payDrop li", { hasText: "No matching candidates" }).waitFor();
  }],
  ["admin download menu", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    await p.locator("#dlMenu a[href='/admin/export.csv']").waitFor();
    await p.keyboard.press("Escape");
    if (await p.locator("#dlMenu").isVisible()) throw new Error("menu did not close");
  }],
  ["admin unavailable times from the menu", async (p) => {
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    await p.locator("#mUn").click();
    await p.locator("#ptitle", { hasText: "Unavailability" }).waitFor();
    await p.locator("#pbody .sub", { hasText: "Nothing marked" }).waitFor();
    await p.locator("#pbody .paysw button", { hasText: "Some hours" }).click();
    if (await p.locator("#unTo").isVisible()) throw new Error("the end date shows for some hours");
    const day = await p.locator("#unFrom").inputValue();
    const next = new Date(Date.parse(day + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);
    await p.fill("#unFrom", next);
    await p.fill("#unNote", "Dentist");
    await p.locator("#pbody .pri", { hasText: "Add unavailability" }).click();
    await p.locator("#pbody .unrow", { hasText: "Dentist" }).waitFor();
    await p.locator("#pbody .unrow .rm").click();
    await p.locator("#pbody .sub", { hasText: "Nothing marked" }).waitFor();
    await p.locator("#pclose").click();
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
    await p.locator("#ptitle", { hasText: "Supporters" }).waitFor();
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
  ["admin phone: Alerts bell in the header, Calendar and Agenda in the bottom bar", async (p) => {
    await p.setViewportSize({ width: 390, height: 844 });
    await p.goto(BASE + "/admin");
    await p.locator("#dlBtn").click();
    if (await p.locator("#dlMenu").getByText("New booking").count()) throw new Error("New booking should be gone from the menu");
    if (await p.locator("#dlMenu").getByText("Alerts").count()) throw new Error("Alerts should be gone from the menu");
    await p.keyboard.press("Escape");
    await p.locator("#pushBtn").click();
    await p.locator(".pushpop h3", { hasText: "Booking notifications" }).waitFor();
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
