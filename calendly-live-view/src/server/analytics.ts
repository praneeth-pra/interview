// The owners' Analytics tab: revenue from payments, bookings and their rounds, and how enquiries turn into candidates.
// Revenue counts confirmed payments only, like the Payments tab's totals; pending ones are shown apart, discarded ones
// not at all. Months are India months, and a payment counts in the month it was sent.
import { BASE_HEADERS } from "./http";
import { csvCell } from "./bookings";
import { INSTALLMENTS, bookingsStore, enquiriesStore, paymentsStore } from "./data";
import { istDate, istParts } from "./time";
import { normEmail, pad } from "./util";

const MONTHS = 12;
const monthKey = (iso: string) => {
  const p = istParts(Date.parse(iso));
  return p.y + "-" + pad(p.mo);
};
// the last twelve months, oldest first, ending with this one
function lastMonths(now: number) {
  const p = istParts(now);
  const out: string[] = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const m = p.y * 12 + (p.mo - 1) - i;
    out.push(Math.floor(m / 12) + "-" + pad((m % 12) + 1));
  }
  return out;
}

export function analyticsView(now = Date.now()) {
  const months = lastMonths(now);
  const month = (key: string) => months.indexOf(key);
  const revenue = months.map(() => 0);
  const paid = months.map(() => 0);
  const booked = months.map(() => 0);
  const enquired = months.map(() => 0);

  const installments: Record<string, { total: number; count: number }> = {};
  for (const k of [...Object.keys(INSTALLMENTS), ""]) installments[k] = { total: 0, count: 0 };
  const people: Record<string, { name: string; email: string; total: number; count: number; last: string }> = {};
  let total = 0;
  let count = 0;
  let pending = 0;
  let pendingCount = 0;
  for (const v of paymentsStore.data.payments) {
    if (v.decision === "discarded") continue;
    if (v.decision !== "confirmed") {
      pending += v.amount;
      pendingCount++;
      continue;
    }
    total += v.amount;
    count++;
    const i = month(monthKey(v.createdAt));
    if (i >= 0) {
      revenue[i] += v.amount;
      paid[i]++;
    }
    const part = installments[v.installment ?? ""] ?? installments[""];
    part.total += v.amount;
    part.count++;
    const email = normEmail(v.email);
    const p = (people[email] ??= { name: v.name, email, total: 0, count: 0, last: v.createdAt });
    p.total += v.amount;
    p.count++;
    if (v.createdAt >= p.last) {
      p.last = v.createdAt;
      p.name = v.name;
    }
  }

  // Rounds: each booking that wasn't cancelled, by what became of it.
  const rounds = { upcoming: 0, done: 0, cleared: 0, rejected: 0, hold: 0, missed: 0, cancelled: 0 };
  const bookers = new Set<string>();
  for (const b of bookingsStore.data.bookings) {
    if (b.cancelled) {
      rounds.cancelled++;
      continue;
    }
    bookers.add(normEmail(b.email));
    const i = month(monthKey(b.start));
    if (i >= 0) booked[i]++;
    if (b.outcome) rounds[b.outcome]++;
    else if (b.missed) rounds.missed++;
    else if (Date.parse(b.end) <= now) rounds.done++;
    else rounds.upcoming++;
  }

  // Enquiries: people (by email) who sent one, and how many of them went on to book and to pay.
  const enquirers = new Set<string>();
  for (const v of enquiriesStore.data.enquiries) {
    enquirers.add(normEmail(v.email));
    const i = month(monthKey(v.createdAt));
    if (i >= 0) enquired[i]++;
  }
  const payers = new Set(Object.keys(people));
  let enquiryBooked = 0;
  let enquiryPaid = 0;
  for (const email of enquirers) {
    if (bookers.has(email)) enquiryBooked++;
    if (payers.has(email)) enquiryPaid++;
  }

  return {
    months,
    revenue: { total, count, pending, pendingCount, payers: payers.size, byMonth: revenue, paidByMonth: paid },
    installments: Object.entries(installments).map(([key, v]) => ({ key, ...v })),
    candidates: Object.values(people).sort((a, b) => b.total - a.total || b.last.localeCompare(a.last)),
    bookings: { byMonth: booked, rounds, candidates: bookers.size },
    enquiries: { total: enquiriesStore.data.enquiries.length, people: enquirers.size, booked: enquiryBooked, paid: enquiryPaid, byMonth: enquired },
  };
}

// One row per payment that isn't discarded, for a spreadsheet or Power BI.
export function analyticsCsv() {
  const status = (d?: string) => (d === "confirmed" ? "Confirmed" : "Pending");
  const rows = [["Date", "Month", "Name", "Email", "Installment", "Amount (INR)", "Status", "Confirmed on"]];
  for (const v of [...paymentsStore.data.payments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (v.decision === "discarded") continue;
    rows.push([
      istDate(v.createdAt),
      monthKey(v.createdAt),
      v.name,
      normEmail(v.email),
      v.installment ? INSTALLMENTS[v.installment] : "",
      String(v.amount),
      status(v.decision),
      v.decision === "confirmed" ? istDate(v.decidedAt ?? "") : "",
    ]);
  }
  return new Response("﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payments-' + istDate(new Date().toISOString()) + '.csv"',
    },
  });
}
