// The laptop layout (1100 px and wider; 15-desktop.css), after the "World class calendar" design: the header becomes a
// slim icon sidebar (the sections, and who is signed in), the week's title row gains the week number, the "needs a supporter" pill, search and the bell, and from 1240 px a
// right-hand panel shows the interview on now or next and today's list. Clicking the week's title opens the month under it.
// A picked interview's full details open on the right, over that panel. Laptops have no Agenda (the week covers it);
// phones keep theirs. Narrower screens never see any of it.
import { byId, el, onEnterOrSpace } from "./dom";
import { dayKeyOf, formatDay, formatTime, weekStart } from "./time";
import { titleCase } from "./labels";
import { request } from "./api";
import { boot, colorClass, render, state, view } from "./state";
import { closePanel, initials, panel } from "./panel";
import { showBooking } from "./booking-panel";
import { dayItems } from "./week";
import { isoWeek, monthDays, nextInterview, shiftMonth, untilLabel } from "./rail-data";
import type { Booking } from "./types";

const wide = matchMedia("(min-width: 1100px)");
const railWide = matchMedia("(min-width: 1240px)");
let railMonth = ""; // the month the title's popover shows, "YYYY-MM"; follows the week on screen until its arrows are used
let railWeek = "";
let monthOpen = false; // the month popover under the week's title
let weekDocked = false; // a booking's details are docked over the week's right-hand panel
let me = ""; // the signed-in admin's email, for the sidebar

function agendaShown() {
  const classes = document.body.classList;
  return classes.contains("on-cal") && !classes.contains("wkv");
}
function weekShown() {
  const classes = document.body.classList;
  return classes.contains("on-cal") && classes.contains("wkv");
}
function line(booking: Booking) {
  return [booking.company, booking.round].filter(Boolean).join(" · ");
}
function minutes(booking: Booking) {
  return Math.round((Date.parse(booking.end) - Date.parse(booking.start)) / 60000) + " min";
}
function range(booking: Booking) {
  return formatTime(new Date(booking.start)) + " – " + formatTime(new Date(booking.end));
}
function avatar(name: string) {
  return el("span", {
    class: "av " + (name ? colorClass(name) : "cn"),
    "aria-hidden": "true",
    text: name ? initials(name).charAt(0) : "?",
  });
}
// the booking whose full details are open on the right, if any
function openId() {
  return byId("panel").hidden ? "" : panel.bookingId;
}
function pick(id: string) {
  if (openId() === id) {
    closePanel();
  } else {
    showBooking(id);
  }
}

// ---- moving a few page parts into the laptop layout and back ----
function relocate() {
  const attn = byId("attn");
  const bell = document.getElementById("pushBtn");
  const bar = document.querySelector(".bar")!;
  const wk = bar.querySelector(".wk")!;
  if (wide.matches) {
    if (!document.getElementById("wkno")) {
      wk.querySelector("h1")!.after(el("span", { id: "wkno", class: "wkno" }));
      wk.appendChild(el("span", { id: "allok", class: "allok", hidden: true, text: "Every interview is covered" }));
    }
    if (attn.parentElement !== wk) {
      wk.insertBefore(attn, byId("allok"));
    }
    if (bell && bell.parentElement !== bar) {
      bar.appendChild(bell);
    }
  } else {
    if (attn.parentElement === wk) {
      byId("cards").after(attn);
    }
    if (bell && bell.parentElement === bar) {
      document.querySelector(".top .tr")!.insertBefore(bell, byId("thBtn"));
    }
  }
}

// ---- sidebar ----
function renderUser() {
  let box = document.getElementById("sideMe");
  if (!me) {
    if (box) {
      box.remove();
    }
    return;
  }
  if (!box) {
    box = el("div", { id: "sideMe", class: "sme" });
    document.querySelector(".top .tr")!.prepend(box);
  }
  box.textContent = "";
  box.title = me + (boot.owner ? " · Owner" : " · Admin");
  box.appendChild(el("span", { class: "sme-a", "aria-hidden": "true", text: me.charAt(0).toUpperCase() }));
  box.appendChild(
    el("span", { class: "sme-t" }, [el("b", { text: me, title: me }), el("small", { text: boot.owner ? "Owner" : "Admin" })]),
  );
}

// ---- the week's title row ----
function renderTitleRow() {
  const number = isoWeek(view.week!);
  byId("wkno").textContent = "W" + number.week + " · " + number.year;
  const attn = byId("attn");
  byId("allok").hidden = !state.ready || !attn.hidden;
  if (attn.hidden) {
    return;
  }
  // "2 interviews need a supporter · Review", from the line summary.ts writes
  const count = parseInt(attn.textContent || "0", 10) || 0;
  attn.textContent = "";
  attn.appendChild(el("i", { "aria-hidden": "true" }));
  attn.appendChild(
    el("span", { class: "at-l", text: count + (count === 1 ? " interview needs a supporter" : " interviews need a supporter") }),
  );
  attn.appendChild(el("span", { class: "at-s", "aria-hidden": "true", text: count + " unassigned" }));
  attn.appendChild(el("b", { text: "Review" }));
  const list = attn.onclick;
  attn.onclick = function (event) {
    const first = state.events.find(function (booking) {
      return Date.parse(booking.start) <= Date.now() && !state.iv.assign[booking.id] && !booking.missed;
    });
    if (count === 1 && first && railWide.matches && weekShown()) {
      showBooking(first.id);
    } else if (list) {
      list.call(attn, event);
    }
  };
}

