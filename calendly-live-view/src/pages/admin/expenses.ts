// Expenses in the Revenue tab (owners only): where the money candidates pay goes. With everyone shown, a "By candidate"
// table (paid in, spent on them, kept) and the list of every expense; with one candidate found by the search,
// their ledger: confirmed payments in and expenses out, newest first, with what's kept after each. Expenses are rows
// typed straight into the list: the top row is blank to add one (Enter saves it and opens the next), and tapping an
// expense opens it the same way to change or delete it.
import { request } from "./api";
import { el, onEnterOrSpace, toast } from "./dom";
import { titleCase } from "./labels";
import { TIME_ZONE } from "./time";

export type Expense = {
  id: string;
  date: string;
  what: string; // why it was paid
  paidTo?: string; // the interview supporter it was paid to, if any
  category: string;
  amount: number;
  email: string;
  name: string;
};
export type PaidIn = { id: string; date: string; amount: number; installment: string; email: string };
export type ByCandidate = { name: string; email: string; paid: number; spent: number };
export type Money = {
  expenses: Expense[];
  paidIn: PaidIn[];
  byCandidate: ByCandidate[];
  categories: string[];
  supporters: string[];
  candidates: { name: string; email: string; total: number }[];
};
type Hooks = {
  // load the figures again, after a change
  refresh: () => void;
  // show one candidate, as picking them in the search does
  pick: (email: string, name: string) => void;
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function rupees(amount: number) {
  return (amount < 0 ? "−" : "") + "₹" + Math.abs(amount).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
// today in India, as YYYY-MM-DD
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}
// "24 Oct", with the year only when it isn't this year
function dayText(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return d + " " + MONTH_NAMES[m - 1] + (String(y) === today().slice(0, 4) ? "" : " " + y);
}

// what's open for typing: "new" (the blank row), an expense's id, or nothing. It stays open across redraws.
let editing: string | null = null;
let ledgerShow: "all" | "in" | "out" = "all";
// the "+ Add expense" button at the top asks for the blank row; it's opened once the list is drawn
let wantNew = false;
export function openNewExpense() {
  editing = "new";
  wantNew = true;
}

// The row of inputs for a new expense, or to change one. candidate: the email it's tied to, fixed in a candidate's
// ledger (null shows the candidate picker). cols: how many columns the table has.
function editRows(money: Money, hooks: Hooks, item: Expense | null, candidate: string | null, cols: number) {
  const date = el("input", { type: "date", value: item ? item.date : today(), max: today(), "aria-label": "Day it was paid" });
  // who it was paid to: one of the interview supporters, or nobody (a tool, an ad); a name since removed from the
  // list stays on its expense
  const current = item && item.paidTo ? item.paidTo : "";
  const names = money.supporters.indexOf(current) < 0 && current ? money.supporters.concat([current]) : money.supporters;
  const paidTo = el(
    "select",
    { "aria-label": "Supporter it was paid to" },
    [el("option", { value: "", text: "None" })].concat(
      names.map(function (n) {
        return el("option", { value: n, text: n, selected: n === current });
      }),
    ),
  );
  const what = el("input", {
    type: "text",
    value: item ? item.what : "",
    maxlength: "120",
    placeholder: "Why? (e.g. 3 mock interviews)",
    "aria-label": "Why it was paid",
  });
  const category = el(
    "select",
    { "aria-label": "Category" },
    money.categories.map(function (c) {
      return el("option", { value: c, text: c, selected: item ? item.category === c : false });
    }),
  );
  let who: HTMLSelectElement | null = null;
  if (candidate === null) {
    const current = item ? item.email : "";
    const options = [el("option", { value: "", text: "No candidate (general)" })];
    const known = money.candidates.some(function (p) {
      return p.email === current;
    });
    if (current && !known) {
      options.push(el("option", { value: current, text: titleCase(item!.name) || current, selected: true }));
    }
    money.candidates.forEach(function (p) {
      options.push(el("option", { value: p.email, text: titleCase(p.name), selected: p.email === current }));
    });
    who = el("select", { "aria-label": "Candidate it was spent on" }, options);
  }
  const amount = el("input", {
    type: "text",
    inputmode: "decimal",
    value: item ? String(item.amount) : "",
    placeholder: "₹",
    "aria-label": "Amount in rupees",
  });
  const msg = el("p", { class: "msg", role: "status" });
  const save = el("button", { type: "button", class: "pri", text: item ? "Save" : "Save row" });
  function submit() {
    save.disabled = true;
    const body = {
      id: item ? item.id : undefined,
      date: date.value,
      what: what.value,
      paidTo: paidTo.value,
      category: category.value,
      amount: amount.value,
      email: candidate !== null ? candidate : who!.value,
    };
    request(item ? "/admin/api/expenses/update" : "/admin/api/expenses", body)
      .then(function () {
        toast(item ? "Expense saved" : "Expense added");
        // a new row saved opens the next blank one, ready for the next expense
        if (item) {
          editing = null;
        } else {
          wantNew = true;
        }
        hooks.refresh();
      })
      .catch(function (error) {
        save.disabled = false;
        msg.textContent = error.message;
        msg.className = "msg err";
      });
  }
  save.onclick = submit;
  const cancel = el("button", {
    type: "button",
    class: "ghost",
    text: "Cancel",
    onclick: function () {
      editing = null;
      hooks.refresh();
    },
  });
  // deleting takes a second tap, so a stray one doesn't lose a row
  let armed = false;
  const remove = item
    ? el("button", {
        type: "button",
        class: "ghost xp-del",
        text: "Delete",
        onclick: function () {
          if (!armed) {
            armed = true;
            remove!.textContent = "Tap again to delete";
            setTimeout(function () {
              armed = false;
              remove!.textContent = "Delete";
            }, 3000);
            return;
          }
          remove!.disabled = true;
          request("/admin/api/expenses/delete", { id: item.id })
            .then(function () {
              toast("Expense deleted");
              editing = null;
              hooks.refresh();
            })
            .catch(function (error) {
              remove!.disabled = false;
              msg.textContent = error.message;
              msg.className = "msg err";
            });
        },
      })
    : null;
  const keys = function (event: Event) {
    const key = (event as KeyboardEvent).key;
    if (key === "Enter") {
      event.preventDefault();
      submit();
    } else if (key === "Escape") {
      event.preventDefault();
      cancel.click();
    }
  };
  [date, paidTo, what, category, amount, who].forEach(function (input) {
    if (input) {
      input.addEventListener("keydown", keys);
    }
  });
  // one cell across the table holding a grid: date, supporter, why (with category and candidate under it), amount
  // side by side on wide screens, stacked in two columns on phones
  const fields = el("tr", { class: "xp-edit" }, [
    el("td", { colspan: String(cols) }, [
      el("div", { class: "xp-form" + (cols > 4 ? " xp-ledger" : "") }, [
        el("div", { class: "xp-f-date" }, [date]),
        el("div", { class: "xp-f-to" }, [paidTo]),
        el("div", { class: "xp-f-why" }, [what]),
        el("div", { class: "xp-f-amt" }, [amount]),
        el("div", { class: "xp-pick" }, [category, who]),
      ]),
    ]),
  ]);
  const actions = el("tr", { class: "xp-edit xp-acts" }, [
    el("td", { colspan: String(cols) }, [el("div", { class: "xp-btns" }, [msg, remove, cancel, save])]),
  ]);
  return { rows: [fields, actions], focus: item ? amount : paidTo };
}

// one expense, as a row: tapping it opens it for changes
function expenseRow(item: Expense, showName: boolean, cols: number, kept: number | null, hooks: Hooks) {
  const open = function () {
    editing = item.id;
    hooks.refresh();
  };
  // phones have no Supporter column, so the supporter leads the line under why
  const sub = item.category + (showName && item.email ? " · " + titleCase(item.name) : showName ? " · General" : "");
  return el("tr", { class: "tap", tabindex: "0", title: "Change or delete this expense", onclick: open, onkeydown: onEnterOrSpace(open) }, [
    el("td", { class: "dt", text: dayText(item.date) }),
    el("td", { class: "xp-to", text: item.paidTo || "\u2014" }),
    el("td", { class: "xp-what" }, [
      cols > 4 ? el("span", { class: "xp-tag out", text: "Out" }) : null,
      item.what,
      el("small", null, [item.paidTo ? el("span", { class: "xp-tom", text: item.paidTo + " \u00B7 " }) : null, sub]),
    ]),
    el("td", { class: "num xp-o" }, [
      "−" + rupees(item.amount),
      kept === null ? null : el("small", { class: "xp-keptm", text: rupees(kept) + " kept" }),
    ]),
    kept === null ? null : el("td", { class: "num xp-bal", text: rupees(kept) }),
  ]);
}

// The rows of a list of expenses (or a ledger), with the blank row on top and the one being changed opened
function fillBody(
  tbody: HTMLElement,
  money: Money,
  hooks: Hooks,
  rows: { item?: Expense; paid?: PaidIn; kept: number | null }[],
  candidate: string | null,
  cols: number,
) {
  let focus: HTMLElement | null = null;
  if (editing === "new") {
    const blank = editRows(money, hooks, null, candidate, cols);
    blank.rows.forEach(function (r) {
      tbody.appendChild(r);
    });
    focus = blank.focus;
  }
  rows.forEach(function (row) {
    if (row.paid) {
      const p = row.paid;
      tbody.appendChild(
        el("tr", null, [
          el("td", { class: "dt", text: dayText(p.date) }),
          el("td", { class: "xp-to", text: "\u2014" }),
          el("td", { class: "xp-what" }, [
            el("span", { class: "xp-tag in", text: "In" }),
            "Payment" + (p.installment ? ", " + p.installment.toLowerCase() : ""),
            el("small", { text: "Confirmed" }),
          ]),
          el("td", { class: "num xp-i" }, ["+" + rupees(p.amount), el("small", { class: "xp-keptm", text: rupees(row.kept!) + " kept" })]),
          el("td", { class: "num xp-bal", text: rupees(row.kept!) }),
        ]),
      );
      return;
    }
    const item = row.item!;
    if (editing === item.id) {
      const open = editRows(money, hooks, item, candidate, cols);
      open.rows.forEach(function (r) {
        tbody.appendChild(r);
      });
      focus = open.focus;
    } else {
      tbody.appendChild(expenseRow(item, candidate === null, cols, row.kept, hooks));
    }
  });
  return focus;
}
function addButton(text: string, hooks: Hooks) {
  return el("button", {
    type: "button",
    class: "xp-addrow",
    text: text,
    onclick: function () {
      openNewExpense();
      hooks.refresh();
    },
  });
}
function focusLater(input: HTMLElement | null, section: HTMLElement) {
  if (!input || !wantNew) {
    return;
  }
  wantNew = false;
  requestAnimationFrame(function () {
    section.scrollIntoView({ block: "nearest", behavior: "smooth" });
    input.focus({ preventScroll: true });
  });
}

// One candidate's ledger: their confirmed payments in and the expenses tied to them, newest first, with what's kept
// after each one.
export function drawLedger(body: HTMLElement, money: Money, hooks: Hooks, who: { name: string; email: string }) {
  const first = titleCase(who.name).split(" ")[0];
  const entries: { date: string; item?: Expense; paid?: PaidIn; kept: number | null }[] = [];
  money.paidIn.forEach(function (p) {
    entries.push({ date: p.date, paid: p, kept: 0 });
  });
  money.expenses.forEach(function (e) {
    entries.push({ date: e.date, item: e, kept: 0 });
  });
  // oldest first to add up what's kept, then newest first to show; on one day, payments count before expenses
  entries.sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.paid ? -1 : b.paid ? 1 : 0;
  });
  let kept = 0;
  entries.forEach(function (row) {
    kept += row.paid ? row.paid.amount : -row.item!.amount;
    row.kept = kept;
  });
  entries.reverse();
  const shown = entries.filter(function (row) {
    return ledgerShow === "all" || (ledgerShow === "in" ? !!row.paid : !!row.item);
  });
  function chip(value: "all" | "in" | "out", label: string) {
    return el("button", {
      type: "button",
      class: "paychip",
      "aria-pressed": String(ledgerShow === value),
      text: label,
      onclick: function () {
        ledgerShow = value;
        hooks.refresh();
      },
    });
  }
  const tbody = el("tbody");
  const focus = fillBody(tbody, money, hooks, shown, who.email, 5);
  const section = el("section", { class: "rv-sec xp-list", id: "xpList" }, [
    el("div", { class: "rv-sh" }, [
      el("div", null, [
        el("h3", { text: first + "’s ledger" }),
        el("p", {
          class: "sub",
          text: "Payments in and expenses out, newest first, with what’s kept after each. Tap an expense to change it.",
        }),
      ]),
      el("div", { class: "paychips", role: "group", "aria-label": "Show" }, [chip("all", "All"), chip("in", "In"), chip("out", "Out")]),
    ]),
    el("div", { class: "enqlist paytbl xp-tbl" }, [
      el("table", null, [
        el("thead", null, [
          el("tr", null, [
            el("th", { scope: "col", text: "Date" }),
            el("th", { scope: "col", class: "xp-to", text: "Supporter" }),
            el("th", { scope: "col", text: "Why" }),
            el("th", { scope: "col", class: "num", text: "Amount" }),
            el("th", { scope: "col", class: "num xp-bal", text: "Kept" }),
          ]),
        ]),
        tbody,
      ]),
      !shown.length && editing !== "new" ? el("p", { class: "sub xp-none", text: "Nothing here yet." }) : null,
      editing === "new" ? null : addButton("+ Add an expense for " + first, hooks),
    ]),
  ]);
  body.appendChild(section);
  focusLater(focus, section);
}

