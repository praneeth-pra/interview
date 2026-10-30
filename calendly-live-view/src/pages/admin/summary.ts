// Above the calendar: the summary cards, the line about started interviews with no supporter recorded, and the legend.
import { byId, el } from "./dom";
import { dayKeyOf, formatDay, formatIst, formatTime, weekStart } from "./time";
import { titleCase } from "./labels";
import { colorClass, render, state, view } from "./state";
import { showBooking, showList } from "./booking-panel";

export function renderCards() {
  const now = Date.now();
  const today = dayKeyOf(new Date());
  const upcoming = state.events.filter(function (booking) {
    return Date.parse(booking.end) > now;
  });
  const todays = state.events.filter(function (booking) {
    return dayKeyOf(new Date(booking.start)) === today;
  });
  const unassigned = state.events.filter(function (booking) {
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id] && !booking.missed;
  });
  const next = upcoming.filter(function (booking) {
    return Date.parse(booking.start) > now;
  })[0];
  const cards = byId("cards");
  cards.textContent = "";
  function card(label: string, value: string, onClick: (() => void) | null, extraClass?: string, small?: boolean) {
    cards.appendChild(
      el(
        onClick ? "button" : "div",
        {
          class: "card" + (extraClass || ""),
          type: onClick ? "button" : null,
          onclick: onClick || null,
        },
        [
          el("div", {
            class: "k",
            text: label,
          }),
          el("div", {
            class: "v" + (small ? " sm" : ""),
            text: value,
          }),
        ],
      ),
    );
  }
  card("Upcoming", String(upcoming.length), function () {
    showList("Upcoming bookings", upcoming.length + (upcoming.length === 1 ? " booking" : " bookings") + " from now on", upcoming);
  });
  card("Today", String(todays.length), function () {
    view.day = today;
    view.week = weekStart(today);
    render();
    showList(
      "Today",
      formatDay(today, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }),
      todays,
    );
  });
  card(
    "Support not recorded",
    String(unassigned.length),
    unassigned.length
      ? function () {
          showList("Support not recorded", "Started interviews with no interview supporter recorded", unassigned);
        }
      : null,
    unassigned.length ? " attn" : "",
  );
  card(
    "Next up",
    next
      ? formatIst(
          {
            weekday: "short",
          },
          new Date(next.start),
        ) +
          " " +
          formatTime(new Date(next.start)) +
          " · " +
          titleCase(next.name)
      : "Nothing booked",
    next
      ? function () {
          showBooking(next.id);
        }
      : null,
    "",
    true,
  );
}
// One line above the calendar when started interviews have no interviewer recorded; each such booking has an amber dot.
export function renderAttention() {
  const now = Date.now();
  const unassigned = state.events.filter(function (booking) {
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id] && !booking.missed;
  });
  const line = byId("attn");
  line.hidden = !unassigned.length;
  line.removeAttribute("aria-label"); // the laptop pill (desktop.ts) labels its shorter text
  line.textContent =
    unassigned.length + (unassigned.length === 1 ? " interview has no supporter recorded" : " interviews have no supporter recorded");
  line.onclick = function () {
    showList("Support not recorded", "Started interviews with no interview supporter recorded", unassigned);
  };
}
export function renderLegend() {
  const legend = byId("legend");
  legend.textContent = "";
  state.iv.names.forEach(function (name) {
    legend.appendChild(
      el("span", {
        class: "lg " + colorClass(name),
        text: name,
      }),
    );
  });
  legend.appendChild(
    el("span", {
      class: "lg cn",
      text: "None yet",
    }),
  );
}