// ---- the Calendar's right-hand panel ----
function railItem(booking: Booking, next: boolean) {
  const who = state.iv.assign[booking.id] || "";
  return el(
    "button",
    {
      type: "button",
      class:
        "rl-i " +
        (who ? colorClass(who) : "cn") +
        (next ? " next" : "") +
        (openId() === booking.id ? " on" : "") +
        (Date.parse(booking.end) <= Date.now() ? " past" : ""),
      "data-id": booking.id,
      onclick: function () {
        pick(booking.id);
      },
    },
    [
      el("span", { class: "rl-t" }, [formatTime(new Date(booking.start)), el("small", { text: minutes(booking) })]),
      el("i", { class: "rl-dot", "aria-hidden": "true" }),
      el("span", { class: "rl-b" }, [el("b", { text: titleCase(booking.name) }), el("small", { text: line(booking) })]),
    ],
  );
}
function monthBlock(today: string) {
  const busy: Record<string, boolean> = {};
  state.events.forEach(function (booking) {
    if (!booking.cancelled) {
      busy[dayKeyOf(new Date(booking.start))] = true;
    }
  });
  const arrow = function (step: number, label: string) {
    return el("button", {
      type: "button",
      class: "rl-ar " + (step < 0 ? "prev" : "next"),
      "aria-label": label,
      onclick: function () {
        railMonth = shiftMonth(railMonth, step);
        renderMonth();
      },
    });
  };
  const title = formatDay(railMonth + "-15", { month: "long", year: "numeric" });
  const grid = el("div", { class: "rl-m", role: "group", "aria-label": title });
  ["M", "T", "W", "T", "F", "S", "S"].forEach(function (letter) {
    grid.appendChild(el("span", { class: "rl-w", "aria-hidden": "true", text: letter }));
  });
  monthDays(railMonth).forEach(function (cell, index) {
    const inWeek = weekStart(cell.day) === view.week;
    grid.appendChild(
      el(
        "button",
        {
          type: "button",
          class:
            "rl-d" +
            (cell.inMonth ? "" : " out") +
            (inWeek ? " wk" + (index % 7 === 0 ? " wk0" : index % 7 === 6 ? " wk6" : "") : "") +
            (cell.day < today ? " gone" : "") +
            (cell.day === today ? " td" : "") +
            (busy[cell.day] ? " has" : ""),
          "aria-label":
            formatDay(cell.day, { weekday: "long", month: "long", day: "numeric" }) + (busy[cell.day] ? ", has interviews" : ""),
          "aria-current": cell.day === today ? "date" : null,
          onclick: function () {
            monthOpen = false;
            view.day = cell.day;
            view.week = weekStart(cell.day);
            render();
          },
        },
        [el("span", { text: String(+cell.day.slice(8)) })],
      ),
    );
  });
  return el("section", { class: "rl-sec" }, [
    el("div", { class: "rl-mh" }, [el("h2", { text: title }), el("span", null, [arrow(-1, "Previous month"), arrow(1, "Next month")])]),
    grid,
  ]);
}
function nextCard(next: Booking) {
  const who = state.iv.assign[next.id] || "";
  return el(
    "button",
    {
      type: "button",
      class: "rl-next",
      onclick: function () {
        pick(next.id);
      },
    },
    [
      el("span", { class: "rl-nh" }, [
        el("span", { text: Date.parse(next.start) <= Date.now() ? "On now" : "Up next" }),
        el("small", { text: untilLabel(next, Date.now()) }),
      ]),
      el("b", { text: titleCase(next.name) }),
      el("span", { class: "rl-s", text: line(next) }),
      el("span", { class: "rl-tm", text: range(next) }),
      el("span", { class: "rl-who" }, [avatar(who), who ? who + " supporting" : "No supporter yet"]),
    ],
  );
}
// The month opens under the week's title (in place of the date box phones use) and closes once a day is picked.
function renderMonth() {
  const title = byId("title");
  let pop = document.getElementById("mpop");
  const can = wide.matches && weekShown();
  const show = monthOpen && can && state.ready;
  // a button only where it opens something: phones keep their date box
  if (can) {
    title.setAttribute("role", "button");
    title.setAttribute("tabindex", "0");
    title.setAttribute("aria-haspopup", "dialog");
    title.setAttribute("aria-expanded", String(show));
    title.title = "Go to a date";
  } else {
    ["role", "tabindex", "aria-haspopup", "aria-expanded", "title"].forEach(function (name) {
      title.removeAttribute(name);
    });
  }
  if (!show) {
    monthOpen = false;
    if (pop) {
      pop.remove();
    }
    return;
  }
  if (railWeek !== view.week) {
    railWeek = view.week!;
    railMonth = (view.day || view.week!).slice(0, 7);
  }
  if (!pop) {
    pop = el("div", { id: "mpop", class: "mpop", role: "dialog", "aria-label": "Go to a date" });
    title.after(pop);
  }
  pop.textContent = "";
  pop.appendChild(monthBlock(dayKeyOf(Date.now())));
}
function toggleMonth(open: boolean) {
  monthOpen = open;
  if (open) {
    railWeek = ""; // start on the week on screen
  }
  renderMonth();
  if (!open) {
    byId("title").focus();
  }
}
function renderRail() {
  let rail = document.getElementById("rail");
  if (!rail) {
    rail = el("aside", { id: "rail", class: "rail", "aria-label": "Up next and today" });
    byId("viewCal").appendChild(rail);
  }
  rail.textContent = "";
  if (!state.ready) {
    return;
  }
  const now = Date.now();
  const today = dayKeyOf(now);
  const next = nextInterview(state.events, now);
  if (next) {
    rail.appendChild(nextCard(next));
  }
  const todays = dayItems(today).filter(function (item) {
    return !item.booking.cancelled;
  });
  const list = el("section", { class: "rl-sec" }, [
    el("div", { class: "rl-th" }, [
      el("h2", { text: "Today" }),
      el("small", { text: formatDay(today, { weekday: "short", month: "short", day: "numeric" }) }),
    ]),
  ]);
  if (!todays.length) {
    list.appendChild(el("p", { class: "rl-none", text: "No interviews today" }));
  }
  todays.forEach(function (item) {
    list.appendChild(railItem(item.booking, !!next && next.id === item.booking.id));
  });
  rail.appendChild(list);
}
// The week and today's list: the interview whose details are open is outlined.
function markWeek() {
  const open = openId();
  document.querySelectorAll<HTMLElement>("#week .ev, #rail .rl-i").forEach(function (block) {
    block.classList.toggle(block.classList.contains("rl-i") ? "on" : "sel", !!open && block.getAttribute("data-id") === open);
  });
}

