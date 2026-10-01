// Payments (owners only): the tab listing what candidates reported from /payment, and its count of pending ones.
import { byId, el, onEnterOrSpace, setMessage, toast } from "./dom";
import { formatIst, formatTime } from "./time";
import { plural, titleCase } from "./labels";
import { request } from "./api";
import { revenueShown, showRevenue } from "./revenue";
import { state } from "./state";
import { icon } from "./panel";
import type { Payment } from "./types";

// One candidate in By candidate: confirmed payments added up, pending ones counted, the latest date.
type PayPerson = { email: string; name: string; count: number; total: number; last: string; pending: number };
// The Payments tab: what people sent from the public /payment page, newest first. Each receipt opens in a new tab; the
// icon beside it saves it, named after the payer. A new payment is Pending until an owner confirms or discards it, and
// that's final. Totals count confirmed payments only; discarded ones are kept but hidden unless the status filter asks.
function rupees(amount: number) {
  return "\u20B9" + amount.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
let paymentsShown = -1;
// Verified: the server read the typed amount on the receipt. Needs check: it couldn't read an amount (a blurry photo,
// a HEIC photo), so look at the receipt. Payments from before the check have no badge.
function checkBadge(item: Payment) {
  if (item.check === "verified") {
    return el("span", { class: "pchk ok", text: "Verified", title: "The amount on the receipt matches" });
  } else if (item.check === "unread") {
    return el("span", { class: "pchk warn", text: "Needs check", title: "The amount on the receipt couldn't be read" });
  } else {
    return null;
  }
}
// which part of the fee a payment is (2nd and 3rd only on older payments); the oldest didn't ask, and show a dash
function installmentText(item: Payment, short?: boolean) {
  const names: Record<string, string> = short
    ? { advance: "Advance", "1": "First", final: "Final", "2": "2nd", "3": "3rd" }
    : { advance: "Advance", "1": "First installment", final: "Final installment", "2": "2nd installment", "3": "3rd installment" };
  return names[item.installment] || "\u2014";
}
function statusBadge(item: Payment) {
  if (item.decision === "confirmed") {
    return el("span", { class: "pst ok", text: "Confirmed" });
  } else if (item.decision === "discarded") {
    return el("span", { class: "pst off", text: "Discarded" });
  } else {
    return el("span", { class: "pst wait", text: "Pending" });
  }
}
// Three views, remembered per device: By candidate (one row per candidate email: payments, total paid, last paid),
// Table (candidate, date, amount) and List (one block per payment, with its receipt). The search box narrows every view
// by name or email; when it finds one candidate, Table and List show their subtotal. Tapping a candidate in By candidate
// searches for them.
let paymentsMode = "people";
try {
  const savedMode = localStorage.getItem("payMode") || "";
  paymentsMode = ["people", "table", "list"].indexOf(savedMode) >= 0 ? savedMode : "people";
} catch (e) {}
let paymentsSort = { key: "date", down: true };
let peopleSort = { key: "last", down: true };
// what's typed in the search box: part of a candidate's name or email
let paymentsQuery = "";
// "" is pending and confirmed; or just "pending", "confirmed" or "discarded"
let paymentsStatus = "";
let paymentOpening = new URLSearchParams(location.search).get("pay") || "";
let paymentShown = ""; // the one an alert opened, highlighted
export function showPayments() {
  const body = byId("payBody");
  body.textContent = "";
  const link = location.origin + "/payment";
  const msg = el("p", { class: "msg", role: "status" });
  body.appendChild(
    el("div", { class: "enqlink" }, [
      el("a", { href: "/payment", target: "_blank", rel: "noopener", text: link.replace(/^https?:\/\//, "") }),
      el("button", {
        type: "button",
        class: "ghost",
        text: "Copy link",
        onclick: function () {
          navigator.clipboard.writeText(link).then(
            function () {
              toast("Link copied");
            },
            function () {
              setMessage(msg, "Couldn't copy. The link is " + link, true);
            },
          );
        },
      }),
    ]),
  );
  const bar = el("div", { class: "paybar", hidden: true });
  const list = el("div", { class: "enqlist" }, [el("p", { class: "sub", text: "Loading…" })]);
  body.appendChild(bar);
  body.appendChild(list);
  body.appendChild(msg);
  let payments: Payment[] = [];
  // redrawing keeps this same box, so typing isn't interrupted
  const search = el("input", {
    type: "search",
    class: "payfilter paysearch",
    placeholder: "Search candidates",
    "aria-label": "Search payments by candidate name or email",
    autocomplete: "off",
    oninput: function () {
      paymentsQuery = search.value;
      draw();
    },
  }) as HTMLInputElement;
  search.value = paymentsQuery;
  // one entry per candidate email, with the name from their latest payment (payments come newest first)
  function people() {
    const byEmail: Record<string, PayPerson> = {};
    const out: PayPerson[] = [];
    payments.forEach(function (item) {
      if (item.decision === "discarded") {
        return;
      }
      let p = byEmail[item.email];
      if (!p) {
        p = byEmail[item.email] = { email: item.email, name: titleCase(item.name), count: 0, total: 0, last: item.createdAt, pending: 0 };
        out.push(p);
      }
      if (item.decision === "confirmed") {
        p.count++;
        p.total += item.amount;
      } else {
        p.pending++;
      }
      if (Date.parse(item.createdAt) > Date.parse(p.last)) {
        p.last = item.createdAt;
      }
    });
    return out;
  }
  function modeButton(mode: string, label: string) {
    return el("button", {
      type: "button",
      "aria-pressed": String(paymentsMode === mode),
      text: label,
      onclick: function () {
        paymentsMode = mode;
        try {
          localStorage.setItem("payMode", mode);
        } catch (e) {}
        draw();
      },
    });
  }
  function sortButton(sort: { key: string; down: boolean }, key: string, label: string, set: (s: { key: string; down: boolean }) => void) {
    const on = sort.key === key;
    return el("button", {
      type: "button",
      text: label + (on ? (sort.down ? " \u2193" : " \u2191") : ""),
      onclick: function () {
        set({ key: key, down: on ? !sort.down : true });
        draw();
      },
    });
  }
  function heading(
    sort: { key: string; down: boolean },
    key: string,
    label: string,
    num: boolean,
    set: (s: { key: string; down: boolean }) => void,
  ) {
    const on = sort.key === key;
    return el("th", { scope: "col", class: num ? "num" : "", "aria-sort": on ? (sort.down ? "descending" : "ascending") : null }, [
      sortButton(sort, key, label, set),
    ]);
  }
  function draw() {
    // checked before the bar is cleared, which takes the focus away
    const typing = document.activeElement === search;
    list.textContent = "";
    bar.textContent = "";
    bar.hidden = !payments.length;
    list.className = "enqlist";
    if (!payments.length) {
      list.appendChild(el("p", { class: "sub", text: "No payments yet. Share the link above." }));
      return;
    }
    const listed = people();
    // a candidate whose payments were all discarded isn't in By candidate, but search still finds them
    const all = listed.slice();
    payments.forEach(function (item) {
      if (!all.some((p) => p.email === item.email)) {
        all.push({ email: item.email, name: titleCase(item.name), count: 0, total: 0, last: item.createdAt, pending: 0 });
      }
    });
    const query = paymentsQuery.trim().toLowerCase();
    function matches(p: PayPerson) {
      return !query || p.name.toLowerCase().indexOf(query) >= 0 || p.email.indexOf(query) >= 0;
    }
    const found = all.filter(matches);
    if (!typing) {
      search.value = paymentsQuery;
    }
    const controls: HTMLElement[] = [
      el("div", { class: "paysw", role: "group", "aria-label": "Show payments" }, [
        modeButton("people", "By candidate"),
        modeButton("table", "Table"),
        modeButton("list", "List"),
      ]),
    ];
    controls.push(search);
    if (paymentsMode !== "people") {
      const status = el(
        "select",
        {
          class: "payfilter",
          "aria-label": "Show payments by status",
          onchange: function () {
            paymentsStatus = status.value;
            draw();
          },
        },
        [
          el("option", { value: "", text: "Pending and confirmed" }),
          el("option", { value: "pending", text: "Pending" }),
          el("option", { value: "confirmed", text: "Confirmed" }),
          el("option", { value: "discarded", text: "Discarded" }),
        ],
      );
      status.value = paymentsStatus;
      controls.push(status);
    }
    controls.forEach(function (c) {
      bar.appendChild(c);
    });
    if (typing) {
      search.focus();
    }
    if (!found.length) {
      list.appendChild(el("p", { class: "sub", text: "No candidate matches \u201C" + paymentsQuery.trim() + "\u201D." }));
      return;
    }
    if (paymentsMode === "people") {
      if (listed.length) {
        drawPeople(listed.filter(matches));
      } else {
        list.appendChild(el("p", { class: "sub", text: "Every payment so far was discarded. Pick List or Table to see them." }));
      }
      return;
    }
    const rows = payments.filter(function (item) {
      const state = item.decision || "pending";
      const mine = found.some(function (p) {
        return p.email === item.email;
      });
      return mine && (paymentsStatus ? state === paymentsStatus : state !== "discarded");
    });
    // one candidate found: their total at the top, and no candidate column
    const who = query && found.length === 1 ? found[0] : null;
    if (who) {
      list.appendChild(
        el("div", { class: "paysum" }, [
          el("div", null, [el("b", { text: who.name }), el("small", { text: who.email })]),
          el("div", { class: "num" }, [
            el("b", { text: rupees(who.total) }),
            el("small", { text: plural(who.count, "confirmed payment") + (who.pending ? " \u00B7 " + who.pending + " pending" : "") }),
          ]),
        ]),
      );
    }
    if (!rows.length) {
      list.appendChild(el("p", { class: "sub", text: paymentsStatus ? "No " + paymentsStatus + " payments here." : "No payments here." }));
      return;
    }
    if (paymentsMode === "table") {
      drawTable(rows, who);
    } else {
      drawList(rows);
    }
  }
  // one row per candidate; tapping one shows their payments
  function drawPeople(all: PayPerson[]) {
    list.className = "enqlist paytbl";
    const rows = all.slice().sort(function (a, b) {
      const diff =
        peopleSort.key === "total"
          ? a.total - b.total
          : peopleSort.key === "count"
            ? a.count - b.count
            : Date.parse(a.last) - Date.parse(b.last);
      return peopleSort.down ? -diff : diff;
    });
    function setSort(next: { key: string; down: boolean }) {
      peopleSort = next;
    }
    list.appendChild(
      el("table", null, [
        el("thead", null, [
          el("tr", null, [
            el("th", { scope: "col", text: "Candidate" }),
            heading(peopleSort, "count", "Confirmed", true, setSort),
            heading(peopleSort, "total", "Total", true, setSort),
            heading(peopleSort, "last", "Last", false, setSort),
          ]),
        ]),
        el(
          "tbody",
          null,
          rows.map(function (p) {
            function open() {
              paymentsQuery = p.email;
              paymentsMode = "table";
              draw();
            }
            return el(
              "tr",
              { class: "tap", tabindex: "0", title: "Show " + p.name + "'s payments", onclick: open, onkeydown: onEnterOrSpace(open) },
              [
                el("td", null, [
                  el("span", { class: "pn", text: p.name }),
                  el("small", { text: p.email }),
                  p.pending ? el("span", { class: "pst wait", text: p.pending + " pending" }) : null,
                ]),
                el("td", { class: "num", text: String(p.count) + "\u00D7" }),
                el("td", { class: "num", text: rupees(p.total) }),
                el("td", { class: "dt", text: formatIst({ day: "numeric", month: "short" }, new Date(p.last)) }),
              ],
            );
          }),
        ),
      ]),
    );
  }
  // Candidate, date and amount; Date and Amount sort when their heading is tapped (again to reverse). Filtered to one
  // candidate, the last row is their total.
  function drawTable(filtered: Payment[], who: PayPerson | null) {
    list.className = "enqlist paytbl";
    const rows = filtered.slice().sort(function (a, b) {
      const diff = paymentsSort.key === "amount" ? a.amount - b.amount : Date.parse(a.createdAt) - Date.parse(b.createdAt);
      return paymentsSort.down ? -diff : diff;
    });
    function setSort(next: { key: string; down: boolean }) {
      paymentsSort = next;
    }
    list.appendChild(
      el("table", null, [
        el("thead", null, [
          el("tr", null, [
            // filtered to one candidate, their name is in the summary above instead
            who ? null : el("th", { scope: "col", text: "Candidate" }),
            heading(paymentsSort, "date", "Date", false, setSort),
            el("th", { scope: "col", text: "For" }),
            heading(paymentsSort, "amount", "Amount", true, setSort),
          ]),
        ]),
        el(
          "tbody",
          null,
          rows.map(function (item) {
            return el("tr", null, [
              who ? null : el("td", { text: titleCase(item.name) }),
              el("td", { class: "dt", text: formatIst({ day: "numeric", month: "short", year: "numeric" }, new Date(item.createdAt)) }),
              el("td", { class: "pin", text: installmentText(item, true), title: installmentText(item) }),
              el("td", { class: "num" }, [rupees(item.amount), statusBadge(item)]),
            ]);
          }),
        ),
        who
          ? el("tfoot", null, [
              el("tr", null, [
                el("th", { scope: "row", colspan: "2", text: "Confirmed \u00B7 " + plural(who.count, "payment") }),
                el("td", { class: "num", text: rupees(who.total) }),
              ]),
            ])
          : null,
      ]),
    );
  }
  // Pending: Confirm and Discard, each asked once. Decided: when, and nothing to press; the server refuses a change too.
  function decided(item: Payment) {
    if (item.decision) {
      const at = new Date(item.decidedAt || item.createdAt);
      return el("small", {
        class: "pdone",
        text:
          (item.decision === "confirmed" ? "Confirmed " : "Discarded ") +
          formatIst({ month: "short", day: "numeric" }, at) +
          ", " +
          formatTime(at),
      });
    }
    const who = titleCase(item.name);
    function decide(decision: string) {
      const question =
        decision === "confirm"
          ? "Confirm " + rupees(item.amount) + " from " + who + "? Once confirmed, it can't be changed or discarded."
          : "Discard " + rupees(item.amount) + " from " + who + "? It won't count in their total, and it can't be changed after this.";
      if (!confirm(question)) {
        return;
      }
      request<{ ok: boolean; payment: Payment; allowed?: boolean }>("/admin/api/payments/decide", { id: item.id, decision: decision })
        .then(function (result) {
          toast(
            decision === "discard"
              ? "Payment discarded"
              : result.allowed === undefined
                ? "Payment confirmed"
                : result.allowed
                  ? "Payment confirmed · " + result.payment.email + " can book"
                  : "Payment confirmed · couldn't add the email to Candidates",
          );
          payments = payments.map(function (p) {
            return p.id === item.id ? result.payment : p;
          });
          draw();
        })
        .catch(function (error) {
          setMessage(msg, error.message, true);
          load();
        });
    }
    return el("div", { class: "pdec" }, [
      el("button", {
        type: "button",
        class: "rm",
        text: "Discard",
        "aria-label": "Discard the payment from " + who,
        onclick: function () {
          decide("discard");
        },
      }),
      el("button", {
        type: "button",
        class: "pri",
        text: "Confirm",
        "aria-label": "Confirm the payment from " + who,
        onclick: function () {
          decide("confirm");
        },
      }),
    ]);
  }
  function drawList(rows: Payment[]) {
    rows.forEach(function (item) {
      const when = new Date(item.createdAt);
      const kind = item.receipt.type === "application/pdf" ? "PDF" : "Image";
      list.appendChild(
        el(
          "div",
          { class: "enq" + (item.decision === "discarded" ? " off" : "") + (item.id === paymentShown ? " hl" : ""), "data-pay": item.id },
          [
            el("div", { class: "enqh" }, [
              el("b", { text: titleCase(item.name) }),
              el("small", { text: formatIst({ month: "short", day: "numeric", year: "numeric" }, when) + ", " + formatTime(when) }),
            ]),
            el("p", { class: "enqt payamt" }, [rupees(item.amount), statusBadge(item), item.decision ? null : checkBadge(item)]),
            el("p", { class: "pinst", text: installmentText(item) }),
            el("p", { class: "enqc" }, [el("a", { href: "mailto:" + item.email, text: item.email })]),
            el("div", { class: "enqa" }, [
              el("div", { class: "enqr" }, [
                el("a", {
                  class: "bk-act",
                  href: "/admin/api/payments/" + item.id + "/receipt",
                  target: "_blank",
                  rel: "noopener",
                  text: "Receipt · " + kind,
                }),
                el(
                  "a",
                  {
                    class: "bk-act dl",
                    href: "/admin/api/payments/" + item.id + "/receipt?download=1",
                    download: "",
                    title: "Download receipt",
                    "aria-label": "Download the receipt from " + item.name,
                  },
                  [icon("download")],
                ),
              ]),
              decided(item),
            ]),
          ],
        ),
      );
    });
  }
  function load() {
    request<{ payments: Payment[] }>("/admin/api/payments")
      .then(function (result) {
        payments = result.payments || [];
        const opening = openFromAlert();
        draw();
        const target = opening && list.querySelector('[data-pay="' + opening + '"]');
        if (target) {
          target.scrollIntoView({ block: "center" });
        }
      })
      .catch(function (error) {
        list.textContent = "";
        setMessage(msg, error.message, true);
      });
  }
  // a payment alert opens /admin?view=payments&pay=<id>: show that payment in the list, whatever it is
  function openFromAlert() {
    const id = paymentOpening;
    const item = payments.filter(function (p) {
      return p.id === id;
    })[0];
    if (!item) {
      return "";
    }
    paymentOpening = "";
    paymentShown = id;
    try {
      const url = new URL(location.href);
      url.searchParams.delete("pay");
      history.replaceState(null, "", url.pathname + url.search);
    } catch (e) {}
    paymentsMode = "list";
    paymentsQuery = "";
    paymentsStatus = item.decision === "discarded" ? "discarded" : "";
    return id;
  }
  load();
}
// a new or decided payment while the tab is open shows up straight away; the badge counts pending ones
let paymentsKey = "";
export function refreshPayments() {
  const pending = state.paymentsPending || 0;
  document.querySelectorAll<HTMLElement>(".pbadge").forEach(function (badge: HTMLElement) {
    badge.hidden = !pending;
    badge.textContent = pending > 99 ? "99+" : String(pending);
  });
  byId("tabPay").setAttribute("aria-label", pending ? "Payments, " + pending + " pending" : "Payments");
  const key = (state.payments || 0) + "/" + pending;
  if (!byId("viewPay").hidden && paymentsShown >= 0 && key !== paymentsKey) {
    showPayments();
  }
  // a new or decided payment changes the numbers in Revenue too
  if (revenueShown() && paymentsShown >= 0 && key !== paymentsKey) {
    showRevenue();
  }
  paymentsKey = key;
  paymentsShown = state.payments || 0;
}
