// ---- Monthly revenue report -----------------------------------------------------------------
// On the 1st of every month after REPORT_HOUR (IST), the owners (ADMIN_EMAILS) get an email about the month that just
// ended: its confirmed revenue against the month before, a chart by day and one of the last twelve months, who paid, and
// what still waits for a decision, with that month's payments as a CSV. It counts like the Revenue tab: confirmed
// payments only, in the India month they were made.
// report-state.json records the last month sent, so restarts neither skip nor repeat one. A server that was down on the
// 1st sends it once it is back, and a failed email is retried every 15 minutes.
// Mail apps drop SVG and scripts, so the charts are table cells with a background colour and a height.
import { analyticsCsvText, monthKey } from "./analytics";
import { OWNER_EMAILS, PUBLIC_URL, REPORT_HOUR, REPORT_ON, RESEND_API_KEY } from "./config";
import { paymentsStore, reportStateStore } from "./data";
import { sendEmail } from "./email";
import { reportPdf } from "./report-pdf";
import { loadStore, saveStore } from "./store";
import { istParts } from "./time";
import { normEmail, pad } from "./util";

const SITE = (PUBLIC_URL || "https://hi-techie.dev").replace("://www.", "://");
export const INK = "#181511";
export const MUTED = "#6b6359";
export const ACCENT = "#b8460d";
const PAPER = "#f3f0e8";
export const CARD = "#fbfaf6";
export const LINE = "#e4ddcf";
export const BAR = "#d9cebc";
export const UP = "#2f6b3f";

export const monthIndex = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;
export const keyOf = (i: number) => Math.floor(i / 12) + "-" + pad((i % 12) + 1);
export const monthName = (key: string, o: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" }) =>
  new Intl.DateTimeFormat("en-US", { ...o, timeZone: "UTC" }).format(new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 15)));
export const rupees = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
// the month before this one (India time): the one a report sent today is about
export const lastMonthKey = (now = Date.now()) => {
  const p = istParts(now);
  return keyOf(p.y * 12 + p.mo - 2);
};

// The month's figures, from payments.json as it is now.
export function monthReport(key: string) {
  const at = monthIndex(key);
  const days = new Date(Date.UTC(+key.slice(0, 4), +key.slice(5, 7), 0)).getUTCDate();
  const byDay = Array.from({ length: days }, () => 0);
  const months = Array.from({ length: 12 }, (_, i) => keyOf(at - 11 + i));
  const byMonth = months.map(() => 0);
  const people = new Map<string, { name: string; email: string; count: number; total: number; last: string }>();
  let total = 0;
  let count = 0;
  let toDate = 0;
  let pending = 0;
  let pendingCount = 0;
  for (const v of paymentsStore.data.payments) {
    if (v.decision === "discarded") continue;
    const k = monthKey(v.createdAt);
    if (k !== key) {
      if (v.decision !== "confirmed") continue;
      if (k < key) toDate += v.amount;
      const i = months.indexOf(k);
      if (i >= 0) byMonth[i] += v.amount;
      continue;
    }
    if (v.decision !== "confirmed") {
      pending += v.amount;
      pendingCount++;
      continue;
    }
    total += v.amount;
    count++;
    toDate += v.amount;
    byMonth[11] += v.amount;
    byDay[istParts(Date.parse(v.createdAt)).d - 1] += v.amount;
    const email = normEmail(v.email);
    const p = people.get(email) ?? { name: v.name, email, count: 0, total: 0, last: "" };
    if (v.createdAt >= p.last) {
      p.last = v.createdAt;
      p.name = v.name;
    }
    p.count++;
    p.total += v.amount;
    people.set(email, p);
  }
  // the twelve-month chart starts at the first month with revenue (and always shows the month before this one)
  const first = Math.min(
    10,
    Math.max(
      0,
      byMonth.findIndex((n) => n > 0),
    ),
  );
  const best = byDay.reduce((b, n, i) => (n > byDay[b] ? i : b), 0);
  return {
    key,
    total,
    count,
    payers: people.size,
    average: count ? total / count : 0,
    previous: byMonth[10],
    toDate,
    pending,
    pendingCount,
    byDay,
    bestDay: byDay[best] > 0 ? { day: best + 1, amount: byDay[best] } : null,
    months: months.slice(first).map((k, i) => ({ key: k, total: byMonth[first + i] })),
    who: [...people.values()]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .map((p) => ({ name: p.name, email: p.email, count: p.count, total: p.total })),
  };
}