// ---- a booking's details stay open on the right of the week (1240 px and wider) ----
function dock() {
  const docked = railWide.matches && weekShown() && !!panel.bookingId && !byId("panel").hidden;
  // leaving the week takes its docked details with it
  if (weekDocked && !docked && wide.matches && panel.bookingId && !byId("panel").hidden) {
    closePanel();
  }
  weekDocked = docked;
  if (document.body.classList.contains("dock") !== docked) {
    document.body.classList.toggle("dock", docked);
  }
  markWeek();
}
// Laptops show the week only: an Agenda link or a phone-sized window grown wide lands on the Calendar.
function leaveAgenda() {
  if (wide.matches && agendaShown()) {
    byId("tabCal").click();
  }
}

export function renderDesktop() {
  relocate();
  if (!wide.matches) {
    document.body.classList.remove("dock");
    return;
  }
  leaveAgenda();
  renderUser();
  renderTitleRow();
  renderMonth();
  renderRail();
  dock();
}
export function setupDesktop() {
  // the sidebar shows the sections as icons; hovering one names it
  document.querySelectorAll<HTMLElement>(".top .tabs button").forEach(function (tab) {
    tab.title = ((tab.firstChild && tab.firstChild.textContent) || "").trim();
  });
  // the week's title opens the month under it
  const title = byId("title");
  title.addEventListener("click", function () {
    if (wide.matches && weekShown()) {
      toggleMonth(!monthOpen);
    }
  });
  title.addEventListener(
    "keydown",
    onEnterOrSpace(function () {
      if (wide.matches && weekShown()) {
        toggleMonth(!monthOpen);
      }
    }),
  );
  document.addEventListener("click", function (event) {
    const target = event.target as Node;
    // a click inside the month redraws it, so the button clicked may already be gone from the page
    if (monthOpen && document.contains(target) && !title.contains(target) && !document.getElementById("mpop")?.contains(target)) {
      monthOpen = false;
      renderMonth();
    }
  });
  railWide.addEventListener("change", function () {
    dock();
  });
  wide.addEventListener("change", function () {
    renderDesktop();
  });
  new MutationObserver(function () {
    if (wide.matches) {
      dock();
    }
  }).observe(byId("panel"), { attributes: true, attributeFilter: ["hidden"] });
  let wasWeek = weekShown();
  new MutationObserver(function () {
    const now = weekShown();
    if (now !== wasWeek) {
      wasWeek = now;
      if (wide.matches) {
        leaveAgenda();
        dock();
      }
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // "/" goes to the search box; Esc lets go of the picked interview
  document.addEventListener("keydown", function (event) {
    if (!wide.matches) {
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName || "");
    if (event.key === "/" && !typing && weekShown()) {
      event.preventDefault();
      byId("q").focus();
    } else if (event.key === "Escape" && monthOpen) {
      toggleMonth(false);
    }
  });
  // who is signed in, for the sidebar: owners can ask; other admins' sidebar just has no name
  if (boot.login && boot.owner) {
    request<{ me: string }>("/admin/api/admins")
      .then(function (answer) {
        me = answer && answer.me ? answer.me : "";
        renderUser();
      })
      .catch(function () {});
  }
}
