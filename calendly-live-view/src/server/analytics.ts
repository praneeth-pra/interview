// The owners' Analytics tab: revenue from payments, bookings and their rounds, and how enquiries turn into candidates,
// for everyone or for the candidates whose name or email contains what was typed in its search box.
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

// the search box's rule, as in the Payments tab: the name or email contains what was typed
function matcher(query: string) {
  const q = query.trim().toLowerCase();
  return (v: { name: string; email: string }) => !q || v.name.toLowerCase().includes(q) || normEmail(v.email).includes(q);
}

export function analyticsView(query = "", now = Date.now()) {
  const q = query.trim();
  const mine = matcher(query);
  // everyone the search finds, by email (latest name), so the page can say whose figures it shows
  const found = new Map<string, string>();
  const note = (v: { name: string; email: string }) => q && found.set(normEmail(v.email), v.name);
  const months = lastMonths(now);
  const month = (key: string) => months.indexOf(key);
  const revenue = months.map(() => 0);
  const paid = months.map(() => 0);
  const booked = months.map(() => 0);
  const enquired = months.map(() => 0);

  const payers = new Set<string>();
  let total = 0;
  let count = 0;
  let pending = 0;
  let pendingCount = 0;
  for (const v of paymentsStore.data.payments) {
    if (v.decision === "discarded" || !mine(v)) continue;
    note(v);
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
    payers.add(normEmail(v.email));
  }

  // Rounds: each booking that wasn't cancelled, by what became of it.
  const rounds = { upcoming: 0, done: 0, cleared: 0, rejected: 0, hold: 0, missed: 0, cancelled: 0 };
  const bookers = new Set<string>();
  for (const b of bookingsStore.data.bookings) {
    if (!mine(b)) continue;
    note(b);
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
  let enquiries = 0;
  for (const v of enquiriesStore.data.enquiries) {
    if (!mine(v)) continue;
    note(v);
    enquiries++;
    enquirers.add(normEmail(v.email));
    const i = month(monthKey(v.createdAt));
    if (i >= 0) enquired[i]++;
  }
  let enquiryBooked = 0;
  let enquiryPaid = 0;
  for (const email of enquirers) {
    if (bookers.has(email)) enquiryBooked++;
    if (payers.has(email)) enquiryPaid++;
  }

  return {
    months,
    revenue: { total, count, pending, pendingCount, payers: payers.size, byMonth: revenue, paidByMonth: paid },
    found: [...found].map(([email, name]) => ({ name, email })).sort((a, b) => a.name.localeCompare(b.name)),
    bookings: { byMonth: booked, rounds, candidates: bookers.size },
    enquiries: { total: enquiries, people: enquirers.size, booked: enquiryBooked, paid: enquiryPaid, byMonth: enquired },
  };
}

// One row per payment that isn't discarded (for the searched candidates only, after a search), for a spreadsheet.
export function analyticsCsv(query = "") {
  const mine = matcher(query);
  const status = (d?: string) => (d === "confirmed" ? "Confirmed" : "Pending");
  const rows = [["Date", "Month", "Name", "Email", "Installment", "Amount (INR)", "Status", "Confirmed on"]];
  for (const v of [...paymentsStore.data.payments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (v.decision === "discarded") continue;
    if (!mine(v)) continue;
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
