// The laptop layout (1100 px and wider; 15-desktop.css), after the "World class calendar" design: the header becomes a
// slim icon sidebar (the sections, and who is signed in), the week's title row gains the week number, the "needs a supporter" pill, search and the bell, and from 1240 px a
// right-hand panel shows the month, the picked interview (or the one on now or next) and today's list. The Agenda keeps
// the picked interview's details open beside the day. Narrower screens never see any of it.
import { byId, el, toast } from "./dom";
import { dayKeyOf, formatDay, formatTime, weekStart } from "./time";
import { statusOf, titleCase } from "./labels";
import { request } from "./api";
import { boot, colorClass, hooks, render, state, view } from "./state";
import { closePanel, initials, panel } from "./panel";
import { showBooking, showReschedule } from "./booking-panel";
import { agendaDay } from "./agenda";
import { dayItems } from "./week";
import { dockPick, isoWeek, monthDays, nextInterview, shiftMonth, untilLabel } from "./rail-data";
import type { Booking } from "./types";

const wide = matchMedia("(min-width: 1100px)");
const railWide = matchMedia("(min-width: 1240px)");
let railMonth = ""; // the month the panel shows, "YYYY-MM"; follows the week on screen until its arrows are used
let railWeek = "";
let picked = ""; // the booking shown in the Calendar's side panel
let dockedDay = ""; // the agenda day whose interview was last opened beside it, so a closed panel stays closed
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
function findEvent(id: string) {
  return state.events.find(function (booking) {
    return booking.id === id;
  });
}
function pick(id: string) {
  picked = picked === id ? "" : id;
  renderRail();
  markWeek();
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
      picked = "";
      pick(first.id);
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
        (picked === booking.id ? " on" : "") +
        (Date.parse(booking.end) <= Date.now() ? " past" : ""),
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
        renderRail();
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
function supporterChips(booking: Booking) {
  const who = state.iv.assign[booking.id] || "";
  const started = Date.parse(booking.start) <= Date.now();
  const open = started && !who && !booking.missed;
  const chips = el("div", { class: "rl-ch" });
  state.iv.names.forEach(function (name) {
    chips.appendChild(
      el(
        "button",
        {
          type: "button",
          class: colorClass(name) + (who === name ? " on" : ""),
          "aria-pressed": String(who === name),
          disabled: !open,
          onclick: function () {
            if (
              confirm("Record " + name + " as the interview supporter for " + titleCase(booking.name) + "? This can't be changed later.")
            ) {
              const change: Record<string, string> = {};
              change[booking.id] = name;
              request("/admin/api/interviewers", { set: change }, "PUT")
                .then(function () {
                  toast("Supporter saved");
                })
                .catch(function (error) {
                  toast(error.message);
                });
            }
          },
        },
        [avatar(name), name],
      ),
    );
  });
  const note = who ? "Locked once recorded." : !started ? "Can be recorded once it starts." : "";
  return el("div", { class: "rl-sup" }, [el("h3", { text: "Supporter" }), chips, note ? el("p", { class: "rl-note", text: note }) : null]);
}
function pickedCard(booking: Booking) {
  const who = state.iv.assign[booking.id] || "";
  const status =
    !who && !booking.cancelled && !booking.missed && Date.parse(booking.start) <= Date.now() ? "Needs supporter" : statusOf(booking);
  const upcoming = Date.parse(booking.start) > Date.now() && !booking.cancelled;
  return el("section", { class: "rl-card", "aria-label": "Picked interview" }, [
    el("div", { class: "rl-top" }, [
      el("span", { class: "rl-st st-" + status.toLowerCase().replace(/[^a-z]+/g, "-") }, [el("i", { "aria-hidden": "true" }), status]),
      el("button", {
        type: "button",
        class: "rl-x",
        "aria-label": "Close",
        title: "Close (Esc)",
        onclick: function () {
          pick(booking.id);
        },
      }),
    ]),
    el("h2", { class: "rl-n", text: titleCase(booking.name) }),
    el("p", { class: "rl-s", text: line(booking) || "No company given" }),
    el("div", { class: "rl-when" }, [
      el("i", { "aria-hidden": "true" }),
      el("span", {
        text: formatDay(dayKeyOf(new Date(booking.start)), { weekday: "short", month: "short", day: "numeric" }) + " · " + range(booking),
      }),
      el("small", { text: minutes(booking) }),
    ]),
    booking.cancelled ? null : supporterChips(booking),
    el("div", { class: "rl-btns" }, [
      el("button", {
        type: "button",
        text: upcoming ? "Reschedule" : "All details",
        onclick: function () {
          if (upcoming) {
            showReschedule(booking);
          } else {
            showBooking(booking.id);
          }
        },
      }),
      el("button", {
        type: "button",
        text: "Candidate profile",
        onclick: function () {
          window.__openContact?.(booking.id);
        },
      }),
    ]),
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
  rail.appendChild(monthBlock(today));
  const chosen = picked ? findEvent(picked) : undefined;
  if (picked && !chosen) {
    picked = "";
  }
  const next = nextInterview(state.events, now);
  if (chosen) {
    rail.appendChild(pickedCard(chosen));
  } else if (next) {
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
// The week: the picked interview is outlined.
function markWeek() {
  document.querySelectorAll<HTMLElement>("#week .ev").forEach(function (block) {
    block.classList.toggle("sel", !!picked && block.getAttribute("data-id") === picked);
  });
}

// ---- the Agenda: the picked interview's details stay open on the right ----
function markAgenda() {
  const open = !byId("panel").hidden && panel.bookingId;
  document.querySelectorAll<HTMLElement>("#agenda .ag-i").forEach(function (block) {
    block.classList.toggle("sel", !!open && block.getAttribute("data-id") === open);
  });
}
function dock() {
  const agenda = wide.matches && agendaShown() && state.ready;
  if (agenda) {
    const day = agendaDay()!;
    if (day !== dockedDay) {
      dockedDay = day;
      const choice = dockPick(
        dayItems(day).map(function (item) {
          return item.booking;
        }),
        Date.now(),
      );
      if (choice && (byId("panel").hidden || panel.bookingId)) {
        showBooking(choice.id, true);
      } else if (!choice && panel.bookingId && !byId("panel").hidden) {
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
  markAgenda();
}

export function renderDesktop() {
  relocate();
  if (!wide.matches) {
    document.body.classList.remove("dock");
    return;
  }
  renderUser();
  renderTitleRow();
  renderRail();
  markWeek();
  dock();
}
export function setupDesktop() {
  // the sidebar shows the sections as icons; hovering one names it
  document.querySelectorAll<HTMLElement>(".top .tabs button").forEach(function (tab) {
    tab.title = ((tab.firstChild && tab.firstChild.textContent) || "").trim();
  });
  // on laptops with the side panel, a week booking opens there instead of the sheet
  hooks.weekClick = function (id) {
    if (!(railWide.matches && weekShown())) {
      return false;
    }
    pick(id);
    return true;
  };
  wide.addEventListener("change", function () {
    dockedDay = "";
    renderDesktop();
  });
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
  byId("agenda").addEventListener("click", function () {
    setTimeout(markAgenda);
  });
  // "/" goes to the search box; Esc lets go of the picked interview
  document.addEventListener("keydown", function (event) {
    if (!wide.matches) {
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName || "");
    if (event.key === "/" && !typing && weekShown()) {
      event.preventDefault();
      byId("q").focus();
    } else if (event.key === "Escape" && picked && byId("panel").hidden) {
      pick(picked);
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