// "▲ 24% from ₹1,00,000 in August", or the like
export function change(r: ReturnType<typeof monthReport>) {
  const prev = monthName(keyOf(monthIndex(r.key) - 1), { month: "long" });
  if (r.total === r.previous) return { text: "Same as " + prev + " (" + rupees(r.previous) + ")", color: MUTED };
  if (!r.previous) return { text: "▲ Up from " + rupees(0) + " in " + prev, color: UP };
  const pct = Math.round((Math.abs(r.total - r.previous) / r.previous) * 100);
  return r.total > r.previous
    ? { text: "▲ " + pct + "% from " + rupees(r.previous) + " in " + prev, color: UP }
    : { text: "▼ " + pct + "% from " + rupees(r.previous) + " in " + prev, color: ACCENT };
}

export function reportEmail(key: string) {
  const r = monthReport(key);
  const e = (s: string) => Bun.escapeHTML(s);
  const month = monthName(key);
  const short = (k: string) => monthName(k, { month: "short" });
  const ch = change(r);
  const font = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const serif = "font-family:Georgia,'Times New Roman',serif";
  const label = `font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:600`;
  const section = (title: string, body: string) =>
    `<tr><td style="padding:28px 32px 0"><div style="${label};margin:0 0 12px">${e(title)}</div>${body}</td></tr>`;

  // two rows of two, so the figures fit a phone too
  const tiles = [
    ["Payments", String(r.count)],
    ["Paying candidates", String(r.payers)],
    ["Average payment", rupees(r.average)],
    ["Best day", r.bestDay ? short(key) + " " + r.bestDay.day : "–"],
  ]
    .map(
      ([k, v], i) =>
        (i === 2 ? "</tr><tr>" : "") +
        `<td width="50%" valign="top" style="padding:14px 16px;${i % 2 ? `border-left:1px solid ${LINE};` : ""}${i > 1 ? `border-top:1px solid ${LINE};` : ""}">` +
        `<div style="font-size:12px;color:${MUTED};margin:0 0 4px">${e(k)}</div>` +
        `<div style="font-size:18px;font-weight:700;color:${INK}">${e(v)}</div></td>`,
    )
    .join("");

  // day by day: one column per day, its height the day's share of the best day
  const top = Math.max(...r.byDay, 1);
  const H = 120;
  const dayBars = r.byDay
    .map((n) => {
      const h = n ? Math.max(4, Math.round((n / top) * H)) : 2;
      const bg = n ? (r.bestDay && n === r.bestDay.amount ? ACCENT : "#d58a5c") : LINE;
      return (
        `<td valign="bottom" height="${H}" style="padding:0 1px;height:${H}px;vertical-align:bottom">` +
        `<div style="height:${h}px;line-height:${h}px;font-size:0;background:${bg};border-radius:2px 2px 0 0">&nbsp;</div></td>`
      );
    })
    .join("");
  const dayLabels = r.byDay
    .map((_, i) => `<td align="center" style="padding:6px 0 0;font-size:11px;color:${MUTED}">${i % 7 === 0 ? i + 1 : ""}</td>`)
    .join("");
  const dayChart =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border-collapse:collapse">` +
    `<tr>${dayBars}</tr><tr>${dayLabels}</tr></table>` +
    (r.bestDay
      ? `<p style="margin:10px 0 0;font-size:13px;color:${MUTED}">The tallest bar is ${e(short(key) + " " + r.bestDay.day)}: ${e(rupees(r.bestDay.amount))}.</p>`
      : `<p style="margin:10px 0 0;font-size:13px;color:${MUTED}">No confirmed payments this month.</p>`);

  // the last twelve months, one bar each, this month in the accent colour
  const topMonth = Math.max(...r.months.map((m) => m.total), 1);
  const monthRows = r.months
    .map((m) => {
      const pct = Math.round((m.total / topMonth) * 100);
      const mine = m.key === key;
      const bar = pct
        ? `<td width="${pct}%" height="14" style="height:14px;background:${mine ? ACCENT : BAR};border-radius:0 3px 3px 0;font-size:0;line-height:0">&nbsp;</td>`
        : `<td width="1%" height="14" style="height:14px;background:${LINE};font-size:0;line-height:0">&nbsp;</td>`;
      return (
        `<tr><td width="72" style="padding:4px 10px 4px 0;font-size:13px;color:${mine ? INK : MUTED};${mine ? "font-weight:700;" : ""}white-space:nowrap">${e(monthName(m.key, { month: "short", year: "2-digit" }).replace(" ", " ’"))}</td>` +
        `<td style="padding:4px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${bar}<td style="font-size:0">&nbsp;</td></tr></table></td>` +
        `<td width="96" align="right" style="padding:4px 0 4px 10px;font-size:13px;color:${INK};${mine ? "font-weight:700;" : ""}white-space:nowrap">${e(rupees(m.total))}</td></tr>`
      );
    })
    .join("");
  const monthChart = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${monthRows}</table>`;

  const payerRows = r.who
    .map(
      (p) =>
        `<tr><td style="padding:10px 0;border-top:1px solid ${LINE}"><div style="font-size:14px;font-weight:600;color:${INK}">${e(p.name)}</div>` +
        `<div style="font-size:12px;color:${MUTED}">${e(p.email)}</div></td>` +
        `<td align="right" style="padding:10px 12px;border-top:1px solid ${LINE};font-size:13px;color:${MUTED};white-space:nowrap">${p.count === 1 ? "1 payment" : p.count + " payments"}</td>` +
        `<td align="right" style="padding:10px 0;border-top:1px solid ${LINE};font-size:14px;font-weight:700;color:${INK};white-space:nowrap">${e(rupees(p.total))}</td></tr>`,
    )
    .join("");

  const pendingNote = r.pendingCount
    ? `<tr><td style="padding:24px 32px 0"><div style="padding:14px 16px;border-radius:8px;background:#f6e7dc;color:${INK};font-size:14px;line-height:1.5">` +
      `<b>${e(rupees(r.pending))}</b> from ${r.pendingCount === 1 ? "1 payment" : r.pendingCount + " payments"} made in ${e(monthName(key, { month: "long" }))} still ${r.pendingCount === 1 ? "waits" : "wait"} for your decision. ` +
      `It counts here once you confirm it. <a href="${e(SITE + "/admin?view=payments")}" style="color:${ACCENT};font-weight:600">Open Payments</a></div></td></tr>`
    : "";

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${e(month)} revenue</title></head>` +
    `<body style="margin:0;padding:0;background:${PAPER};${font};color:${INK}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:28px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:${CARD};border:1px solid ${LINE};border-radius:14px">` +
    // the logo and the month
    `<tr><td style="padding:26px 32px 0"><table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="padding-right:10px"><img src="${e(SITE + "/icon.png?v=8")}" width="32" height="32" alt="" style="display:block;border-radius:7px"></td>` +
    `<td style="font-size:17px;font-weight:800;color:${INK};letter-spacing:-.01em">Hi-Techie</td></tr></table></td></tr>` +
    `<tr><td style="padding:26px 32px 0"><div style="${label};color:${ACCENT}">Monthly revenue report</div>` +
    `<h1 style="margin:6px 0 0;${serif};font-style:italic;font-weight:400;font-size:34px;line-height:1.15;color:${INK}">${e(month)}</h1></td></tr>` +
    // the headline figure
    `<tr><td style="padding:22px 32px 0"><div style="font-size:13px;color:${MUTED}">Confirmed revenue</div>` +
    `<div style="font-size:44px;line-height:1.1;font-weight:800;letter-spacing:-.02em;color:${INK};margin:4px 0 6px">${e(rupees(r.total))}</div>` +
    `<div style="font-size:14px;font-weight:600;color:${ch.color}">${e(ch.text)}</div></td></tr>` +
    `<tr><td style="padding:22px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;border:1px solid ${LINE};border-radius:10px;background:#ffffff"><tr>${tiles}</tr></table></td></tr>` +
    section("Day by day", dayChart) +
    section("Last " + (r.months.length === 1 ? "month" : r.months.length + " months"), monthChart) +
    pendingNote +
    (payerRows
      ? section(
          "Who paid",
          `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${payerRows}</table>`,
        )
      : "") +
    `<tr><td style="padding:24px 32px 0;font-size:14px;color:${INK}">Confirmed since the first payment: <b>${e(rupees(r.toDate))}</b></td></tr>` +
    `<tr><td style="padding:22px 32px 0"><a href="${e(SITE + "/admin?view=revenue")}" style="display:inline-block;padding:11px 22px;border-radius:40px;background:${INK};color:${PAPER};text-decoration:none;font-weight:600;font-size:15px">Open Revenue</a></td></tr>` +
    `<tr><td style="padding:22px 32px 28px;font-size:12px;line-height:1.5;color:${MUTED}">Counts confirmed payments only, in the month they were made (India time), as of when this was sent. ` +
    `The attached PDF is this report to keep or print, and the CSV lists every payment of the month that isn't discarded. Sent to the owners on the 1st of every month.</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const text = [
    "Hi-Techie revenue report: " + month,
    "",
    "Confirmed revenue: " + rupees(r.total),
    ch.text,
    "Payments: " + r.count + ", paying candidates: " + r.payers + ", average payment: " + rupees(r.average),
    ...(r.bestDay ? ["Best day: " + short(key) + " " + r.bestDay.day + ", " + rupees(r.bestDay.amount)] : []),
    ...(r.pendingCount ? ["Waiting for your decision: " + rupees(r.pending) + " (" + r.pendingCount + ")"] : []),
    "",
    "By month:",
    ...r.months.map((m) => "  " + monthName(m.key, { month: "short", year: "numeric" }) + ": " + rupees(m.total)),
    ...(r.who.length ? ["", "Who paid:", ...r.who.map((p) => "  " + p.name + " <" + p.email + ">: " + rupees(p.total))] : []),
    "",
    "Confirmed since the first payment: " + rupees(r.toDate),
    "Open Revenue: " + SITE + "/admin?view=revenue",
  ].join("\n");
  return {
    subject: "Revenue report: " + month + " – " + rupees(r.total),
    html,
    text,
    files: [
      {
        filename: "payments-" + key + ".csv",
        content: Buffer.from(analyticsCsvText("", key)).toString("base64"),
        content_type: "text/csv; charset=utf-8",
      },
      {
        filename: "revenue-report-" + key + ".pdf",
        content: reportPdf(key).toString("base64"),
        content_type: "application/pdf",
      },
    ],
  };
}

let reportRunning = false;
async function runReport() {
  const now = istParts(Date.now());
  const key = lastMonthKey();
  const st = reportStateStore.data;
  if (reportRunning || !paymentsStore.ok || !reportStateStore.ok || st.sent >= key) return;
  if (now.d === 1 && now.hh < REPORT_HOUR) return;
  reportRunning = true;
  try {
    if (await sendEmail({ to: OWNER_EMAILS, ...reportEmail(key) })) {
      st.sent = key;
      await saveStore(reportStateStore);
    }
  } catch (e) {
    console.log("revenue report failed: " + String(e));
  } finally {
    reportRunning = false;
  }
}
// Sends last month's report now (when it is due and not sent yet) and checks again every 15 minutes.
export async function startReports() {
  if (!REPORT_ON) return console.log("revenue report: off (MONTHLY_REPORT=off)");
  if (!RESEND_API_KEY || !OWNER_EMAILS.length) return console.log("revenue report: off (needs RESEND_API_KEY and ADMIN_EMAILS)");
  await loadStore(reportStateStore);
  void runReport();
  setInterval(() => void runReport(), 15 * 60000);
}
