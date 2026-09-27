// Admin calendar: week grid and agenda, booking panel, reschedule/cancel, candidate search, the tabs and the live
// connection to /admin/stream. The ⋯ menu's sections, Enquiries and Payments are in their own modules.
import { byId, el, onEnterOrSpace, setMessage, toast } from "./dom";
import {
  addDays,
  dayKeyOf,
  formatDay,
  formatIst,
  formatRange,
  formatTime,
  hourLabel,
  minutesOfDay,
  shortDate,
  timeAgo,
  weekStart,
} from "./time";
import { ROUND_STATUSES, byWhom, missedLabel, plural, roundStatus, statusOf, statusPill, titleCase, type RoundStatus } from "./labels";
import { request, freshReload } from "./api";
import { sameCompany } from "../../same-company";
import { setupAlerts } from "./alerts";
import { setupThemeSwitch } from "./theme-switch";
import { setupDownloadMenu } from "./download-menu";
import { setupNav } from "./nav";
import { showRevenue } from "./revenue";
import { setupStatsFrame } from "./stats-frame";
import { boot, colorClass, forget, remember, setState, state } from "./state";
import { closePanel, icon, initials, openPanel, panel, setPanelAvatar } from "./panel";
import { showInterviewers } from "./interviewers";
import { showAdmins } from "./admins";
import { renderEnquiryBadge, setupEnquiries, showEnquiries } from "./enquiries";
import { refreshPayments, showPayments } from "./payments";
import { setupAllowlist, showCandidates, syncAllow } from "./allowlist";
import type { Booking } from "./types";

var HOUR_PX = 64;
var selectedDay: string | null = null; // the day picked in the date box, or null

