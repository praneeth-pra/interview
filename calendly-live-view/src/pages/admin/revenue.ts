// The Revenue tab (owners only): money in (confirmed payments) and out (expenses) month by month, from
// /admin/api/revenue, then each candidate's paid in, spent and kept and the expenses themselves (expenses.ts). The search box suggests candidates as you type; picking one, or just typing,
// narrows every figure to the candidates whose name or email contains it, like the Payments tab's search. Months are
// India months; the chart is plain bars in the one accent colour.
import { request } from "./api";
import { byId, el } from "./dom";
import { type Money, drawByCandidate, drawLedger, openNewExpense, rupees } from "./expenses";
import { plural, titleCase } from "./labels";
import { sharesFiles } from "./share";

type Candidate = { name: string; email: string; total: number };
type Summary = {
  months: string[];
  revenue: {
    total: number;
    count: number;
    pending: number;
    pendingCount: number;
    payers: number;
    before: number; // confirmed before the first month shown
    byMonth: number[];
    paidByMonth: number[];
    lastToDate: number; // confirmed in last month up to the same day and time as now
  };
  spent: { total: number; count: number; byMonth: number[]; general: number; linked: number };
  candidates: Candidate[]; // everyone with a payment, for the suggestions
  found: { name: string; email: string }[]; // who the search found (empty without a search)
} & Money;

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// ₹1.2L, ₹45k, −₹2k: short enough to sit above a bar
function shortRupees(amount: number): string {
  if (amount < 0) {
    return "\u2212" + shortRupees(-amount);
  }
  if (amount >= 100000) {
    return "\u20B9" + (amount / 100000).toFixed(amount >= 1000000 ? 0 : 1).replace(/\.0$/, "") + "L";
  } else if (amount >= 1000) {
    return "\u20B9" + (amount / 1000).toFixed(amount >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  }
  return "\u20B9" + Math.round(amount);
}
function monthName(key: string, withYear?: boolean) {
  const name = MONTH_NAMES[Number(key.slice(5)) - 1];
  return withYear ? name + " " + key.slice(0, 4) : name;
}

function tile(label: string, value: string, note: string, extra?: string) {
  return el("div", { class: "rv-tile" + (extra ? " " + extra : "") }, [
    el("div", { class: "rv-k", text: label }),
    el("div", { class: "rv-v", text: value }),
    el("div", { class: "rv-n", text: note }),
  ]);
}
// twelve columns, one per month: received and spent side by side, and what was kept above them
function monthBars(months: string[], received: number[], spent: number[]) {
  const top = Math.max.apply(null, received.concat(spent, [0]));
  const chart = el("div", { class: "rv-bars money", role: "list" });
  const height = function (v: number) {
    return top ? Math.max(v ? 3 : 0, (v / top) * 100) + "%" : "0";
  };
  months.forEach(function (key, i) {
    const got = el("i", { class: "xp-in" + (received[i] ? "" : " zero") });
    const out = el("i", { class: "xp-out" + (spent[i] ? "" : " zero") });
    got.style.height = height(received[i]);
    out.style.height = height(spent[i]);
    const kept = received[i] - spent[i];
    const said = monthName(key, true) + ": " + rupees(received[i]) + " received, " + rupees(spent[i]) + " spent, " + rupees(kept) + " kept";
    chart.appendChild(
      el("div", { class: "rv-col", role: "listitem", "aria-label": said, title: said }, [
        el("span", { class: "rv-val", text: received[i] || spent[i] ? shortRupees(kept) : "" }),
        el("div", { class: "rv-bar xp-pair" }, [got, out]),
        el("span", { class: "rv-mo", text: monthName(key) }),
      ]),
    );
  });
  return chart;
}
function draw(body: HTMLElement, data: Summary) {
  const rev = data.revenue;
  const spent = data.spent;
  const months = data.months;
  const last = months.length - 1;
  const one = data.found.length === 1 ? data.found[0] : null;
  const kept = rev.total - spent.total;
  const pendingNote = rev.pendingCount ? " \u00B7 " + rupees(rev.pending) + " pending" : "";
  if (one) {
    const first = titleCase(one.name).split(" ")[0];
    body.appendChild(
      el("div", { class: "rv-tiles" }, [
        tile("Paid in", rupees(rev.total), plural(rev.count, "confirmed payment") + pendingNote),
        tile("Spent on " + first, rupees(spent.total), plural(spent.count, "expense")),
        tile("Kept", rupees(kept), "Paid in minus spent", kept >= 0 ? "xp-good" : "xp-bad"),
        tile(
          "Margin",
          rev.total ? Math.round((kept / rev.total) * 100) + "%" : "\u2014",
          rev.total ? "Of what they paid, kept" : "No confirmed payments yet",
        ),
      ]),
    );
  } else {
    const inNow = rev.byMonth[last];
    const outNow = spent.byMonth[last];
    body.appendChild(
      el("div", { class: "rv-tiles" }, [
        tile("Received", rupees(rev.total), plural(rev.count, "confirmed payment") + pendingNote),
        tile(
          "Spent",
          rupees(spent.total),
          plural(spent.count, "expense") + (spent.linked ? " \u00B7 " + spent.linked + " tied to a candidate" : ""),
        ),
        tile("Kept", rupees(kept), "Received minus spent", kept >= 0 ? "xp-good" : "xp-bad"),
        tile("This month", rupees(inNow - outNow) + " kept", rupees(inNow) + " in \u00B7 " + rupees(outNow) + " out"),
      ]),
    );
  }
  body.appendChild(
    el("section", { class: "rv-sec" }, [
      el("div", { class: "rv-sh" }, [
        el("div", null, [
          el("h3", { text: one ? titleCase(one.name).split(" ")[0] + "\u2019s money in and out" : "Money in and out" }),
          el("p", { class: "sub xp-key" }, [
            el("span", null, [el("i", { class: "xp-in" }), "Received"]),
            el("span", null, [el("i", { class: "xp-out" }), "Spent"]),
            el("span", { text: "On top: kept" }),
          ]),
        ]),
      ]),
      monthBars(months, rev.byMonth, spent.byMonth),
    ]),
  );
  const hooks = {
    refresh: showRevenue,
    pick: function (email: string, name: string) {
      const box = document.querySelector<HTMLInputElement>("#revBody .paysearch");
      if (box) {
        box.value = titleCase(name);
      }
      revenueQuery = email;
      showRevenue();
      byId("revBody").scrollIntoView({ block: "start" });
    },
  };
  if (one) {
    drawLedger(body, data, hooks, one);
  } else {
    drawByCandidate(body, data, hooks, spent.general, !!data.found.length);
  }
}
// what's typed in the search box: part of a candidate's name or email (or a picked suggestion's email)
let revenueQuery = "";
let loading = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
// everyone with a payment, from the last answer, for the suggestions
let candidates: Candidate[] = [];
function setupSearch(body: HTMLElement) {
  const list = el("ul", { id: "revDrop", class: "drop", role: "listbox", "aria-label": "Candidates", hidden: true });
  const search = el("input", {
    type: "search",
    class: "payfilter paysearch",
    placeholder: "Search a candidate",
    "aria-label": "Search a candidate by name or email",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "revDrop",
    autocomplete: "off",
  });
  let shown: Candidate[] = [];
  let active = -1;
  function close() {
    list.hidden = true;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function highlight(index: number) {
    active = index;
    for (let i = 0; i < list.children.length; i++) {
      list.children[i].setAttribute("aria-selected", String(i === index));
    }
    if (index >= 0) {
      search.setAttribute("aria-activedescendant", "rvo" + index);
      list.children[index].scrollIntoView({ block: "nearest" });
    }
  }
  // a picked candidate: their name in the box, and the figures for their email alone
  function choose(index: number) {
    const p = shown[index];
    if (!p) {
      return;
    }
    clearTimeout(searchTimer);
    search.value = titleCase(p.name);
    revenueQuery = p.email;
    close();
    showRevenue();
  }
  function suggest() {
    const q = search.value.trim().toLowerCase();
    list.textContent = "";
    if (!q) {
      close();
      return;
    }
    shown = candidates
      .filter(function (p) {
        return p.name.toLowerCase().indexOf(q) >= 0 || p.email.indexOf(q) >= 0;
      })
      .slice(0, 8);
    if (!shown.length) {
      list.appendChild(el("li", { class: "m", text: "No matching candidates" }));
    }
    shown.forEach(function (p, index) {
      list.appendChild(
        el(
          "li",
          {
            id: "rvo" + index,
            role: "option",
            "aria-selected": "false",
            onmousedown: function (event: Event) {
              event.preventDefault();
            },
            onclick: function () {
              choose(index);
            },
          },
          [el("b", { text: titleCase(p.name) }), el("div", { class: "m", text: p.email + " \u00B7 " + rupees(p.total) + " paid" })],
        ),
      );
    });
    active = -1;
    list.hidden = false;
    search.setAttribute("aria-expanded", "true");
  }
  search.addEventListener("input", function () {
    suggest();
    // typing without picking still narrows the figures, as in the Payments tab
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      revenueQuery = search.value;
      showRevenue();
    }, 250);
  });
  search.addEventListener("focus", suggest);
  search.addEventListener("keydown", function (event: KeyboardEvent) {
    if (list.hidden) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(active < shown.length - 1 ? active + 1 : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(active > 0 ? active - 1 : shown.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active < 0 ? 0 : active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  });
  search.addEventListener("blur", close);
  body.appendChild(el("div", { class: "paybar" }, [el("div", { class: "srch rv-srch" }, [search, list])]));
}
// The PDF report's month picker: the last twelve India months, newest first, with last month (the one the monthly email
// is about) picked. The PDF covers everyone, whatever the search box says.
function setupPdfMonths(pick: HTMLSelectElement) {
  const now = new Date(Date.now() + 330 * 60000);
  const link = byId<HTMLAnchorElement>("revPdf");
  for (let i = 0; i < 12; i++) {
    const m = now.getUTCFullYear() * 12 + now.getUTCMonth() - i;
    const key = Math.floor(m / 12) + "-" + String((m % 12) + 1).padStart(2, "0");
    pick.appendChild(el("option", { value: key, text: monthName(key, true) }));
  }
  pick.value = pick.options[1].value;
  const share = sharesFiles("application/pdf");
  // Safari only opens the share sheet straight from the tap, so the file is fetched as soon as the month is picked
  let file: File | null = null;
  const update = function () {
    const key = pick.value;
    link.href = "/admin/api/revenue.pdf?month=" + key;
    file = null;
    if (!share) {
      return;
    }
    fetch(link.href, { credentials: "same-origin" })
      .then(function (r) {
        return r.ok ? r.blob() : Promise.reject(new Error(String(r.status)));
      })
      .then(function (blob) {
        if (pick.value === key) {
          file = new File([blob], "revenue-report-" + key + ".pdf", { type: "application/pdf" });
        }
      })
      .catch(function () {
        // the link still downloads it
      });
  };
  link.addEventListener("click", function (event) {
    if (!file) {
      return;
    }
    event.preventDefault();
    navigator.share({ files: [file], title: "Revenue report, " + monthName(pick.value, true) }).catch(function () {
      // closed without sharing
    });
  });
  pick.addEventListener("change", update);
  update();
}
function showRevenue() {
  const body = byId("revBody");
  let figures = byId("revFigures");
  if (!figures) {
    // built once, so typing never loses the box's focus; only the figures below it redraw
    setupSearch(body);
    // the Add expense button beside the PDF report: opens the blank row in the expenses list
    byId("revAdd").onclick = function () {
      openNewExpense();
      showRevenue();
    };
    figures = el("div", { id: "revFigures" }, [el("p", { class: "sub", text: "Loading\u2026" })]);
    body.appendChild(figures);
  }
  const query = revenueQuery.trim();
  const ask = ++loading;
  const pick = byId<HTMLSelectElement>("revMon");
  if (!pick.options.length) {
    setupPdfMonths(pick);
  }
  return request<Summary>("/admin/api/revenue" + (query ? "?q=" + encodeURIComponent(query) : ""))
    .then(function (data: Summary) {
      if (ask !== loading) {
        return;
      }
      candidates = data.candidates;
      figures.textContent = "";
      if (query && !data.found.length) {
        figures.appendChild(el("p", { class: "sub", text: "No candidate matches \u201C" + query + "\u201D." }));
        return;
      }
      if (query) {
        const names = data.found.map(function (p) {
          return titleCase(p.name);
        });
        figures.appendChild(
          el("p", { class: "rv-who" }, [
            data.found.length === 1
              ? el("b", { text: names[0] })
              : el("b", { text: plural(data.found.length, "candidate") + " match \u201C" + query + "\u201D" }),
            data.found.length === 1
              ? " \u00B7 " + data.found[0].email
              : ": " + names.slice(0, 4).join(", ") + (names.length > 4 ? " and " + (names.length - 4) + " more" : ""),
          ]),
        );
      }
      draw(figures, data);
    })
    .catch(function (error) {
      if (ask !== loading) {
        return;
      }
      figures.textContent = "";
      figures.appendChild(el("p", { class: "msg err", role: "status", text: error.message }));
    });
}

export { showRevenue };
// the Revenue figures are on screen, as a page or in the sheet
export function revenueShown() {
  return !byId("viewRev").hidden || (!byId("panel").hidden && byId("panel").contains(byId("revBody")));
}
