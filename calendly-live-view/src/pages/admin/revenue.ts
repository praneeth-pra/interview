// The Analytics tab (owners only): revenue from confirmed payments, bookings and their rounds, and how enquiries turn
// into candidates, from /admin/api/revenue. Months are India months; the charts are plain bars, one accent colour.
import { request } from "./api";
import { byId, el, type Child } from "./dom";
import { plural, titleCase } from "./labels";

type Summary = {
  months: string[];
  revenue: { total: number; count: number; pending: number; pendingCount: number; payers: number; byMonth: number[]; paidByMonth: number[] };
  installments: { key: string; total: number; count: number }[];
  candidates: { name: string; email: string; total: number; count: number; last: string }[];
  bookings: {
    byMonth: number[];
    candidates: number;
    rounds: { upcoming: number; done: number; cleared: number; rejected: number; hold: number; missed: number; cancelled: number };
  };
  enquiries: { total: number; people: number; booked: number; paid: number; byMonth: number[] };
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INSTALLMENT_NAMES: Record<string, string> = {
  advance: "Advance",
  "1": "1st installment",
  "2": "2nd installment",
  "3": "3rd installment",
  "": "Not asked (older payments)",
};
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

  var parts = data.installments.filter(function (p) {
    return p.key || p.count;
  });
  var topPart = Math.max.apply(
    null,
    parts.map(function (p) {
      return p.total;
    }),
  );
  body.appendChild(
    section(
      "By installment",
      "",
      parts.map(function (p) {
        return meterRow(INSTALLMENT_NAMES[p.key] || p.key, rupees(p.total), topPart ? p.total / topPart : 0, plural(p.count, "payment") + (rev.total ? " · " + percent(p.total, rev.total) + " of revenue" : ""));
      }),
    ),
  );

  // top candidates by what they paid; the rest behind a button
  var table = el("table", { class: "rv-tbl" }, [
    el("thead", null, [el("tr", null, [el("th", { text: "Candidate" }), el("th", { class: "num", text: "Payments" }), el("th", { class: "num", text: "Paid" })])]),
  ]);
  var rows = el("tbody");
  table.appendChild(rows);
  var shown = 0;
  function more(upTo: number) {
    data.candidates.slice(shown, upTo).forEach(function (p) {
      rows.appendChild(
        el("tr", null, [
          el("td", null, [el("b", { text: titleCase(p.name) }), el("small", { text: p.email })]),
          el("td", { class: "num", text: String(p.count) }),
          el("td", { class: "num", text: rupees(p.total) }),
        ]),
      );
    });
    shown = Math.min(upTo, data.candidates.length);
  }
  more(8);
  var showAll =
    data.candidates.length > shown
      ? el("button", {
          type: "button",
          class: "ghost rv-more",
          text: "Show all " + data.candidates.length,
          onclick: function () {
            more(data.candidates.length);
            showAll.remove();
          },
        })
      : null;
  body.appendChild(
    section(
      "Top candidates",
      data.candidates.length ? "By what they've paid, confirmed payments only." : "",
      data.candidates.length ? [el("div", { class: "rv-card" }, [table]), showAll] : [el("p", { class: "sub", text: "No confirmed payments yet." })],
    ),
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

var loading = 0;
function showRevenue() {
  var body = byId("revBody");
  var ask = ++loading;
  if (!body.firstChild) {
    body.appendChild(el("p", { class: "sub", text: "Loading…" }));
  }
  request("/admin/api/revenue")
    .then(function (data: Summary) {
      if (ask !== loading) {
        return;
      }
      body.textContent = "";
      draw(body, data);
    })
    .catch(function (error) {
      if (ask !== loading) {
        return;
      }
      body.textContent = "";
      body.appendChild(el("p", { class: "msg err", role: "status", text: error.message }));
    });
}

export { showRevenue };
