// The owners' Revenue tab: confirmed payments month by month and added up, for everyone or for the candidates whose name
// or email contains what was typed in its search box.
// Revenue counts confirmed payments only, like the Payments tab's totals; pending ones are shown apart, discarded ones
// not at all. Months are India months, and a payment counts in the month it was sent.
// Expenses sit beside it: what was spent each month, what was spent on each candidate (expenses tied to their email),
// and the general costs tied to nobody. A search narrows the expenses to the candidates it finds, so general costs drop
// out; with one candidate found, their confirmed payments and expenses make up their ledger.
import { BASE_HEADERS } from "./http";
import { csvCell } from "./bookings";
import { EXPENSE_CATEGORIES, INSTALLMENT_NAMES, expensesStore, ivStore, paymentsStore } from "./data";
import { istDate, istParts, istToUtcMs } from "./time";
import { normEmail, pad } from "./util";

const MONTHS = 12;
export const monthKey = (iso: string) => {
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
  // "This month" is compared with last month up to the same point (Oct 1-2 against Sep 1-2), not with all of last month
  const p = istParts(now);
  const thisStart = istToUtcMs(p.y, p.mo, 1, 0);
  const lastStart = istToUtcMs(p.mo === 1 ? p.y - 1 : p.y, p.mo === 1 ? 12 : p.mo - 1, 1, 0);
  const lastCutoff = Math.min(thisStart, lastStart + (now - thisStart));
  let lastToDate = 0;
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
    if (i === months.length - 2 && Date.parse(v.createdAt) < lastCutoff) lastToDate += v.amount;
    if (i >= 0) {
      byMonth[i] += v.amount;
      paidByMonth[i]++;
    } else if (key < months[0]) before += v.amount;
  }
  // expenses: by month, tied to a candidate or general, for the search's candidates (or everyone)
  const spentByMonth = months.map(() => 0);
  let spent = 0;
  let spentCount = 0;
  let general = 0;
  let linked = 0;
  const spentOn = new Map<string, { name: string; total: number }>();
  const expenses = expensesStore.data.expenses
    .filter((e) => (e.email ? mine({ name: people.get(e.email)?.name ?? e.name, email: e.email }) : !query.trim()))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  for (const e of expenses) {
    spent += e.amount;
    spentCount++;
    const i = month(e.date.slice(0, 7));
    if (i >= 0) spentByMonth[i] += e.amount;
    if (!e.email) {
      general += e.amount;
      continue;
    }
    linked++;
    const on = spentOn.get(e.email) ?? { name: people.get(e.email)?.name ?? e.name, total: 0 };
    on.total += e.amount;
    spentOn.set(e.email, on);
  }
  // each candidate the search finds (everyone without one) who paid or had money spent on them: paid in and spent
  const byCandidate = [...new Set([...people.keys(), ...spentOn.keys()])]
    .map((email) => {
      const p = people.get(email);
      return { name: p?.name ?? spentOn.get(email)!.name, email, paid: p?.total ?? 0, spent: spentOn.get(email)?.total ?? 0 };
    })
    .filter((c) => (c.paid || c.spent) && mine(c))
    .sort((a, b) => b.paid - b.spent - (a.paid - a.spent) || a.name.localeCompare(b.name));
  // the found candidates' confirmed payments, for their ledger
  const paidIn = query.trim()
    ? paymentsStore.data.payments
        .filter((v) => v.decision === "confirmed" && mine(v))
        .map((v) => ({
          id: v.id,
          date: istDate(v.createdAt),
          amount: v.amount,
          installment: v.installment ? INSTALLMENT_NAMES[v.installment] : "",
          email: normEmail(v.email),
        }))
        .sort((a, b) => b.date.localeCompare(a.date))
    : [];
  const candidates = [...people.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ name: p.name, email: p.email, total: p.total }));
  return {
    months,
    revenue: { total, count, pending, pendingCount, payers: payers.size, before, byMonth, paidByMonth, lastToDate },
    spent: { total: spent, count: spentCount, byMonth: spentByMonth, general, linked },
    byCandidate,
    expenses: expenses.slice(0, 500),
    paidIn,
    categories: EXPENSE_CATEGORIES,
    supporters: ivStore.data.names,
    candidates,
    found: query.trim() ? candidates.filter(mine).map((p) => ({ name: p.name, email: p.email })) : [],
  };
}

// One row per payment that isn't discarded (for the searched candidates only, after a search, and only the payments
// of one month when it is given), for a spreadsheet.
export function analyticsCsvText(query = "", month = "") {
  const mine = matcher(query);
  const status = (d?: string) => (d === "confirmed" ? "Confirmed" : "Pending");
  const rows = [["Date", "Month", "Name", "Email", "Installment", "Amount (INR)", "Status", "Confirmed on"]];
  for (const v of [...paymentsStore.data.payments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (v.decision === "discarded") continue;
    if (!mine(v) || (month && monthKey(v.createdAt) !== month)) continue;
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
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export function analyticsCsv(query = "") {
  return new Response(analyticsCsvText(query), {
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="payments-' + istDate(new Date().toISOString()) + '.csv"',
    },
  });
}
