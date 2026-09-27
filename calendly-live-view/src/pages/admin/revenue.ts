// The Revenue tab (owners only): confirmed payments added up month by month (Cumulative, the default) or month by month
// (Monthly), from /admin/api/revenue. The search box suggests candidates as you type; picking one, or just typing,
// narrows every figure to the candidates whose name or email contains it, like the Payments tab's search. Months are
// India months; the chart is plain bars in the one accent colour.
import { request } from "./api";
import { byId, el } from "./dom";
import { plural, titleCase } from "./labels";

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
  };
  candidates: Candidate[]; // everyone with a payment, for the suggestions
  found: { name: string; email: string }[]; // who the search found (empty without a search)
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function rupees(amount: number) {
  return "\u20B9" + amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
// ₹1.2L, ₹45k: short enough to sit above a bar
function shortRupees(amount: number) {
  if (amount >= 100000) {
    return "\u20B9" + (amount / 100000).toFixed(amount >= 1000000 ? 0 : 1).replace(/\.0$/, "") + "L";
  } else if (amount >= 1000) {
    return "\u20B9" + (amount / 1000).toFixed(amount >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  }
  return "\u20B9" + Math.round(amount);
}
function monthName(key: string, withYear?: boolean) {
  var name = MONTH_NAMES[Number(key.slice(5)) - 1];
  return withYear ? name + " " + key.slice(0, 4) : name;
}

function tile(label: string, value: string, note: string) {
  return el("div", { class: "rv-tile" }, [el("div", { class: "rv-k", text: label }), el("div", { class: "rv-v", text: value }), el("div", { class: "rv-n", text: note })]);
}
// twelve columns, one per month; the label above each bar is its value
function monthBars(months: string[], values: number[], label: (v: number) => string, describe: (v: number) => string, money?: boolean) {
  var top = Math.max.apply(null, values.concat([0]));
  var chart = el("div", { class: money ? "rv-bars money" : "rv-bars", role: "list" });
  months.forEach(function (key, i) {
    var v = values[i];
    var bar = el("i", { class: v ? "" : "zero" });
    bar.style.height = top ? Math.max(v ? 3 : 0, (v / top) * 100) + "%" : "0";
    chart.appendChild(
      el("div", { class: "rv-col", role: "listitem", "aria-label": monthName(key, true) + ": " + describe(v), title: monthName(key, true) + ": " + describe(v) }, [
        el("span", { class: "rv-val", text: v ? label(v) : "" }),
        el("div", { class: "rv-bar" }, [bar]),
        el("span", { class: "rv-mo", text: monthName(key) }),
      ]),
    );
  });
  return chart;
}
function draw(body: HTMLElement, data: Summary) {
  var rev = data.revenue;
  var months = data.months;
  var thisMonth = rev.byMonth[months.length - 1];
  var lastMonth = rev.byMonth[months.length - 2];
  var change = lastMonth ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100) : 0;

  body.appendChild(
    el("div", { class: "rv-tiles" }, [
      tile("Revenue", rupees(rev.total), plural(rev.count, "confirmed payment")),
      tile(
        "This month",
        rupees(thisMonth),
        lastMonth ? (change >= 0 ? "+" : "−") + Math.abs(change) + "% on " + monthName(months[months.length - 2]) : "Nothing in " + monthName(months[months.length - 2]),
      ),
      tile("Pending", rupees(rev.pending), rev.pendingCount ? plural(rev.pendingCount, "payment") + " to confirm" : "Nothing to confirm"),
      tile("Paying candidates", String(rev.payers), rev.payers ? rupees(Math.round(rev.total / rev.payers)) + " each on average" : "No confirmed payments yet"),
    ]),
  );

  // Cumulative: everything confirmed up to the end of each month. Monthly: what came in that month.
  var cumulative = rev.byMonth.slice();
  var sum = rev.before;
  cumulative.forEach(function (v, i) {
    sum += v;
    cumulative[i] = sum;
  });
  var running = revenueMode === "total";
  function modeButton(mode: string, label: string) {
    return el("button", {
      type: "button",
      "aria-pressed": String(revenueMode === mode),
      text: label,
      onclick: function () {
        if (revenueMode !== mode) {
          revenueMode = mode;
          try {
            localStorage.setItem("revMode", mode);
          } catch (e) {}
          showRevenue();
        }
      },
    });
  }
  body.appendChild(
    el("section", { class: "rv-sec" }, [
      el("div", { class: "rv-sh" }, [
        el("div", null, [
          el("h3", { text: running ? "Revenue to date" : "Revenue by month" }),
          el("p", {
            class: "sub",
            text: running ? "All confirmed payments up to the end of each month." : "Confirmed payments, by the month they were sent.",
          }),
        ]),
        el("div", { class: "paysw", role: "group", "aria-label": "Show revenue" }, [modeButton("total", "Cumulative"), modeButton("month", "Monthly")]),
      ]),
      monthBars(
        months,
        running ? cumulative : rev.byMonth,
        shortRupees,
        function (v) {
          return rupees(v);
        },
        true,
      ),
    ]),
  );
}

// Cumulative ("total") unless this device last picked Monthly
var revenueMode = "total";
try {
  revenueMode = localStorage.getItem("revMode") === "month" ? "month" : "total";
} catch (e) {}
// what's typed in the search box: part of a candidate's name or email (or a picked suggestion's email)
var revenueQuery = "";
var loading = 0;
var searchTimer: ReturnType<typeof setTimeout> | undefined;
// everyone with a payment, from the last answer, for the suggestions
var candidates: Candidate[] = [];
function setupSearch(body: HTMLElement) {
  var list = el("ul", { id: "revDrop", class: "drop", role: "listbox", "aria-label": "Candidates", hidden: true });
  var search = el("input", {
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
  var shown: Candidate[] = [];
  var active = -1;
  function close() {
    list.hidden = true;
    search.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    active = -1;
  }
  function highlight(index: number) {
    active = index;
    for (var i = 0; i < list.children.length; i++) {
      list.children[i].setAttribute("aria-selected", String(i === index));
    }
    if (index >= 0) {
      search.setAttribute("aria-activedescendant", "rvo" + index);
      list.children[index].scrollIntoView({ block: "nearest" });
    }
  }
  // a picked candidate: their name in the box, and the figures for their email alone
  function choose(index: number) {
    var p = shown[index];
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
    var q = search.value.trim().toLowerCase();
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
function showRevenue() {
  var body = byId("revBody");
  var figures = byId("revFigures");
  if (!figures) {
    // built once, so typing never loses the box's focus; only the figures below it redraw
    setupSearch(body);
    figures = el("div", { id: "revFigures" }, [el("p", { class: "sub", text: "Loading\u2026" })]);
    body.appendChild(figures);
  }
  var query = revenueQuery.trim();
  var ask = ++loading;
  // the CSV narrows to the same candidates
  byId<HTMLAnchorElement>("revDl").href = "/admin/api/revenue.csv" + (query ? "?q=" + encodeURIComponent(query) : "");
  request("/admin/api/revenue" + (query ? "?q=" + encodeURIComponent(query) : ""))
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
        var names = data.found.map(function (p) {
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
