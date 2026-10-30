// The laptop layout (1100 px and wider; 15-desktop.css): the header becomes a left sidebar with the week's interviews per
// supporter, the Calendar gets a right-hand panel (a month, the interview on now or next, and today's list), and the
// Agenda keeps the picked interview's details open beside the day instead of over it. Narrower screens never see any of it.
import { byId, el } from "./dom";
import { dayKeyOf, formatDay, formatTime, weekStart } from "./time";
import { titleCase } from "./labels";
import { colorClass, render, state, view } from "./state";
import { closePanel, panel } from "./panel";
import { showBooking } from "./booking-panel";
import { agendaDay } from "./agenda";
import { dayItems } from "./week";
import { dockPick, monthDays, nextInterview, shiftMonth, supporterCounts, untilLabel } from "./rail-data";
import type { Booking } from "./types";

export const WIDE = "(min-width: 1100px)";
const wide = matchMedia(WIDE);
let railMonth = ""; // the month the panel shows, "YYYY-MM"; follows the week on screen until its arrows are used
let railWeek = "";
let dockedDay = ""; // the agenda day whose interview was last opened beside it, so a closed panel stays closed

function agendaShown() {
  const classes = document.body.classList;
  return classes.contains("on-cal") && !classes.contains("wkv");
}
function supporterLine(booking: Booking) {
  return [booking.company, booking.round].filter(Boolean).join(" · ");
}
// The sidebar's count of this week's interviews per supporter.
function renderSupporters() {
  let box = document.getElementById("sideSup");
  if (!box) {
    box = el("div", { id: "sideSup", class: "ssup" });
    document.querySelector(".top .tabs")!.after(box);
  }
  box.textContent = "";
  if (!state.ready) {
    return;
  }
  const counts = supporterCounts(state.events, state.iv.assign, state.iv.names, view.week!);
  const list = el("ul", { "aria-label": "Interviews per supporter this week" });
  counts.rows.forEach(function (row) {
    list.appendChild(
      el("li", { class: colorClass(row.name) }, [el("i", { "aria-hidden": "true" }), row.name, el("em", { text: String(row.count) })]),
    );
  });
  list.appendChild(
    el("li", { class: "cn" }, [el("i", { "aria-hidden": "true" }), "No supporter", el("em", { text: String(counts.none) })]),
  );
  box.appendChild(el("h2", { text: "Supporters this week" }));
  box.appendChild(list);
}
function pickDay(day: string) {
  view.day = day;
  view.week = weekStart(day);
  render();
}
function railItem(booking: Booking) {
  const who = state.iv.assign[booking.id];
  return el(
    "button",
    {
      type: "button",
      class: "rl-i " + (who ? colorClass(who) : "cn") + (booking.cancelled ? " cx" : ""),
      onclick: function () {
        showBooking(booking.id);
      },
    },
    [
      el("span", { class: "rl-t" }, [
        formatTime(new Date(booking.start)),
        el("small", { text: Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60000) + " min" }),
      ]),
      el("span", { class: "rl-b" }, [el("b", { text: titleCase(booking.name) }), el("small", { text: supporterLine(booking) })]),
    ],
  );
}
// The Calendar's right-hand panel.
function renderRail() {
  let rail = document.getElementById("rail");
  if (!rail) {
    rail = el("aside", { id: "rail", class: "rail", "aria-label": "Month and today" });
    byId("viewCal").appendChild(rail);
  }
  rail.textContent = "";
  if (!state.ready) {
    return;
  }
  const now = Date.now();
  const today = dayKeyOf(now);
  if (railWeek !== view.week) {
    railWeek = view.week!;
    railMonth = (view.day || view.week!).slice(0, 7);
  }
  // the month, with the week on screen shaded and a dot under days with interviews
  const busy: Record<string, boolean> = {};
  state.events.forEach(function (booking) {
    if (!booking.cancelled) {
      busy[dayKeyOf(new Date(booking.start))] = true;
    }
  });
  const arrow = function (step: number, label: string, text: string) {
    return el("button", {
      type: "button",
      class: "rl-ar",
      "aria-label": label,
      text: text,
      onclick: function () {
        railMonth = shiftMonth(railMonth, step);
        renderRail();
      },
    });
  };
  const grid = el("div", { class: "rl-m", role: "group", "aria-label": formatDay(railMonth + "-15", { month: "long", year: "numeric" }) });
  ["M", "T", "W", "T", "F", "S", "S"].forEach(function (letter) {
    grid.appendChild(el("span", { class: "rl-w", "aria-hidden": "true", text: letter }));
  });
  monthDays(railMonth).forEach(function (cell) {
    const inWeek = weekStart(cell.day) === view.week;
    grid.appendChild(
      el("button", {
        type: "button",
        class:
          "rl-d" +
          (cell.inMonth ? "" : " out") +
          (inWeek ? " wk" : "") +
          (cell.day === today ? " td" : "") +
          (busy[cell.day] ? " has" : ""),
        "aria-label": formatDay(cell.day, { weekday: "long", month: "long", day: "numeric" }) + (busy[cell.day] ? ", has interviews" : ""),
        "aria-current": cell.day === today ? "date" : null,
        text: String(+cell.day.slice(8)),
        onclick: function () {
          pickDay(cell.day);
        },
      }),
    );
  });
  rail.appendChild(
    el("section", { class: "rl-sec" }, [
      el("div", { class: "rl-mh" }, [
        el("h2", { text: formatDay(railMonth + "-15", { month: "long", year: "numeric" }) }),
        el("span", null, [arrow(-1, "Previous month", "‹"), arrow(1, "Next month", "›")]),
      ]),
      grid,
    ]),
  );
  // the interview on now, or the next one
  const next = nextInterview(state.events, now);
  if (next) {
    const who = state.iv.assign[next.id];
    rail.appendChild(
      el(
        "button",
        {
          type: "button",
          class: "rl-next",
          onclick: function () {
            showBooking(next.id);
          },
        },
        [
          el("span", { class: "rl-in", text: (Date.parse(next.start) <= now ? "" : "Up next · ") + untilLabel(next, now) }),
          el("b", { text: titleCase(next.name) }),
          el("span", {
            class: "rl-s",
            text: [supporterLine(next), formatTime(new Date(next.start)) + " – " + formatTime(new Date(next.end))]
              .filter(Boolean)
              .join(" · "),
          }),
          el("span", { class: "rl-who " + (who ? colorClass(who) : "cn") }, [
            el("i", { "aria-hidden": "true" }),
            who ? who + " supporting" : "No supporter yet",
          ]),
        ],
      ),
    );
  }
  // today's interviews
  const todays = dayItems(today);
  const list = el("section", { class: "rl-sec" }, [
    el("h2", { class: "rl-h", text: "Today · " + formatDay(today, { weekday: "short", month: "short", day: "numeric" }) }),
  ]);
  if (!todays.length) {
    list.appendChild(el("p", { class: "rl-none", text: "No interviews today" }));
  }
  todays.forEach(function (item) {
    list.appendChild(railItem(item.booking));
  });
  rail.appendChild(list);
}
// The agenda's picked interview, highlighted while its details are open beside it.
function markSelected() {
  const open = !byId("panel").hidden && panel.bookingId;
  document.querySelectorAll<HTMLElement>("#agenda .ag-i").forEach(function (block) {
    block.classList.toggle("sel", !!open && block.getAttribute("data-id") === open);
  });
}
// The Agenda keeps a booking's details open on the right: when a day opens, its next (or first) interview shows there.
function dock() {
  const agenda = wide.matches && agendaShown() && state.ready;
  if (agenda) {
    const day = agendaDay()!;
    if (day !== dockedDay) {
      dockedDay = day;
      const pick = dockPick(
        dayItems(day).map(function (item) {
          return item.booking;
        }),
        Date.now(),
      );
      if (pick && (byId("panel").hidden || panel.bookingId)) {
        showBooking(pick.id, true);
      } else if (!pick && panel.bookingId && !byId("panel").hidden) {
        closePanel();
      }
    }
  } else {
    // leaving the Agenda on a laptop takes its docked details with it
    if (dockedDay && wide.matches && panel.bookingId && !byId("panel").hidden && document.body.classList.contains("dock")) {
      closePanel();
    }
    dockedDay = "";
  }
  const docked = agenda && !byId("panel").hidden;
  if (document.body.classList.contains("dock") !== docked) {
    document.body.classList.toggle("dock", docked);
  }
  markSelected();
}
export function renderDesktop() {
  if (!wide.matches) {
    document.body.classList.remove("dock");
    return;
  }
  renderSupporters();
  renderRail();
  dock();
}
export function setupDesktop() {
  wide.addEventListener("change", function () {
    dockedDay = "";
    renderDesktop();
  });
  // the panel opening or closing, and switching between Calendar, Agenda and the other sections
  new MutationObserver(function () {
    if (wide.matches) {
      dock();
    }
  }).observe(byId("panel"), { attributes: true, attributeFilter: ["hidden"] });
  let wasAgenda = agendaShown();
  new MutationObserver(function () {
    const now = agendaShown();
    if (now !== wasAgenda) {
      wasAgenda = now;
      if (wide.matches) {
        dock();
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // a booking picked in the agenda is highlighted once its details show
  byId("agenda").addEventListener("click", function () {
    setTimeout(markSelected);
  });
}