// Everyone (or several candidates found): each candidate's paid in, spent and kept, the general costs, then every
// expense.
export function drawByCandidate(body: HTMLElement, money: Money, hooks: Hooks, general: number, searching: boolean) {
  if (money.byCandidate.length || general) {
    const rows = money.byCandidate.map(function (c) {
      const kept = c.paid - c.spent;
      const open = function () {
        hooks.pick(c.email, c.name);
      };
      return el(
        "tr",
        { class: "tap", tabindex: "0", title: "Show " + titleCase(c.name) + "’s ledger", onclick: open, onkeydown: onEnterOrSpace(open) },
        [
          el("td", null, [el("b", { text: titleCase(c.name) }), el("small", { text: c.email })]),
          el("td", { class: "num xp-c", text: rupees(c.paid) }),
          el("td", { class: "num xp-c xp-o", text: c.spent ? "−" + rupees(c.spent) : "—" }),
          el("td", { class: "num" }, [el("b", { text: rupees(kept) })]),
        ],
      );
    });
    if (general && !searching) {
      rows.push(
        el("tr", { class: "xp-gen" }, [
          el("td", null, [el("b", { text: "General costs" }), el("small", { text: "Not tied to a candidate" })]),
          el("td", { class: "num xp-c", text: "—" }),
          el("td", { class: "num xp-c xp-o", text: "−" + rupees(general) }),
          el("td", { class: "num" }, [el("b", { text: rupees(-general) })]),
        ]),
      );
    }
    body.appendChild(
      el("section", { class: "rv-sec" }, [
        el("div", { class: "rv-sh" }, [
          el("div", null, [
            el("h3", { text: "By candidate" }),
            el("p", {
              class: "sub",
              text: "What each candidate paid, what was spent on them and what you kept. Tap one to see their ledger.",
            }),
          ]),
        ]),
        el("div", { class: "enqlist paytbl xp-tbl xp-cands" }, [
          el("table", null, [
            el("thead", null, [
              el("tr", null, [
                el("th", { scope: "col", text: "Candidate" }),
                el("th", { scope: "col", class: "num xp-c", text: "Paid in" }),
                el("th", { scope: "col", class: "num xp-c", text: "Spent" }),
                el("th", { scope: "col", class: "num", text: "Kept" }),
              ]),
            ]),
            el("tbody", null, rows),
          ]),
        ]),
      ]),
    );
  }
  const tbody = el("tbody");
  const focus = fillBody(
    tbody,
    money,
    hooks,
    money.expenses.map(function (item) {
      return { item: item, kept: null };
    }),
    null,
    4,
  );
  const section = el("section", { class: "rv-sec xp-list", id: "xpList" }, [
    el("div", { class: "rv-sh" }, [
      el("div", null, [
        el("h3", { text: "Expenses" }),
        el("p", { class: "sub", text: "Newest first. Add a row for each payout; tap one to change or delete it." }),
      ]),
    ]),
    el("div", { class: "enqlist paytbl xp-tbl" }, [
      el("table", null, [
        el("thead", null, [
          el("tr", null, [
            el("th", { scope: "col", text: "Date" }),
            el("th", { scope: "col", class: "xp-to", text: "Supporter" }),
            el("th", { scope: "col", text: "Why" }),
            el("th", { scope: "col", class: "num", text: "Amount" }),
          ]),
        ]),
        tbody,
      ]),
      !money.expenses.length && editing !== "new" ? el("p", { class: "sub xp-none", text: "No expenses yet." }) : null,
      editing === "new" ? null : addButton("+ Add an expense", hooks),
    ]),
  ]);
  body.appendChild(section);
  focusLater(focus, section);
}