var weekOf: string | null = null; // Monday of the week on screen
var live = false; // connected to /admin/stream
var stream: EventSource | null = null;
var allBookings: Booking[] | null = null; // every booking, for search; refetched after 30s
var allBookingsAt = 0;
var dateParam = new URLSearchParams(location.search).get("date");
if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) {
  selectedDay = dateParam;
}
function findBooking(id: string) {
  function find(list: Booking[] | null) {
    return (list || []).filter(function (booking) {
      return booking.id === id;
    })[0];
  }
  return find(state.events) || find(state.changes) || find(allBookings);
}
// The connection state shows only when something is wrong: "Offline" at once, "Reconnecting…" after 8 seconds.
var statusTimer = 0;
function renderStatus() {
  var status = byId("status");
  var offline = navigator.onLine === false;
  status.lastChild.textContent = live ? "Live" : offline ? "Offline" : "Reconnecting…";
  clearTimeout(statusTimer);
  if (live) {
    status.className = "status live";
  } else if (offline) {
    status.className = "status bad";
  } else if (status.className.indexOf("bad") < 0) {
    statusTimer = window.setTimeout(function () {
      if (!live) {
        status.className = "status bad";
      }
    }, 8000);
  }
}
function renderCards() {
  var now = Date.now();
  var today = dayKeyOf(new Date());
  var upcoming = state.events.filter(function (booking) {
    return Date.parse(booking.end) > now;
  });
  var todays = state.events.filter(function (booking) {
    return dayKeyOf(new Date(booking.start)) === today;
  });
  var unassigned = state.events.filter(function (booking) {
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id] && !booking.missed;
  });
  var next = upcoming.filter(function (booking) {
    return Date.parse(booking.start) > now;
  })[0];
  var cards = byId("cards");
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
    selectedDay = today;
    weekOf = weekStart(today);
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
function renderAttention() {
  var now = Date.now();
  var unassigned = state.events.filter(function (booking) {
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id] && !booking.missed;
  });
  var line = byId("attn");
  line.hidden = !unassigned.length;
  line.textContent =
    unassigned.length + (unassigned.length === 1 ? " interview has no supporter recorded" : " interviews have no supporter recorded");
  line.onclick = function () {
    showList("Support not recorded", "Started interviews with no interview supporter recorded", unassigned);
  };
}
function renderLegend() {
  var legend = byId("legend");
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
// A booking placed on the week grid: minutes since midnight, and its column within a group of overlapping bookings.
type Item = { booking: Booking; from: number; to: number; col?: number; group?: { end: number; cols: number[] } };
function dayItems(day: string): Item[] {
  return state.events
    .filter(function (booking) {
      return dayKeyOf(new Date(booking.start)) === day;
    })
    .map(function (booking): Item {
      var start = new Date(booking.start);
      var from = minutesOfDay(start);
      var minutes = Math.max(15, Math.round((Date.parse(booking.end) - +start) / 60000));
      return {
        booking: booking,
        from: from,
        to: Math.min(1440, from + minutes),
      };
    })
    .sort(function (first, second) {
      return first.from - second.from || first.to - second.to;
    });
}
// Overlapping bookings share the column width: each gets a col index within its group.
function layoutColumns(items: Item[]) {
  var group = null;
  items.forEach(function (item) {
    if (!group || item.from >= group.end) {
      group = {
        end: item.to,
        cols: [],
      };
    }
    for (var col = 0; group.cols[col] !== undefined && group.cols[col] > item.from;) {
      col++;
    }
    group.cols[col] = item.to;
    item.col = col;
    item.group = group;
    group.end = Math.max(group.end, item.to);
  });
}
// "Sep 21 – 27", "Sep 28 – Oct 4", with the year only when it isn't this year.
function weekTitle(first: string) {
  var last = addDays(first, 6);
  var year = first.slice(0, 4) !== dayKeyOf(new Date()).slice(0, 4) ? ", " + last.slice(0, 4) : "";
  var sameMonth = first.slice(0, 7) === last.slice(0, 7);
  return (
    formatDay(first, { month: "short", day: "numeric" }) +
    " – " +
    (sameMonth ? String(+last.slice(8)) : formatDay(last, { month: "short", day: "numeric" })) +
    year
  );
}
function renderWeek() {
  var today = dayKeyOf(new Date());
  var days = [];
  var itemsByDay: Item[][] = [];
  var i;
  var fromMin = state.hours.start;
  var toMin = state.hours.end;
  var now = Date.now();
  var nowMin = minutesOfDay(new Date());
  for (i = 0; i < 7; i++) {
    days.push(addDays(weekOf, i));
    itemsByDay.push(dayItems(days[i]));
  }
  itemsByDay.forEach(function (items) {
    items.forEach(function (item) {
      fromMin = Math.min(fromMin, item.from);
      toMin = Math.max(toMin, item.to);
    });
  });
  var firstHour = Math.floor(fromMin / 60);
  var lastHour = Math.min(24, Math.ceil(toMin / 60));
  var height = (lastHour - firstHour) * HOUR_PX;
  byId("title").textContent = weekTitle(weekOf);
  byId<HTMLInputElement>("pick").value = selectedDay || today;
  var week = byId("week");
  var firstPaint = !week.firstChild;
  var scrollX = week.scrollLeft;
  var scrollY = week.scrollTop;
  week.textContent = "";
  var grid = el("div", {
    class: "grid",
  });
  grid.style.setProperty("--hr", HOUR_PX + "px");
  grid.appendChild(
    el("div", {
      class: "corner",
    }),
  );
  days.forEach(function (day) {
    grid.appendChild(
      el(
        "div",
        {
          class: "gh" + (day === today ? " today" : ""),
        },
        [
          el("b", {
            text:
              formatDay(day, {
                weekday: "short",
              }) +
              " " +
              +day.slice(8),
          }),
        ],
      ),
    );
  });
  var axis = el("div", {
    class: "axis",
  });
  axis.style.height = height + "px";
  i = firstHour;
  for (; i <= lastHour; i++) {
    var label = el("span", {
      text: hourLabel(i),
    });
    label.style.top = (i - firstHour) * HOUR_PX + "px";
    if (i === firstHour) {
      label.style.transform = "none";
    }
    if (i === lastHour) {
      label.style.transform = "translateY(-100%)";
    }
    axis.appendChild(label);
  }
  grid.appendChild(axis);
  days.forEach(function (day, index) {
    var column = el("div", {
      class: "col" + (day === today ? " today" : ""),
    });
    column.style.height = height + "px";
    layoutColumns(itemsByDay[index]);
    itemsByDay[index].forEach(function (item) {
      var booking = item.booking;
      var interviewer = state.iv.assign[booking.id];
      var cols = item.group.cols.length;
      var isPast = Date.parse(booking.end) <= now;
      var started = Date.parse(booking.start) <= now;
      var boxHeight = Math.max(22, ((item.to - item.from) / 60) * HOUR_PX - 2);
      var button = el(
        "button",
        {
          type: "button",
          class:
            "ev " +
            (interviewer ? colorClass(interviewer) : "cn") +
            (isPast ? " past" : "") +
            (started && !interviewer && !booking.missed ? " need" : "") +
            (booking.missed ? " missed" : "") +
            (boxHeight < 50 ? " short" : ""),
          title: [
            titleCase(booking.name),
            booking.company,
            booking.round,
            interviewer ? "Interview support: " + interviewer : booking.missed ? missedLabel(booking) : started ? "Interview support not recorded" : "",
            booking.outcome ? statusPill(booking).text : "",
          ]
            .filter(Boolean)
            .join(" · "),
          onclick: function () {
            showBooking(booking.id);
          },
        },
        [
          el("b", {
            text: titleCase(booking.name),
          }),
          // No times on the grid (the box's position shows it): company and round, on one line in a
          // 30-minute box, on their own lines when there is room.
          ...(boxHeight >= 50
            ? [booking.company, booking.round]
            : boxHeight > 26
              ? [[booking.company, booking.round].filter(Boolean).join(" · ")]
              : []
          ).map(function (text) {
            return text ? el("span", { text: text }) : null;
          }),
        ],
      );
      button.style.top = ((item.from - firstHour * 60) / 60) * HOUR_PX + 1 + "px";
      button.style.height = boxHeight + "px";
      button.style.left = "calc(" + (item.col * 100) / cols + "% + 2px)";
      button.style.width = "calc(" + 100 / cols + "% - 4px)";
      column.appendChild(button);
    });
    if (day === today && nowMin >= firstHour * 60 && nowMin <= lastHour * 60) {
      var nowLine = el("div", {
        class: "now",
      });
      nowLine.style.top = ((nowMin - firstHour * 60) / 60) * HOUR_PX + "px";
      column.appendChild(nowLine);
    }
    grid.appendChild(column);
  });
  week.appendChild(grid);
  if (firstPaint) {
    var todayIndex = days.indexOf(today);
    if (todayIndex >= 0) {
      week.scrollTop = Math.max(0, ((nowMin - firstHour * 60) / 60) * HOUR_PX - HOUR_PX * 2);
      if (week.scrollWidth > week.clientWidth) {
        week.scrollLeft = Math.max(0, (todayIndex * (grid.scrollWidth - 56)) / 7);
      }
    }
  } else {
    week.scrollLeft = scrollX;
    week.scrollTop = scrollY;
  }
}
// The agenda: one day at a time, like a phone calendar's Day view. A week strip picks the day (the day on screen circled
// in orange, dots for days with interviews), then an hour grid holds that day's interviews as blocks sized to their
// length, tinted in the interview supporter's colour (grey when none), with a line at the current time today.
var AGENDA_HOUR_PX = 80;
function agendaDay() {
  var today = dayKeyOf(new Date());
  if (selectedDay && weekStart(selectedDay) === weekOf) {
    return selectedDay;
  }
  if (weekStart(today) === weekOf) {
    return today;
  }
  for (var i = 0; i < 7; i++) {
    if (dayItems(addDays(weekOf, i)).length) {
      return addDays(weekOf, i);
    }
  }
  return weekOf;
}
function pickAgendaDay(day: string) {
  selectedDay = day;
  weekOf = weekStart(day);
  render();
}
function renderAgenda() {
  var box = byId("agenda");
  if (!box) {
    return;
  }
  var today = dayKeyOf(new Date());
  var now = Date.now();
  var shown = agendaDay();
  box.textContent = "";
  var strip = el("div", {
    class: "ws",
    role: "group",
    "aria-label": "Days",
  });
  for (var i = 0; i < 7; i++) {
    let day = addDays(weekOf, i);
    var count = dayItems(day).length;
    var dots = el("span", {
      class: "ws-d",
      "aria-hidden": "true",
    });
    // a dot per interview in its supporter's colour, up to three, then "+N"
    dayItems(day).forEach(function (item, index) {
      var interviewer = state.iv.assign[item.booking.id];
      if (index < 3) {
        dots.appendChild(el("i", { class: interviewer ? colorClass(interviewer) : "cn" }));
      }
    });
    if (count > 3) {
      dots.appendChild(el("em", { text: "+" + (count - 3) }));
    }
    strip.appendChild(
      el(
        "button",
        {
          type: "button",
          class: "ws-b" + (day === shown ? " on" : "") + (day === today ? " today" : "") + (i >= 5 ? " we" : ""),
          "aria-pressed": day === shown ? "true" : "false",
          "aria-label":
            formatDay(day, { weekday: "long", month: "long", day: "numeric" }) +
            (count ? ", " + count + (count === 1 ? " interview" : " interviews") : ", no interviews"),
          onclick: function () {
            pickAgendaDay(day);
          },
        },
        [el("span", { class: "ws-w", text: formatDay(day, { weekday: "short" }) }), el("b", { text: formatDay(day, { day: "numeric" }) }), dots],
      ),
    );
  }
  box.appendChild(strip);
  var items = dayItems(shown);
  layoutColumns(items);
  box.appendChild(
    el("div", { class: "ag-h" + (shown === today ? " today" : "") }, [
      el("b", { text: formatDay(shown, { weekday: "long" }) + "," }),
      el("span", { text: formatDay(shown, { day: "numeric", month: "short" }) }),
      el("em", { text: items.length ? items.length + (items.length === 1 ? " interview" : " interviews") : "No interviews" }),
    ]),
  );
  // the hours shown: working hours, stretched to fit the day's interviews and, today, the time now
  var nowMin = minutesOfDay(new Date());
  var fromMin = state.hours.start;
  var toMin = state.hours.end;
  items.forEach(function (item) {
    fromMin = Math.min(fromMin, item.from);
    toMin = Math.max(toMin, item.to);
  });
  if (shown === today && nowMin >= 7 * 60) {
    fromMin = Math.min(fromMin, nowMin);
    toMin = Math.max(toMin, nowMin + 30);
  }
  var firstHour = Math.floor(fromMin / 60);
  var lastHour = Math.min(24, Math.ceil(toMin / 60));
  var grid = el("div", { class: "ag-grid" });
  grid.style.height = (lastHour - firstHour) * AGENDA_HOUR_PX + "px";
  for (var hour = firstHour; hour <= lastHour; hour++) {
    var line = el("div", { class: "ag-hr" }, [el("span", { text: hour === 12 ? "Noon" : hourLabel(hour) })]);
    line.style.top = (hour - firstHour) * AGENDA_HOUR_PX + "px";
    grid.appendChild(line);
  }
  var lane = el("div", { class: "ag-lane" });
  items.forEach(function (item) {
    var booking = item.booking;
    var interviewer = state.iv.assign[booking.id];
    var isPast = Date.parse(booking.end) <= now;
    var needsSupport = !interviewer && Date.parse(booking.start) <= now && !booking.missed;
    var cols = item.group.cols.length;
    var height = Math.max(26, ((item.to - item.from) / 60) * AGENDA_HOUR_PX - 2);
    var block = el(
      "button",
      {
        type: "button",
        class:
          "ag-i " +
          (interviewer ? colorClass(interviewer) : "cn") +
          (isPast ? " past" : "") +
          (booking.missed ? " missed" : "") +
          (height < 34 ? " tiny" : height < 56 ? " short" : height < 66 ? " mid" : "") +
          (booking.outcome || booking.missed ? " has-rs" : ""),
        onclick: function () {
          showBooking(booking.id);
        },
      },
      [
        el("b", { text: titleCase(booking.name) }),
        el("span", { class: "ag-s", text: [booking.company, booking.round, interviewer].filter(Boolean).join(" · ") }),
        el("span", { class: "ag-t", text: formatTime(new Date(booking.start)) + " – " + formatTime(new Date(booking.end)) }),
        // the round's status, when it has one, and a dot when support isn't recorded, in the top corner
        booking.outcome || booking.missed || needsSupport
          ? el("span", { class: "ag-rs" }, [
              booking.outcome || booking.missed ? el("span", statusPill(booking, true)) : null,
              needsSupport
                ? el("i", {
                    class: "need-dot",
                    title: "Support not recorded",
                    "aria-label": "Support not recorded",
                    role: "img",
                  })
                : null,
            ])
          : null,
      ],
    );
    block.style.top = ((item.from - firstHour * 60) / 60) * AGENDA_HOUR_PX + 1 + "px";
    block.style.height = height + "px";
    block.style.left = "calc(" + (item.col * 100) / cols + "% + 2px)";
    block.style.width = "calc(" + 100 / cols + "% - 4px)";
    lane.appendChild(block);
  });
  grid.appendChild(lane);
  if (shown === today && nowMin >= firstHour * 60 && nowMin <= lastHour * 60) {
    var nowLine = el("div", { class: "ag-now" }, [el("span", { text: formatTime(now) })]);
    nowLine.style.top = ((nowMin - firstHour * 60) / 60) * AGENDA_HOUR_PX + "px";
    grid.appendChild(nowLine);
  }
  box.appendChild(grid);
}
function render() {
  renderEnquiryBadge();
  refreshPayments();
  weekOf ||= weekStart(selectedDay || dayKeyOf(new Date()));
  renderStatus();
  if (state.ready) {
    byId("banner").hidden = true;
    renderCards();
    renderAttention();
    renderLegend();
    renderWeek();
    renderAgenda();
    if (panel.refresh && !byId("panel").hidden) {
      panel.refresh();
    }
  }
}
function showWeekOf(booking: Booking) {
  var day = dayKeyOf(new Date(booking.start));
  var week = weekStart(day);
  selectedDay = day;
  if (week !== weekOf) {
    weekOf = week;
    render();
  }
}
function showList(title: string, subtitle: string, bookings: Booking[]) {
  panel.refresh = null;
  var body = openPanel(title, subtitle);
  if (!bookings.length) {
    body.appendChild(
      el("p", {
        class: "sub",
        text: "Nothing here.",
      }),
    );
    return;
  }
  var list = el("ul", {
    class: "items",
  });
  bookings.forEach(function (booking) {
    function open() {
      showWeekOf(booking);
      showBooking(booking.id);
    }
    list.appendChild(
      el(
        "li",
        {
          tabindex: "0",
          role: "button",
          onclick: open,
          onkeydown: onEnterOrSpace(open),
        },
        [
          el("b", {
            text: titleCase(booking.name),
          }),
          el("div", {
            class: "m",
            text: formatRange(booking) + (booking.company ? " · " + booking.company : "") + (booking.cancelled ? " · Cancelled" : ""),
          }),
        ],
      ),
    );
  });
  body.appendChild(list);
}
// Another booking the same interviewer has at an overlapping time.
function clashFor(booking: Booking, interviewer: string) {
  if (!interviewer) {
    return "";
  }
  var start = Date.parse(booking.start);
  var end = Date.parse(booking.end);
  for (var index = 0; index < state.events.length; index++) {
    var other = state.events[index];
    if (
      other.id !== booking.id &&
      state.iv.assign[other.id] === interviewer &&
      Date.parse(other.start) < end &&
      Date.parse(other.end) > start
    ) {
      return titleCase(other.name) + " at " + formatTime(new Date(other.start));
    }
  }
  return "";
}
function saveInterviewer(booking: Booking, name: string, msg: HTMLElement) {
  var change = {};
  change[booking.id] = name;
  setMessage(msg, "Saving…");
  request(
    "/admin/api/interviewers",
    {
      set: change,
    },
    "PUT",
  )
    .then(function () {
      toast(name ? "Interview supporter saved" : "Interview supporter cleared");
    })
    .catch(function (error) {
      setMessage(msg, error.message, true);
    });
}
// "in 2 days", "in 3 hours", "in 20 min"
function untilText(ms: number) {
  var minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return "in " + Math.max(1, minutes) + " min";
  } else if (minutes < 24 * 60) {
    return "in " + plural(Math.round(minutes / 60), "hour");
  } else {
    return "in " + plural(Math.round(minutes / 1440), "day");
  }
}
// The round's status in the booking panel, shown once the interview has started (the result comes from the
// interview). One tap saves a status; tapping the selected one clears it. No-show and Didn't happen are offered while
// nobody is recorded as giving support.
function roundStatusCard(booking: Booking, current: RoundStatus | null, supported: boolean) {
  var card = el("div", { class: "bk-card rsc" }, [el("h3", { text: "Round status" })]);
  var msg = el("p", { class: "msg", role: "status" });
  var options = ROUND_STATUSES.filter(function (option) {
    return !supported || option.value !== "noshow" && option.value !== "other";
  });
  var group = el("div", { class: "rs-opts", role: "group", "aria-label": "Round status" });
  var buttons = options.map(function (option) {
    return el(
      "button",
      {
        type: "button",
        class: "rs-opt rs-" + option.key,
        "aria-pressed": String(!!current && option.key === current.key),
        onclick: function () {
          saveRoundStatus(booking, current && option.key === current.key ? null : option, buttons, msg);
        },
      },
      [el("i", { class: "rsd", "aria-hidden": "true" }), option.label],
    );
  });
  buttons.forEach(function (button) {
    group.appendChild(button);
  });
  card.appendChild(group);
  card.appendChild(el("p", { class: "sub rs-hint", text: current ? "Tap " + current.label + " again to clear it." : "Tap how the round went." }));
  card.appendChild(msg);
  return card;
}
// Saves a status (null clears it); the panel redraws when the new state arrives.
function saveRoundStatus(booking: Booking, option: RoundStatus | null, buttons: HTMLElement[], msg: HTMLElement) {
  var before = buttons.map(function (button) {
    return button.getAttribute("aria-pressed");
  });
  buttons.forEach(function (button) {
    button.setAttribute("aria-pressed", String(!!option && button.classList.contains("rs-" + option.key)));
  });
  setMessage(msg, "");
  request("/admin/api/round-status", { id: booking.id, status: option ? option.value : "" })
    .then(function () {
      toast(option ? "Status saved: " + option.label : "Status cleared");
    })
    .catch(function (error) {
      buttons.forEach(function (button, index) {
        button.setAttribute("aria-pressed", before[index] || "false");
      });
      setMessage(msg, error.message, true);
    });
}
function showBooking(id: string, refresh?: boolean) {
  var booking = findBooking(id);
  if (!booking) {
    if (refresh) {
      closePanel();
    }
    return;
  }
  var start = new Date(booking.start);
  var end = new Date(booking.end);
  var now = Date.now();
  var interviewer = state.iv.assign[booking.id] || "";
  var upcoming = Date.parse(booking.start) > now;
  var status = roundStatus(booking);
  panel.refresh = function () {
    showBooking(id, true);
  };
  var body = openPanel(titleCase(booking.name), [booking.company, booking.round].filter(Boolean).join(" · ") || "No company given", refresh);
  setPanelAvatar(booking.name, interviewer);
  panel.bookingId = id;

  // When: a calendar tile, the day and time, how far away it is, and the status.
  var relative = booking.cancelled
    ? "Cancelled " + (booking.cancelledAt ? timeAgo(booking.cancelledAt) : "")
    : upcoming
      ? "Starts " + untilText(Date.parse(booking.start) - now)
      : Date.parse(booking.end) > now
        ? "Happening now"
        : "Ended " + timeAgo(booking.end);
  body.appendChild(
    el("div", { class: "bk-when" }, [
      el("div", { class: "bk-cal", "aria-hidden": "true" }, [
        el("span", { text: formatIst({ month: "short" }, start) }),
        el("b", { text: formatIst({ day: "numeric" }, start) }),
      ]),
      el("div", { class: "bk-wt" }, [
        el("b", { text: formatIst({ weekday: "long", month: "short", day: "numeric" }, start) }),
        el("span", { text: formatTime(start) + " – " + formatTime(end) }),
        el("small", { text: booking.duration + " min · " + relative }),
      ]),
      // the round's status shows in its card below, not twice
      status ? null : el("span", statusPill(booking)),
    ]),
  );

  if (!booking.cancelled && !upcoming) {
    body.appendChild(roundStatusCard(booking, status, !!interviewer));
  }

  // Details
  var details = el("div", { class: "bk-card bk-rows" });
  function row(name: string, label: string, value: Node | string | undefined) {
    if (value) {
      details.appendChild(
        el("div", { class: "bk-row" }, [
          icon(name),
          el("div", null, [el("small", { text: label }), el("span", null, [value])]),
        ]),
      );
    }
  }
  row("mail", "Email", booking.email ? el("a", { href: "mailto:" + booking.email, text: booking.email }) : "");
  row(
    "clock",
    "Booked",
    formatIst({ month: "short", day: "numeric", year: "numeric" }, new Date(booking.createdAt)) +
      (booking.source === "admin" ? " by you" : booking.source === "calendly" ? " in Calendly" : " by the candidate"),
  );
  if (booking.rescheduledAt) {
    row(
      "moved",
      "Moved",
      (booking.prevStart ? "From " + shortDate(booking.prevStart) + ", " + formatTime(new Date(booking.prevStart)) + " " : "") +
        byWhom(booking.rescheduledBy),
    );
  }
  if (booking.cancelled) {
    row("x", "Cancelled", (booking.cancelledAt ? shortDate(booking.cancelledAt) + " " : "") + byWhom(booking.cancelledBy));
    row("note", "Reason", booking.cancelReason);
  }
  body.appendChild(details);

  // Interview support (not for an interview marked as a no-show or didn't happen: its status card says so)
  if (!booking.cancelled && !booking.missed) {
    var box = el("div", { class: "bk-card" }, [el("h3", { text: "Interview support given by" })]);
    if (upcoming) {
      box.appendChild(el("p", { class: "sub", text: "You can record who gave interview support once it starts at " + formatTime(start) + "." }));
    } else {
      var choices = el("div", { class: "ivc" });
      var msg = el("p", { class: "msg", role: "status" });
      var names = interviewer ? [interviewer] : state.iv.names.slice();
      names.forEach(function (name) {
        choices.appendChild(
          el(
            "button",
            {
              type: "button",
              class: colorClass(name),
              "aria-pressed": String(interviewer === name),
              disabled: !!interviewer,
              onclick: function () {
                if (
                  !interviewer &&
                  confirm("Record " + name + " as the interview supporter for " + titleCase(booking.name) + "? This can't be changed later.")
                ) {
                  saveInterviewer(booking, name, msg);
                }
              },
            },
            [el("i", { class: "ivd", text: initials(name) }), el("span", { text: name })],
          ),
        );
      });
      box.appendChild(choices);
      if (interviewer) {
        box.appendChild(el("p", { class: "lockd", text: "Locked. This can't be changed once recorded." }));
      } else {
        box.appendChild(el("p", { class: "sub ivh", text: "Tap who gave interview support." }));
      }
      var clash = clashFor(booking, interviewer);
      if (clash) {
        box.appendChild(el("div", { class: "warn", text: interviewer + " also has " + clash + " at the same time." }));
      }
      box.appendChild(msg);
    }
    body.appendChild(box);
  }

  // The candidate's other interviews (same email) with this company: its other rounds and any repeat bookings, newest
  // first. Spellings that differ slightly ("Randstand", "Randstandi") count as the same company.
  var seen: Record<string, boolean> = {};
  var sameEmail = function (other: Booking) {
    return !!booking.email && other.email.toLowerCase() === booking.email.toLowerCase();
  };
  var sameFirm = function (other: Booking) {
    var mine = (booking.company || "").trim().toLowerCase();
    var theirs = (other.company || "").trim().toLowerCase();
    return !!mine && (mine === theirs || sameCompany(mine, theirs));
  };
  var sameSpelling = function (other: Booking) {
    return (other.company || "").trim().toLowerCase() === (booking.company || "").trim().toLowerCase();
  };
  var others = (state.events || [])
    .concat(allBookings || [])
    .filter(function (other) {
      var keep = other.id !== booking.id && !seen[other.id] && sameEmail(other) && sameFirm(other);
      seen[other.id] = true;
      return keep;
    })
    .sort(function (first, second) {
      return Date.parse(second.start) - Date.parse(first.start);
    });
  if (others.length) {
    var history = el("div", { class: "bk-card bk-hist" }, [el("h3", { text: "Other interviews at " + (booking.company || "").trim() })]);
    others.slice(0, 10).forEach(function (other) {
      history.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "bk-h",
            onclick: function () {
              showBooking(other.id);
            },
          },
          [
            el("span", { class: "bk-hd" }, [
              el("span", { text: formatIst({ month: "short", day: "numeric" }, new Date(other.start)) }),
              el("small", { text: formatTime(new Date(other.start)) }),
            ]),
            // the company is in the title; show it here only when spelled differently
            el("span", {
              class: "bk-hm",
              text:
                [sameSpelling(other) ? "" : other.company, other.round]
                  .filter(Boolean)
                  .join(" · ") || "Interview",
            }),
            el("span", statusPill(other, true)),
          ],
        ),
      );
    });
    body.appendChild(history);
  }
  if (!allBookings && booking.email) {
    loadAllBookings()
      .then(function () {
        if (panel.bookingId === id && !byId("panel").hidden) {
          showBooking(id, true);
        }
      })
      .catch(function () {});
  }

  if (!booking.cancelled && upcoming) {
    body.appendChild(
      el("div", { class: "bk-foot" }, [
        el("button", {
          type: "button",
          class: "ghost",
          text: "Reschedule",
          onclick: function () {
            showReschedule(booking);
          },
        }),
        el("button", {
          type: "button",
          class: "ghost danger-t",
          text: "Cancel booking",
          onclick: function () {
            showCancel(booking);
          },
        }),
      ]),
    );
  }
}
function showCancel(booking: Booking) {
  panel.refresh = null;
  var body = openPanel("Cancel booking", titleCase(booking.name) + " · " + formatRange(booking), true);
  var reason = el("textarea", {
    id: "creason",
    maxlength: "500",
    rows: "3",
  });
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  body.appendChild(
    el(
      "div",
      {
        class: "f",
      },
      [
        el("label", {
          for: "creason",
          text: state.email ? "Reason (optional, included in the candidate's email)" : "Reason (optional, for your records)",
        }),
        reason,
      ],
    ),
  );
  body.appendChild(
    el("p", {
      class: "sub",
      text: state.email
        ? "The candidate gets a cancellation email, and the time opens up again."
        : "The time opens up again. Emails are off, so let the candidate know yourself.",
    }),
  );
  var button = el("button", {
    type: "button",
    class: "danger",
    text: "Cancel booking",
    onclick: function () {
      button.disabled = true;
      button.textContent = "Cancelling…";
      request("/admin/api/cancel", {
        id: booking.id,
        reason: reason.value.trim(),
      })
        .then(function () {
          closePanel();
          toast("Booking cancelled");
        })
        .catch(function (error) {
          button.disabled = false;
          button.textContent = "Cancel booking";
          setMessage(msg, error.message, true);
        });
    },
  });
  body.appendChild(
    el(
      "div",
      {
        class: "row mt",
      },
      [
        button,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Keep booking",
          onclick: function () {
            showBooking(booking.id, true);
          },
        }),
      ],
    ),
  );
  body.appendChild(msg);
  reason.focus();
}
// Date, length and free-time fields. get() gives the chosen time, or null.
function timePicker(duration: number, day: string | null, ignoreId?: string) {
  var today = dayKeyOf(new Date());
  var durationSelect = el("select", {
    id: "cdur",
  });
  var dateInput = el("input", {
    type: "date",
    id: "cdate",
    min: today,
    max: addDays(today, 29),
  });
  var timeSelect = el("select", {
    id: "ctime",
  });
  [30, 60, 90].forEach(function (minutes) {
    durationSelect.appendChild(
      el("option", {
        value: String(minutes),
        text: minutes + " min",
      }),
    );
  });
  durationSelect.value = String(duration || 30);
  dateInput.value = day && day >= today ? day : today;
  function placeholder(text: string) {
    timeSelect.textContent = "";
    timeSelect.appendChild(
      el("option", {
        value: "",
        text: text,
      }),
    );
    timeSelect.disabled = true;
  }
  function loadTimes() {
    var day = dateInput.value;
    placeholder("Loading…");
    if (!day) {
      return placeholder("Pick a date");
    }
    request("/admin/api/slots?date=" + day + "&duration=" + durationSelect.value + (ignoreId ? "&ignore=" + ignoreId : ""))
      .then(function (result) {
        if (day === dateInput.value) {
          if (!result.slots.length) {
            return placeholder("No free times this day");
          }
          timeSelect.textContent = "";
          timeSelect.disabled = false;
          result.slots.forEach(function (startMs) {
            timeSelect.appendChild(
              el("option", {
                value: String(startMs),
                text: formatTime(new Date(startMs)),
              }),
            );
          });
        }
      })
      .catch(function () {
        placeholder("Couldn't load times");
      });
  }
  durationSelect.onchange = loadTimes;
  dateInput.onchange = loadTimes;
  loadTimes();
  return {
    el: el("div", null, [
      el(
        "div",
        {
          class: "two",
        },
        [
          el(
            "div",
            {
              class: "f",
            },
            [
              el("label", {
                for: "cdate",
                text: "Date",
              }),
              dateInput,
            ],
          ),
          el(
            "div",
            {
              class: "f",
            },
            [
              el("label", {
                for: "cdur",
                text: "Length",
              }),
              durationSelect,
            ],
          ),
        ],
      ),
      el(
        "div",
        {
          class: "f",
        },
        [
          el("label", {
            for: "ctime",
            text: "Time",
          }),
          timeSelect,
        ],
      ),
    ]),
    get: function () {
      if (timeSelect.value) {
        return {
          startMs: +timeSelect.value,
          duration: +durationSelect.value,
        };
      } else {
        return null;
      }
    },
  };
}
function goToTime(startMs: number) {
  var day = dayKeyOf(new Date(startMs));
  selectedDay = day;
  weekOf = weekStart(day);
  render();
}
function showReschedule(booking: Booking) {
  panel.refresh = null;
  var body = openPanel("Reschedule", titleCase(booking.name) + " · now " + formatRange(booking), true);
  var picker = timePicker(booking.duration, dayKeyOf(new Date(booking.start)), booking.id);
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  body.appendChild(picker.el);
  body.appendChild(
    el("p", {
      class: "sub",
      text: state.email
        ? "The candidate gets an updated calendar invite by email."
        : "Emails are off, so let the candidate know the new time yourself.",
    }),
  );
  var button = el("button", {
    type: "button",
    class: "pri",
    text: "Save new time",
    onclick: function () {
      var choice = picker.get();
      if (!choice) {
        return setMessage(msg, "Pick a time first.", true);
      }
      button.disabled = true;
      request("/admin/api/reschedule", {
        id: booking.id,
        startMs: choice.startMs,
        duration: choice.duration,
      })
        .then(function () {
          closePanel();
          toast("Booking moved");
          goToTime(choice.startMs);
        })
        .catch(function (error) {
          button.disabled = false;
          setMessage(msg, error.message, true);
        });
    },
  });
  body.appendChild(
    el(
      "div",
      {
        class: "row mt",
      },
      [
        button,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Back",
          onclick: function () {
            showBooking(booking.id, true);
          },
        }),
      ],
    ),
  );
  body.appendChild(msg);
  byId("cdate").focus();
}
setupEnquiries();
var searchBox = byId<HTMLInputElement>("q");
var searchList = byId("qdrop");
var matches: Booking[] = [];
var activeIndex = -1;
function loadAllBookings() {
  if (allBookings && Date.now() - allBookingsAt < 30000) {
    return Promise.resolve(allBookings);
  } else {
    return request("/admin/api/bookings").then(function (result) {
      allBookings = result.bookings;
      allBookingsAt = Date.now();
      return allBookings;
    });
  }
}
function closeSearch() {
  searchList.hidden = true;
  searchBox.setAttribute("aria-expanded", "false");
  searchBox.removeAttribute("aria-activedescendant");
  activeIndex = -1;
}
function highlight(index: number) {
  activeIndex = index;
  for (var i = 0; i < searchList.children.length; i++) {
    searchList.children[i].setAttribute("aria-selected", String(i === index));
  }
  if (index >= 0) {
    searchBox.setAttribute("aria-activedescendant", "qo" + index);
    searchList.children[index].scrollIntoView({
      block: "nearest",
    });
  }
}
function choose(index: number) {
  var booking = matches[index];
  if (booking) {
    closeSearch();
    showWeekOf(booking);
    showBooking(booking.id);
  }
}
searchBox.addEventListener("input", function () {
  var query = searchBox.value.trim().toLowerCase();
  if (query.length < 2) {
    return closeSearch();
  }
  loadAllBookings()
    .then(function (bookings) {
      if (searchBox.value.trim().toLowerCase() === query) {
        matches = bookings
          .filter(function (booking) {
            return (booking.name + " " + booking.email + " " + booking.company).toLowerCase().indexOf(query) >= 0;
          })
          .slice(0, 8);
        searchList.textContent = "";
        activeIndex = -1;
        if (!matches.length) {
          searchList.appendChild(
            el("li", {
              class: "m",
              text: "No matching candidates",
            }),
          );
        }
        matches.forEach(function (booking, index) {
          searchList.appendChild(
            el(
              "li",
              {
                id: "qo" + index,
                role: "option",
                "aria-selected": "false",
                onmousedown: function (event) {
                  event.preventDefault();
                },
                onclick: function () {
                  choose(index);
                },
              },
              [
                el("b", {
                  text: titleCase(booking.name),
                }),
                el("div", {
                  class: "m",
                  text: formatRange(booking) + " · " + statusOf(booking),
                }),
              ],
            ),
          );
        });
        searchList.hidden = false;
        searchBox.setAttribute("aria-expanded", "true");
      }
    })
    .catch(function () {});
});
searchBox.addEventListener("keydown", function (event) {
  if (!searchList.hidden) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(activeIndex < matches.length - 1 ? activeIndex + 1 : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(activeIndex > 0 ? activeIndex - 1 : matches.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeIndex < 0 ? 0 : activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    }
  }
});
searchBox.addEventListener("blur", closeSearch);
setupAllowlist();
function showTab(tab: string) {
  byId("viewCal").hidden = false;
  byId("tabCal").setAttribute("aria-selected", "true");
  history.replaceState(null, "", "/admin" + location.search);
  document.title = "Calendar · " + document.title.split(" · ").pop();
  if (tab === "allow") {
    showCandidates();
  }
}
byId("tabCal").onclick = function () {
  showTab("cal");
};
byId("mCand").onclick = showCandidates;
// Revenue on phones (owners only): the ⋯ menu opens it in the bottom sheet, like Candidates, rather than as a page.
// The desktop header tab still opens the page.
function showRevenueSheet() {
  // admins who aren't owners don't have Revenue
  if (byId("tabRev").hidden) {
    return;
  }
  panel.refresh = null;
  var body = openPanel("Revenue", "Confirmed payments over the last 12 months.");
  body.classList.add("rv");
  body.appendChild(byId("revBody").closest(".enqview"));
  showRevenue();
}
byId("mRev").onclick = showRevenueSheet;
function connect() {
  if (stream) {
    stream.close();
  }
  stream = new EventSource("/admin/stream");
  stream.onopen = function () {
    live = true;
    renderStatus();
  };
  stream.addEventListener("state", function (event) {
    try {
      setState(JSON.parse(event.data));
    } catch {
      return;
    }
    remember(event.data);
    checkForUpdate();
    live = true;
    allBookingsAt = 0;
    render();
    syncAllow();
  });
  stream.addEventListener("tick", function () {
    if (!live) {
      live = true;
      renderStatus();
    }
  });
  stream.onerror = function () {
    live = false;
    renderStatus();
    fetch("/admin/api/state")
      .then(function (response) {
        if (response.status === 401) {
          freshReload();
        }
      })
      .catch(function () {});
    if (stream.readyState === 2) {
      setTimeout(connect, 3000);
    }
  };
}
byId("prev").onclick = function () {
  weekOf = addDays(weekOf, -7);
  selectedDay = null;
  render();
};
byId("next").onclick = function () {
  weekOf = addDays(weekOf, 7);
  selectedDay = null;
  render();
};
// Swipe the agenda sideways to move a day, like paging in a calendar app: the day follows the finger, and a long drag or
// a quick flick moves to the next or previous day; anything less springs back. Swipes that start at the screen's left
// edge are left to the browser's own swipe back.
(function () {
  var box = byId("agenda");
  var startX = 0;
  var startY = 0;
  var dx = 0;
  var lock = 0; // 1 sideways (ours), -1 up and down (the page scrolls), 0 not decided yet
  var lastX = 0;
  var lastT = 0;
  var speed = 0; // px per ms
  function reset() {
    box.style.transition = "";
    box.style.transform = "";
    box.style.opacity = "";
  }
  box.addEventListener(
    "touchstart",
    function (event) {
      startX = lastX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      lastT = performance.now();
      dx = 0;
      speed = 0;
      lock = innerWidth > 760 || startX < 24 ? -1 : 0;
    },
    { passive: true },
  );
  box.addEventListener(
    "touchmove",
    function (event) {
      if (lock === -1) {
        return;
      }
      var x = event.touches[0].clientX;
      var mx = x - startX;
      var my = event.touches[0].clientY - startY;
      if (lock === 0) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) {
          return;
        }
        lock = Math.abs(mx) > Math.abs(my) * 1.3 ? 1 : -1;
        if (lock !== 1) {
          return;
        }
      }
      var now = performance.now();
      if (now > lastT) {
        speed = speed * 0.2 + ((x - lastX) / (now - lastT)) * 0.8;
      }
      lastX = x;
      lastT = now;
      dx = mx;
      box.style.transition = "none";
      box.style.transform = "translateX(" + dx + "px)";
      box.style.opacity = String(1 - Math.min(Math.abs(dx) / innerWidth, 0.6) * 0.6);
    },
    { passive: true },
  );
  function end() {
    if (lock !== 1) {
      lock = 0;
      return;
    }
    lock = 0;
    var flick = Math.abs(speed) > 0.45 && Math.abs(dx) > 24 && speed * dx > 0 && performance.now() - lastT < 120;
    if (Math.abs(dx) < 80 && !flick) {
      box.style.transition = "transform 0.24s var(--ease), opacity 0.24s ease";
      box.style.transform = "";
      box.style.opacity = "";
      return;
    }
    var next = dx < 0;
    box.style.transition = "transform 0.13s ease-in, opacity 0.13s ease-in";
    box.style.transform = "translateX(" + (next ? -1 : 1) * Math.round(innerWidth * 0.5) + "px)";
    box.style.opacity = "0";
    setTimeout(function () {
      reset();
      pickAgendaDay(addDays(agendaDay(), next ? 1 : -1));
      box.classList.remove("swipe-next", "swipe-prev");
      void box.offsetWidth;
      box.classList.add(next ? "swipe-next" : "swipe-prev");
    }, 130);
  }
  box.addEventListener("touchend", end);
  box.addEventListener("touchcancel", end);
})();
byId("today").onclick = function () {
  selectedDay = dayKeyOf(new Date());
  weekOf = weekStart(selectedDay);
  byId("week").textContent = "";
  render();
};
// On a phone, opening the Agenda brings the time now, or else the day's first interview, into view when it's further
// down. Desktops open it at the top like every other section, so switching tabs never moves the page.
byId("tabAg").addEventListener("click", function () {
  if (innerWidth > 760) {
    return;
  }
  // before the first frame, so the page doesn't show at the top and then jump
  requestAnimationFrame(function () {
    var mark = document.querySelector("#agenda .ag-now") || document.querySelector("#agenda .ag-i");
    if (mark && mark.getBoundingClientRect().top > innerHeight * 0.6) {
      scrollTo(0, scrollY + mark.getBoundingClientRect().top - innerHeight / 2);
    }
  });
});
// The week grid only scrolls to today when drawn fresh while visible, so redraw it when the phone's Calendar tab shows it.
document.querySelector(".bnav [data-go=cal]").addEventListener("click", function () {
  setTimeout(function () {
    byId("week").textContent = "";
    render();
  });
});
byId("pick").onchange = function () {
  if ((this as HTMLInputElement).value) {
    selectedDay = (this as HTMLInputElement).value;
    weekOf = weekStart(selectedDay);
    render();
  }
};
byId("mIv").onclick = showInterviewers;
byId("pclose").onclick = closePanel;
byId("pback").onclick = closePanel;
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !byId("panel").hidden) {
    closePanel();
  }
});
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") {
    request("/admin/api/state")
      .then(function (fresh) {
        setState(fresh);
        remember(JSON.stringify(fresh));
        render();
        checkForUpdate();
      })
      .catch(function () {});
    if (!stream || stream.readyState === 2 || !live) {
      connect();
    }
  }
});
window.__enq = showEnquiries;
window.__pay = showPayments;
window.__rev = showRevenue;
// leaving the tab brings the count back for anything new
new MutationObserver(renderEnquiryBadge).observe(byId("viewEnq"), { attributes: true, attributeFilter: ["hidden"] });
if (boot.login) {
  byId("mAdm").hidden = false;
  byId("mAdm").onclick = showAdmins;
  byId("mOut").hidden = false;
  byId("mOut").onclick = function () {
    forget();
    fetch("/admin/logout", {
      method: "POST",
    }).then(function () {
      location.href = "/admin";
    });
  };
}
setInterval(render, 60000);
addEventListener("online", renderStatus);
addEventListener("offline", renderStatus);
window.__openB = function (id) {
  loadAllBookings().then(function () {
    showBooking(id);
  });
};
// After a deploy the server restarts, and a phone that kept the app open reconnects to it with the old page still
// showing. When the live state reports a different build, reload: straight away if nothing is open, otherwise the next
// time the app comes back to the foreground or the sheet closes. Once per build, so a stale offline copy can't loop.
var updateWaiting = false;
function checkForUpdate() {
  if (!state.build || !boot.build || state.build === boot.build) {
    return;
  }
  try {
    if (sessionStorage.getItem("adm.reloaded") === state.build) {
      return;
    }
  } catch (e) {}
  updateWaiting = true;
  var busy = !byId("panel").hidden || document.body.classList.contains("pp-open") || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
  if (document.visibilityState === "hidden" || !busy) {
    try {
      sessionStorage.setItem("adm.reloaded", state.build);
    } catch (e) {}
    freshReload();
  }
}
document.addEventListener("visibilitychange", function () {
  if (updateWaiting && document.visibilityState === "visible") {
    checkForUpdate();
  }
});
new MutationObserver(function () {
  if (updateWaiting && byId("panel").hidden) {
    checkForUpdate();
  }
}).observe(byId("panel"), { attributes: true, attributeFilter: ["hidden"] });
showTab(boot.tab);
render();
connect();
// The service worker keeps the app openable offline; alerts.ts reuses the same registration for push.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(function () {});
}

setupAlerts();
setupNav();
setupStatsFrame();
setupDownloadMenu();
setupThemeSwitch();
