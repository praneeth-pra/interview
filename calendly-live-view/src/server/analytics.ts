// The owners' Revenue tab: confirmed payments month by month and added up, for everyone or for the candidates whose name
// or email contains what was typed in its search box.
// Revenue counts confirmed payments only, like the Payments tab's totals; pending ones are shown apart, discarded ones
// not at all. Months are India months, and a payment counts in the month it was sent.
import { BASE_HEADERS } from "./http";
import { csvCell } from "./bookings";
import { INSTALLMENT_NAMES, paymentsStore } from "./data";
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
  const mine = matcher(query);
  const months = lastMonths(now);
  const month = (key: string) => months.indexOf(key);
  const byMonth = months.map(() => 0);
  const paidByMonth = months.map(() => 0);
  // confirmed before the first month shown, so the cumulative line starts from what was already paid
  let before = 0;
  let total = 0;
  let count = 0;
  let pending = 0;
  let pendingCount = 0;
  const payers = new Set<string>();
  // everyone with a payment that isn't discarded (latest name first), for the search box's suggestions
  const people = new Map<string, { name: string; email: string; total: number; last: string }>();
  for (const v of paymentsStore.data.payments) {
    if (v.decision === "discarded") continue;
    const email = normEmail(v.email);
    const p = people.get(email) ?? { name: v.name, email, total: 0, last: "" };
    if (v.createdAt >= p.last) {
      p.last = v.createdAt;
      p.name = v.name;
    }
    if (v.decision === "confirmed") p.total += v.amount;
    people.set(email, p);
    if (!mine(v)) continue;
    if (v.decision !== "confirmed") {
      pending += v.amount;
      pendingCount++;
      continue;
    }
    total += v.amount;
    count++;
    payers.add(email);
    const key = monthKey(v.createdAt);
    const i = month(key);
    if (i >= 0) {
      byMonth[i] += v.amount;
      paidByMonth[i]++;
    } else if (key < months[0]) before += v.amount;
  }
  const candidates = [...people.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ name: p.name, email: p.email, total: p.total }));
  return {
    months,
    revenue: { total, count, pending, pendingCount, payers: payers.size, before, byMonth, paidByMonth },
    candidates,
    found: query.trim() ? candidates.filter(mine).map((p) => ({ name: p.name, email: p.email })) : [],
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
      v.installment ? INSTALLMENT_NAMES[v.installment] : "",
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
