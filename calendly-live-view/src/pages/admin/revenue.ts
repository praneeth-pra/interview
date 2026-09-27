// The Analytics tab (owners only): revenue from confirmed payments, bookings and their rounds, and how enquiries turn
// into candidates, from /admin/api/revenue. The search box narrows every figure to the candidates whose name or email
// contains what's typed, like the Payments tab's search. Months are India months; the charts are plain bars, one accent
// colour.
import { request } from "./api";
import { byId, el, type Child } from "./dom";
import { plural, titleCase } from "./labels";

type Summary = {
  months: string[];
  revenue: { total: number; count: number; pending: number; pendingCount: number; payers: number; byMonth: number[]; paidByMonth: number[] };
  found: { name: string; email: string }[]; // who the search found (empty without a search)
  bookings: {
    byMonth: number[];
    candidates: number;
    rounds: { upcoming: number; done: number; cleared: number; rejected: number; hold: number; missed: number; cancelled: number };
  };
  enquiries: { total: number; people: number; booked: number; paid: number; byMonth: number[] };
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function rupees(amount: number) {
  return "₹" + amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
// ₹1.2L, ₹45k: short enough to sit above a bar
function shortRupees(amount: number) {
  if (amount >= 100000) {
    return "₹" + (amount / 100000).toFixed(amount >= 1000000 ? 0 : 1).replace(/\.0$/, "") + "L";
  } else if (amount >= 1000) {
    return "₹" + (amount / 1000).toFixed(amount >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  }
  return "₹" + Math.round(amount);
}
function monthName(key: string, withYear?: boolean) {
  var name = MONTH_NAMES[Number(key.slice(5)) - 1];
  return withYear ? name + " " + key.slice(0, 4) : name;
}
function percent(part: number, whole: number) {
  return whole ? Math.round((part / whole) * 100) + "%" : "—";
}

function tile(label: string, value: string, note: string) {
  return el("div", { class: "rv-tile" }, [el("div", { class: "rv-k", text: label }), el("div", { class: "rv-v", text: value }), el("div", { class: "rv-n", text: note })]);
}
function section(title: string, note: string, children: Child[]) {
  return el("section", { class: "rv-sec" }, ([el("h3", { text: title }), note ? el("p", { class: "sub", text: note }) : null] as Child[]).concat(children));
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
// a labelled row with a bar as wide as its share of the largest row
function meterRow(label: string, value: string, share: number, note?: string) {
  var fill = el("i");
  fill.style.width = Math.max(share > 0 ? 1.5 : 0, share * 100) + "%";
  return el("div", { class: "rv-row" }, [
    el("div", { class: "rv-rl" }, [el("span", { text: label }), el("b", { text: value })]),
    el("div", { class: "rv-meter" }, [fill]),
    note ? el("div", { class: "rv-rn", text: note }) : null,
  ]);
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

  body.appendChild(
    section("Revenue by month", "Confirmed payments, by the month they were sent.", [
      monthBars(
        months,
        rev.byMonth,
        shortRupees,
        function (v) {
          return rupees(v);
        },
        true,
      ),
    ]),
  );

  var r = data.bookings.rounds;
  var booked = data.bookings.byMonth.reduce(function (a, b) {
    return a + b;
  }, 0);
  body.appendChild(
    section("Bookings by month", plural(booked, "interview") + " in the last 12 months, by the month of the interview; cancelled ones aren't counted.", [
      monthBars(months, data.bookings.byMonth, String, function (v) {
        return plural(v, "interview");
      }),
      el(
        "div",
        { class: "rv-chips" },
        [
          ["Upcoming", r.upcoming],
          ["Completed", r.done],
          ["Cleared", r.cleared],
          ["Rejected", r.rejected],
          ["On hold", r.hold],
          ["Didn't happen", r.missed],
          ["Cancelled", r.cancelled],
        ].map(function (pair) {
          return el("span", { class: "rv-chip" }, [el("b", { text: String(pair[1]) }), " " + pair[0]]);
        }),
      ),
    ]),
  );

  var e = data.enquiries;
  body.appendChild(
    section(
      "Enquiries to candidates",
      e.people ? "People who sent an enquiry, and how many of them went on to book and to pay (matched by email)." : "No enquiries yet.",
      e.people
        ? [
            meterRow("Sent an enquiry", String(e.people), 1),
            meterRow("Booked an interview", String(e.booked), e.booked / e.people, percent(e.booked, e.people) + " of enquiries"),
            meterRow("Paid", String(e.paid), e.paid / e.people, percent(e.paid, e.people) + " of enquiries"),
          ]
        : [],
    ),
  );
}

// what's typed in the search box: part of a candidate's name or email
var revenueQuery = "";
var loading = 0;
var searchTimer: ReturnType<typeof setTimeout> | undefined;
function showRevenue() {
  var body = byId("revBody");
  var figures = byId("revFigures");
  if (!figures) {
    // built once, so typing never loses the box's focus; only the figures below it redraw
    var search = el("input", {
      type: "search",
      class: "payfilter paysearch",
      placeholder: "Search a candidate",
      "aria-label": "Show the figures for candidates whose name or email contains",
      autocomplete: "off",
      oninput: function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          revenueQuery = search.value;
          showRevenue();
        }, 200);
      },
    });
    figures = el("div", { id: "revFigures" }, [el("p", { class: "sub", text: "Loading\u2026" })]);
    body.appendChild(el("div", { class: "paybar" }, [search]));
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
