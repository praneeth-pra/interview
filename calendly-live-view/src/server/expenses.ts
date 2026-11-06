// Expenses (expenses.json), kept in the owners' Revenue tab to see where the money candidates pay goes. Each one is a
// row the owner types in: the India day it was paid, what it was for, a category, the amount, and optionally the
// candidate it was spent on (by their payments' email). Owners add, change and delete them; nobody else sees them.
import { EXPENSE_CATEGORIES, type Expense, expensesStore, paymentsStore } from "./data";
import { json, saveOrUndo } from "./http";
import { istDate } from "./time";
import { DATE_KEY, EMAIL_RE, type Fields, normEmail } from "./util";

const AMOUNT_MAX = 10000000;
const MAX_EXPENSES = 5000;

// the fields of an expense from a request body, or the error to answer with
function readExpense(body: Fields): Omit<Expense, "id" | "createdAt" | "by"> | string {
  const date = String(body?.date ?? "").trim();
  const what = String(body?.what ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const category = String(body?.category ?? "");
  const amountText = String(body?.amount ?? "").replace(/[,\s₹]/g, "");
  const amount = /^\d+(\.\d{1,2})?$/.test(amountText) ? Number(amountText) : NaN;
  const email = normEmail(body?.email);
  if (!DATE_KEY.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z"))) return "Pick the day it was paid.";
  if (date > istDate(new Date().toISOString())) return "That day hasn't come yet.";
  if (date < "2020-01-01") return "Pick the day it was paid.";
  if (!what) return "Say what it was for.";
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) return "Pick a category.";
  if (!(amount > 0) || amount > AMOUNT_MAX) return "Enter the amount paid, in rupees.";
  if (email && !EMAIL_RE.test(email)) return "Pick the candidate again.";
  // the candidate's latest name from their payments, so the row still reads well if they're renamed later
  let name = "";
  if (email) {
    const theirs = paymentsStore.data.payments.filter((p) => normEmail(p.email) === email);
    if (!theirs.length) return "That candidate has no payments. Pick another, or leave it as a general cost.";
    name = theirs.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).name;
  }
  return { date, what, category, amount, email, name };
}

// POST /admin/api/expenses: { date, what, category, amount, email? }
export async function addExpense(body: Fields, by: string): Promise<Response> {
  const fields = readExpense(body);
  if (typeof fields === "string") return json({ error: fields }, 400);
  const prev = expensesStore.data.expenses;
  if (prev.length >= MAX_EXPENSES) return json({ error: "There are too many expenses saved." }, 409);
  const expense: Expense = { id: crypto.randomUUID(), ...fields, createdAt: new Date().toISOString(), by };
  expensesStore.data.expenses = [...prev, expense];
  const failed = await saveOrUndo(expensesStore, () => (expensesStore.data.expenses = prev));
  return failed ?? json({ ok: true, id: expense.id });
}
// POST /admin/api/expenses/update: { id, date, what, category, amount, email? }
export async function updateExpense(body: Fields, by: string): Promise<Response> {
  const id = String(body?.id ?? "");
  const prev = expensesStore.data.expenses;
  const old = prev.find((e) => e.id === id);
  if (!old) return json({ error: "That expense was deleted." }, 404);
  const fields = readExpense(body);
  if (typeof fields === "string") return json({ error: fields }, 400);
  expensesStore.data.expenses = prev.map((e) => (e.id === id ? { ...old, ...fields, by } : e));
  const failed = await saveOrUndo(expensesStore, () => (expensesStore.data.expenses = prev));
  return failed ?? json({ ok: true });
}
// POST /admin/api/expenses/delete: { id }
export async function deleteExpense(id: string): Promise<Response> {
  const prev = expensesStore.data.expenses;
  if (!prev.some((e) => e.id === id)) return json({ error: "That expense was already deleted." }, 404);
  expensesStore.data.expenses = prev.filter((e) => e.id !== id);
  const failed = await saveOrUndo(expensesStore, () => (expensesStore.data.expenses = prev));
  return failed ?? json({ ok: true });
}
