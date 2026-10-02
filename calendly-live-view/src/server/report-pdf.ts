// The monthly revenue report as an A4 PDF: the same figures and charts as the email (src/server/report.ts), for the
// Revenue tab's Download PDF and as an attachment to the monthly email.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_HEADERS } from "./http";
import { PAGE_H, PAGE_W, Pdf, loadFont } from "./pdf";
import { ACCENT, BAR, INK, LINE, MUTED, UP, change, lastMonthKey, monthName, monthReport, rupees } from "./report";

const FONTS = join(import.meta.dir, "../fonts/pdf");
const font = (file: string, name: string) => loadFont(name, new Uint8Array(readFileSync(join(FONTS, file))));
const SANS = font("figtree-400.ttf", "Figtree-Regular");
const BOLD = font("figtree-700.ttf", "Figtree-Bold");
const SERIF = font("instrument-serif-italic.ttf", "InstrumentSerif-Italic");
const M = 48; // page margin
const W = PAGE_W - 2 * M;
const PAPER = "#f3f0e8";

export function reportPdf(key: string, now = Date.now()) {
  const r = monthReport(key);
  const pdf = new Pdf();
  const short = (k: string) => monthName(k, { month: "short" });
  let y = M;
  // starts a new page when the next h points don't fit
  const room = (h: number) => {
    if (y + h <= PAGE_H - M) return;
    pdf.addPage();
    y = M;
  };
  const heading = (text: string) => {
    pdf.text(text.toUpperCase(), M, y + 8, BOLD, 8.5, MUTED, { spacing: 0.9 });
    y += 20;
  };

  // the mark (an italic H with a rising orange crossbar, as on the site) and the name
  const s = 28 / 512;
  pdf.rect(M, y, 28, 28, INK, { radius: 6.5 });
  pdf.line(M + 190 * s, y + 296 * s, M + 322 * s, y + 232 * s, "#e0814f", 34 * s);
  pdf.line(M + 205 * s, y + 168 * s, M + 168 * s, y + 342 * s, PAPER, 44 * s, true);
  pdf.line(M + 345 * s, y + 168 * s, M + 308 * s, y + 342 * s, PAPER, 44 * s, true);
  pdf.text("Hi-Techie", M + 38, y + 19, BOLD, 15, INK);
  pdf.text(
    "Generated " + new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(now),
    M + W,
    y + 18,
    SANS,
    9,
    MUTED,
    {
      align: "right",
    },
  );
  y += 56;

  pdf.text("MONTHLY REVENUE REPORT", M, y, BOLD, 9, ACCENT, { spacing: 1 });
  y += 34;
  pdf.text(monthName(key), M, y, SERIF, 32, INK);
  y += 30;

  // the headline figure and how it compares
  pdf.text("Confirmed revenue", M, y, SANS, 11, MUTED);
  y += 38;
  pdf.text(rupees(r.total), M, y, BOLD, 36, INK);
  y += 22;
  const ch = change(r);
  const arrow = ch.text.startsWith("▲") ? "up" : ch.text.startsWith("▼") ? "down" : "";
  let x = M;
  if (arrow) {
    const top = y - 8.5;
    pdf.polygon(
      arrow === "up"
        ? [
            [x, top + 8],
            [x + 9, top + 8],
            [x + 4.5, top],
          ]
        : [
            [x, top],
            [x + 9, top],
            [x + 4.5, top + 8],
          ],
      ch.color,
    );
    x += 14;
  }
  pdf.text(ch.text.replace(/^[▲▼] /, ""), x, y, BOLD, 11, ch.color === UP || ch.color === ACCENT ? ch.color : MUTED);
  y += 24;

  // four tiles
  const tiles = [
    ["Payments", String(r.count)],
    ["Paying candidates", String(r.payers)],
    ["Average payment", rupees(r.average)],
    ["Best day", r.bestDay ? short(key) + " " + r.bestDay.day : "–"],
  ];
  pdf.rect(M, y, W, 58, "#ffffff", { radius: 8, stroke: LINE });
  tiles.forEach(([k, v], i) => {
    const tx = M + (W / 4) * i;
    if (i) pdf.line(tx, y, tx, y + 58, LINE);
    pdf.text(k, tx + 14, y + 21, SANS, 9.5, MUTED);
    pdf.text(v, tx + 14, y + 43, BOLD, 15, INK);
  });
  y += 84;

  // day by day
  room(190);
  heading("Day by day");
  const H = 120;
  const top = Math.max(...r.byDay, 1);
  const col = W / r.byDay.length;
  r.byDay.forEach((amount, i) => {
    const bx = M + i * col + 1.2;
    if (!amount) pdf.rect(bx, y + H - 1.5, col - 2.4, 1.5, LINE);
    else {
      const h = Math.max(3, (amount / top) * H);
      const best = r.bestDay && amount === r.bestDay.amount;
      pdf.rect(bx, y + H - h, col - 2.4, h, best ? ACCENT : "#d58a5c", { radius: 1.5 });
    }
    if (i % 7 === 0) pdf.text(String(i + 1), bx + (col - 2.4) / 2, y + H + 13, SANS, 8.5, MUTED, { align: "center" });
  });
  y += H + 32;
  pdf.text(
    r.bestDay
      ? "The tallest bar is " + short(key) + " " + r.bestDay.day + ": " + rupees(r.bestDay.amount) + "."
      : "No confirmed payments this month.",
    M,
    y,
    SANS,
    10,
    MUTED,
  );
  y += 30;

  // the last twelve months
  room(30 + r.months.length * 20);
  heading("Last " + (r.months.length === 1 ? "month" : r.months.length + " months"));
  const topMonth = Math.max(...r.months.map((m) => m.total), 1);
  const barX = M + 58;
  const barW = W - 58 - 80;
  for (const m of r.months) {
    const mine = m.key === key;
    pdf.text(
      monthName(m.key, { month: "short", year: "2-digit" }).replace(" ", " ’"),
      M,
      y + 10,
      mine ? BOLD : SANS,
      10,
      mine ? INK : MUTED,
    );
    const w = (m.total / topMonth) * barW;
    pdf.rect(barX, y + 1, Math.max(w, 2), 11, m.total ? (mine ? ACCENT : BAR) : LINE, { radius: m.total ? 2.5 : 0 });
    pdf.text(rupees(m.total), M + W, y + 10, mine ? BOLD : SANS, 10, INK, { align: "right" });
    y += 20;
  }
  y += 14;

  // what still waits for a decision
  if (r.pendingCount) {
    const note =
      rupees(r.pending) +
      " from " +
      (r.pendingCount === 1 ? "1 payment" : r.pendingCount + " payments") +
      " made in " +
      monthName(key, { month: "long" }) +
      " still " +
      (r.pendingCount === 1 ? "waits" : "wait") +
      " for a decision. It counts here once confirmed in the Payments tab.";
    const lines = pdf.wrap(note, SANS, 10.5, W - 28);
    const h = 22 + lines.length * 15;
    room(h + 20);
    pdf.rect(M, y, W, h, "#f6e7dc", { radius: 8 });
    lines.forEach((l, i) => pdf.text(l, M + 14, y + 19 + i * 15, SANS, 10.5, INK));
    y += h + 26;
  }

  // who paid
  if (r.who.length) {
    room(70);
    heading("Who paid");
    for (const p of r.who) {
      if (y + 36 > PAGE_H - M) {
        pdf.addPage();
        y = M;
        heading("Who paid (continued)");
      }
      pdf.line(M, y, M + W, y, LINE);
      pdf.text(p.name, M, y + 16, BOLD, 10.5, INK);
      pdf.text(p.email, M, y + 29, SANS, 9, MUTED);
      pdf.text(p.count === 1 ? "1 payment" : p.count + " payments", M + W - 96, y + 20, SANS, 10, MUTED, { align: "right" });
      pdf.text(rupees(p.total), M + W, y + 20, BOLD, 10.5, INK, { align: "right" });
      y += 38;
    }
    pdf.line(M, y, M + W, y, LINE);
    y += 26;
  }

  room(70);
  const lead = "Confirmed since the first payment: ";
  pdf.text(lead, M, y, SANS, 11, INK);
  pdf.text(rupees(r.toDate), M + pdf.width(lead, SANS, 11), y, BOLD, 11, INK);
  y += 22;
  const foot = pdf.wrap(
    "Counts confirmed payments only, in the month they were made (India time), as of when this was made. Pending and discarded payments are left out of the totals.",
    SANS,
    9,
    W,
  );
  foot.forEach((l, i) => pdf.text(l, M, y + i * 13, SANS, 9, MUTED));
  return pdf.build("Hi-Techie revenue report: " + monthName(key));
}
// The PDF as a download, for GET /admin/api/revenue.pdf?month=YYYY-MM (last month when no month is given).
export function reportPdfResponse(month: string) {
  const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : lastMonthKey();
  return new Response(reportPdf(key), {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="revenue-report-' + key + '.pdf"',
    },
  });
}
