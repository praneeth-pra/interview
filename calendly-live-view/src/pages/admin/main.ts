// Admin calendar: week grid and agenda, booking panel, new booking/reschedule/cancel, candidate search,
// allowlist tab and the live connection to /admin/stream.
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
import { byWhom, plural, statusOf, titleCase } from "./labels";
import { request } from "./api";
import { sameCompany } from "../../same-company";
import { setupAlerts } from "./alerts";
import { setupDownloadMenu } from "./download-menu";
import { setupNav } from "./nav";
import { setupStatsFrame } from "./stats-frame";
import type { Allowlist, Booking, Change, State } from "./types";

(function () {
  var mark = document.querySelector(".mk");
  var brand = document.querySelector(".bn");
  if (mark && brand) {
    mark.textContent = (brand.textContent.trim().charAt(0) || "").toUpperCase();
  }
})();
var boot = JSON.parse(document.getElementById("boot").textContent);
var HOUR_PX = 64;
var state: State = {
  ready: false,
  events: [],
  changes: [],
  iv: {
    names: [],
    assign: {},
  },
  allow: {
    enabled: false,
    count: 0,
  },
  hours: {
    start: 540,
    end: 1260,
  },
  email: false,
};
// The last state seen is kept on this device so the app opens with the bookings already on screen, and still shows
// them offline. It is dropped on sign-out and whenever the sign-in page shows.
var STATE_KEY = "adm.state";
function remember(text: string) {
  try {
    localStorage.setItem(STATE_KEY, text);
  } catch (e) {}
}
function forget() {
  try {
    localStorage.removeItem(STATE_KEY);
  } catch (e) {}
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage("signed-out");
  }
}
try {
  var savedState = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
  if (savedState && savedState.ready && Array.isArray(savedState.events)) {
    state = savedState;
  }
} catch (e) {}
var selectedDay: string | null = null; // the day picked in the date box, or null

var weekOf: string | null = null; // Monday of the week on screen
var live = false; // connected to /admin/stream
var stream: EventSource | null = null;
var refreshPanel: (() => void) | null = null; // redraws the open panel when new data arrives
var returnFocus: HTMLElement | null = null; // focused before the panel opened
var allBookings: Booking[] | null = null; // every booking, for search; refetched after 30s
var allBookingsAt = 0;
var dateParam = new URLSearchParams(location.search).get("date");
if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) {
  selectedDay = dateParam;
}
function colorClass(name: string) {
  var index = state.iv.names.indexOf(name);
  if (index < 0) {
    index = 0;
    for (var pos = 0; pos < name.length; pos++) {
      index += name.charCodeAt(pos);
    }
  }
  return "c" + (index % 6);
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
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id];
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
    return Date.parse(booking.start) <= now && !state.iv.assign[booking.id];
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
  days.forEach(function (day, index) {
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
            (started && !interviewer ? " need" : "") +
            (boxHeight < 50 ? " short" : ""),
          title: [
            titleCase(booking.name),
            booking.company,
            booking.round,
            interviewer ? "Interview support: " + interviewer : started ? "Interview support not recorded" : "",
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
function renderChanges() {
  var list = byId("changes");
  if (!list) {
    return;
  }
  list.textContent = "";
  if (!state.changes.length) {
    list.appendChild(
      el("li", {
        class: "empty",
        text: "No cancellations or reschedules in the last 30 days.",
      }),
    );
    return;
  }
  state.changes.forEach(function (change) {
    var cancelled = change.kind === "cancelled";
    var who = byWhom(cancelled ? change.cancelledBy : change.rescheduledBy);
    var when = cancelled
      ? formatRange(change)
      : (change.prevStart ? shortDate(change.prevStart) + ", " + formatTime(new Date(change.prevStart)) + " → " : "") + formatRange(change);
    function open() {
      showBooking(change.id);
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
          el("span", {
            class: "tag " + (cancelled ? "x" : "r"),
            text: cancelled ? "Cancelled" : "Moved",
          }),
          el(
            "div",
            {
              class: "cmain",
            },
            [
              el("div", null, [
                el("b", {
                  text: titleCase(change.name),
                }),
                who ? " " + who : "",
              ]),
              el("div", {
                class: "m",
                text: when,
              }),
              cancelled && change.cancelReason
                ? el("div", {
                    class: "why",
                    text: change.cancelReason,
                  })
                : null,
            ],
          ),
          el("span", {
            class: "cwhen",
            text: timeAgo(change.at),
          }),
        ],
      ),
    );
  });
}
function renderAgenda() {
  var box = byId("agenda");
  if (!box) {
    return;
  }
  var today = dayKeyOf(new Date());
  var now = Date.now();
  box.textContent = "";
  for (var i = 0; i < 7; i++) {
    var day = addDays(weekOf, i);
    var items = dayItems(day);
    var isToday = day === today;
    box.appendChild(
      el(
        "div",
        {
          class: "ag-h" + (isToday ? " today" : ""),
        },
        [
          el("b", {
            text: isToday
              ? "Today"
              : formatDay(day, {
                  weekday: "long",
                }),
          }),
          el("span", {
            text: formatDay(day, {
              weekday: isToday ? "long" : undefined,
              month: "short",
              day: "numeric",
            }),
          }),
        ],
      ),
    );
    if (!items.length) {
      continue;
    }
    var list = el("div", {
      class: "ag-l",
    });
    items.forEach(function (item) {
      var booking = item.booking;
      var interviewer = state.iv.assign[booking.id];
      var isPast = Date.parse(booking.end) <= now;
      var started = Date.parse(booking.start) <= now;
      list.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "ag-i " + (interviewer ? colorClass(interviewer) : "cn") + (isPast ? " past" : ""),
            onclick: function () {
              showBooking(booking.id);
            },
          },
          [
            el(
              "span",
              {
                class: "ag-t",
              },
              [
                el("b", {
                  text: formatTime(new Date(booking.start)),
                }),
                el("span", {
                  text: formatTime(new Date(booking.end)),
                }),
              ],
            ),
            el(
              "span",
              {
                class: "ag-m",
              },
              [
                el("b", {
                  text: titleCase(booking.name),
                }),
                el("span", {
                  text: [booking.company, booking.round, interviewer].filter(Boolean).join(" · ") || "\xA0",
                }),
              ],
            ),
            !interviewer && started
              ? el("i", {
                  class: "need-dot",
                  title: "Support not recorded",
                  "aria-label": "Support not recorded",
                  role: "img",
                })
              : null,
          ],
        ),
      );
    });
    box.appendChild(list);
  }
  // On a phone, the first time the agenda shows today (and after "Today"), bring today's bookings into view.
  var todayHead = box.querySelector(".ag-h.today");
  if (!agendaScrolled && todayHead && box.offsetParent && matchMedia("(max-width:760px)").matches) {
    agendaScrolled = true;
    if (todayHead.getBoundingClientRect().top > innerHeight * 0.55) {
      todayHead.scrollIntoView({ block: "start" });
    }
  }
}
var agendaScrolled = false;
function render() {
  weekOf ||= weekStart(selectedDay || dayKeyOf(new Date()));
  renderStatus();
  if (state.ready) {
    byId("banner").hidden = true;
    renderCards();
    renderAttention();
    renderLegend();
    renderWeek();
    renderChanges();
    renderAgenda();
    if (refreshPanel && !byId("panel").hidden) {
      refreshPanel();
    }
  }
}
function openPanel(title: string, subtitle?: string, keepFocus?: boolean) {
  if (!keepFocus && byId("panel").hidden) {
    returnFocus = document.activeElement as HTMLElement;
  }
  byId("ptitle").textContent = title;
  byId("psub").textContent = subtitle || "";
  setPanelAvatar(null);
  sheetBookingId = "";
  var body = byId("pbody");
  body.textContent = "";
  byId("panel").hidden = false;
  byId("pback").hidden = false;
  if (!keepFocus) {
    byId("pclose").focus();
  }
  return body;
}
function closePanel() {
  byId("panel").hidden = true;
  byId("pback").hidden = true;
  refreshPanel = null;
  if (returnFocus && document.contains(returnFocus)) {
    returnFocus.focus();
  }
  returnFocus = null;
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
  refreshPanel = null;
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
// Small line icons for the booking sheet (24×24, stroked with the text colour).
var ICON: Record<string, string> = {
  mail: "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  chart: "M5 20v-7M12 20V5M19 20v-10M3 20h18",
  person: "M12 11.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2zM5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6",
  cal: "M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4",
  clock: "M12 7v5l3 2M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z",
  moved: "M4 12h13M13 7l5 5-5 5",
  x: "M6 6l12 12M18 6 6 18",
  note: "M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4",
};
function icon(name: string) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON[name]);
  svg.appendChild(path);
  return svg;
}
function initials(name: string) {
  var words = titleCase(name).trim().split(/\s+/).filter(Boolean);
  return ((words[0] || "?").charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : "")).toUpperCase();
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
// The avatar in the sheet header: the candidate's initials, in the interviewer's colour once recorded.
function setPanelAvatar(name: string | null, interviewer?: string) {
  var avatar = document.getElementById("pav");
  if (!avatar) {
    var head = document.querySelector(".phead");
    avatar = el("span", { id: "pav", class: "pav", "aria-hidden": "true" });
    head.insertBefore(avatar, head.firstChild);
  }
  avatar.hidden = !name;
  avatar.textContent = name ? initials(name) : "";
  avatar.className = "pav " + (interviewer ? colorClass(interviewer) : "cn");
}
var sheetBookingId = "";
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
  var status = statusOf(booking);
  refreshPanel = function () {
    showBooking(id, true);
  };
  var body = openPanel(titleCase(booking.name), [booking.company, booking.round].filter(Boolean).join(" · ") || "No company given", refresh);
  setPanelAvatar(booking.name, interviewer);
  sheetBookingId = id;

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
      el("span", { class: "bk-st st-" + status.toLowerCase().replace(/\s+/g, ""), text: status }),
    ]),
  );

  // Quick actions: email, copy the email, open the candidate in Contacts.
  var actions = el("div", { class: "bk-acts" });
  if (booking.email) {
    actions.appendChild(el("a", { class: "bk-act", href: "mailto:" + booking.email }, [icon("mail"), "Email"]));
    actions.appendChild(
      el(
        "button",
        {
          type: "button",
          class: "bk-act",
          onclick: function () {
            var done = function () {
              toast("Email copied");
            };
            if (navigator.clipboard) {
              navigator.clipboard.writeText(booking.email).then(done, function () {
                toast(booking.email);
              });
            } else {
              toast(booking.email);
            }
          },
        },
        [icon("copy"), "Copy email"],
      ),
    );
  }
  actions.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "bk-act",
        onclick: function () {
          closePanel();
          window.__statsEvent = booking.id;
          byId("tabStats").click();
        },
      },
      [icon("person"), "Contact"],
    ),
  );
  body.appendChild(actions);

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

  // Interviewer
  if (!booking.cancelled) {
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
      var otherStatus = statusOf(other);
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
            el("span", { class: "bk-st sm st-" + otherStatus.toLowerCase().replace(/\s+/g, ""), text: otherStatus }),
          ],
        ),
      );
    });
    body.appendChild(history);
  }
  if (!allBookings && booking.email) {
    loadAllBookings()
      .then(function () {
        if (sheetBookingId === id && !byId("panel").hidden) {
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
  refreshPanel = null;
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
  refreshPanel = null;
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
function showNewBooking() {
  refreshPanel = null;
  var body = openPanel("New booking", "Book a time for a candidate. The allowlist doesn't apply here.");
  var inputs: Record<string, HTMLInputElement> = {};
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  [
    ["name", "Name *", "text"],
    ["email", "Email *", "email"],
    ["company", "Company", "text"],
    ["round", "Interview round", "text"],
  ].forEach(function (field) {
    var input = el("input", {
      id: "n" + field[0],
      type: field[2],
      autocomplete: "off",
      maxlength: field[0] === "email" ? "200" : "120",
    });
    inputs[field[0]] = input;
    body.appendChild(
      el(
        "div",
        {
          class: "f",
        },
        [
          el("label", {
            for: "n" + field[0],
            text: field[1],
          }),
          input,
        ],
      ),
    );
  });
  var picker = timePicker(30, selectedDay);
  body.appendChild(picker.el);
  body.appendChild(
    el("p", {
      class: "sub",
      text: state.email
        ? "The candidate gets the usual confirmation email with reschedule and cancel links."
        : "Emails are off, so send the candidate the details yourself.",
    }),
  );
  var button = el("button", {
    type: "button",
    class: "pri",
    text: "Book",
    onclick: function () {
      var choice = picker.get();
      var name = inputs.name.value.trim();
      var email = inputs.email.value.trim();
      if (!name) {
        inputs.name.focus();
        return setMessage(msg, "Enter the candidate's name.", true);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        inputs.email.focus();
        return setMessage(msg, "Enter a valid email address.", true);
      }
      if (!choice) {
        return setMessage(msg, "Pick a time.", true);
      }
      button.disabled = true;
      request("/admin/api/book", {
        name: name,
        email: email,
        company: inputs.company.value.trim(),
        round: inputs.round.value.trim(),
        startMs: choice.startMs,
        duration: choice.duration,
      })
        .then(function () {
          closePanel();
          toast("Booked");
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
          text: "Cancel",
          onclick: closePanel,
        }),
      ],
    ),
  );
  body.appendChild(msg);
  inputs.name.focus();
}
function showInterviewers() {
  refreshPanel = null;
  var body = openPanel("Interview supporters", "Rename, add or remove. Renaming also updates interviews already recorded.");
  var rows = el("div");
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  var list = state.iv.names.map(function (name) {
    return {
      from: name,
      to: name,
    };
  });
  function renderRows() {
    rows.textContent = "";
    list.forEach(function (entry, index) {
      var input = el("input", {
        type: "text",
        maxlength: "30",
        "aria-label": "Interview supporter " + (index + 1) + " name",
      });
      input.value = entry.to;
      input.oninput = function () {
        entry.to = input.value;
      };
      rows.appendChild(
        el(
          "div",
          {
            class: "ivrow",
          },
          [
            el("span", {
              class: "lg " + (entry.from ? colorClass(entry.from) : "cn"),
            }),
            input,
            el("button", {
              type: "button",
              class: "rm",
              text: "Remove",
              "aria-label": "Remove " + (entry.to || "interview supporter"),
              onclick: function () {
                list.splice(index, 1);
                renderRows();
              },
            }),
          ],
        ),
      );
    });
  }
  renderRows();
  body.appendChild(rows);
  body.appendChild(
    el("button", {
      type: "button",
      class: "linkbtn",
      text: "+ Add interview supporter",
      onclick: function () {
        if (list.length >= 12) {
          return setMessage(msg, "You can have up to 12 interview supporters.", true);
        }
        list.push({
          from: "",
          to: "",
        });
        renderRows();
        (rows.lastChild as HTMLElement).querySelector("input").focus();
      },
    }),
  );
  var saveButton = el("button", {
    type: "button",
    class: "pri",
    text: "Save",
    onclick: function () {
      saveButton.disabled = true;
      request("/admin/api/interviewer-names", {
        list: list,
      })
        .then(function () {
          closePanel();
          toast("Interview supporters saved");
        })
        .catch(function (error) {
          saveButton.disabled = false;
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
        saveButton,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Cancel",
          onclick: closePanel,
        }),
      ],
    ),
  );
  body.appendChild(msg);
}
// Who can sign in. Owners come from the server's ADMIN_EMAILS and can't be removed here; everyone else can be added or
// removed, and removing someone signs them out on all their devices.
function showAdmins() {
  refreshPanel = null;
  var body = openPanel("Admins", "People on this list sign in with a code sent to their email.");
  var msg = el("p", {
    class: "msg",
    role: "status",
  });
  var me = el("p", { class: "sub", text: "Loading…" });
  var rows = el("div", { class: "admlist" });
  var input = el("input", {
    type: "email",
    inputmode: "email",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "name@example.com",
    "aria-label": "Email of the admin to add",
  }) as HTMLInputElement;
  var addButton = el("button", { type: "button", class: "pri", text: "Add" }) as HTMLButtonElement;
  var view = { owners: [] as string[], emails: [] as string[], me: "" };
  function save(emails: string[], done: string) {
    addButton.disabled = true;
    return request("/admin/api/admins", { emails: emails })
      .then(function (result) {
        view = result;
        draw();
        toast(done);
        return true;
      })
      .catch(function (error) {
        setMessage(msg, error.message, true);
        return false;
      })
      .then(function (ok) {
        addButton.disabled = false;
        return ok;
      });
  }
  function draw() {
    me.textContent = view.me ? "You're signed in as " + view.me + "." : "";
    rows.textContent = "";
    view.owners.forEach(function (email) {
      rows.appendChild(el("div", { class: "admrow" }, [el("span", { class: "admail", text: email }), el("span", { class: "tag r", text: "Owner" })]));
    });
    view.emails.forEach(function (email) {
      rows.appendChild(
        el("div", { class: "admrow" }, [
          el("span", { class: "admail", text: email }),
          el("button", {
            type: "button",
            class: "rm",
            text: "Remove",
            "aria-label": "Remove " + email,
            onclick: function () {
              if (confirm("Remove " + email + "? They'll be signed out on every device.")) {
                save(
                  view.emails.filter(function (other) {
                    return other !== email;
                  }),
                  "Admin removed",
                );
              }
            },
          }),
        ]),
      );
    });
  }
  function add() {
    var email = input.value.trim().toLowerCase();
    setMessage(msg, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMessage(msg, "Enter a valid email address.", true);
      input.focus();
      return;
    }
    if (view.owners.indexOf(email) >= 0 || view.emails.indexOf(email) >= 0) {
      setMessage(msg, email + " is already an admin.", true);
      return;
    }
    save(view.emails.concat([email]), "Admin added").then(function (ok) {
      if (ok) {
        input.value = "";
        setMessage(msg, email + " can now sign in with a code sent to that email.");
      }
    });
  }
  addButton.onclick = add;
  input.addEventListener("keydown", function (event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  body.appendChild(me);
  body.appendChild(rows);
  body.appendChild(el("div", { class: "admadd" }, [input, addButton]));
  body.appendChild(msg);
  request("/admin/api/admins")
    .then(function (result) {
      view = result;
      draw();
    })
    .catch(function (error) {
      me.textContent = "";
      setMessage(msg, error.message, true);
    });
}
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
var allow: Allowlist = {
  enabled: false,
  emails: [],
};
var allowLoaded = false;
function updateAllow(change: Record<string, unknown>) {
  return request("/admin/api/allowlist", change).then(function (result) {
    allow = result.state;
    allowLoaded = true;
    renderAllow();
    return result;
  });
}
function renderAllow() {
  var toggle = byId<HTMLButtonElement>("sw");
  toggle.disabled = false;
  toggle.setAttribute("aria-checked", String(allow.enabled));
  byId("swd").textContent = allow.enabled
    ? "On. Only the " + plural(allow.emails.length, "email") + " below can book."
    : "Off. Anyone with the booking link can book.";
  byId("cnt").textContent = plural(allow.emails.length, "email");
  var query = byId<HTMLInputElement>("aq").value.trim().toLowerCase();
  var list = byId("alist");
  list.textContent = "";
  var shown = allow.emails.filter(function (email) {
    return !query || email.indexOf(query) >= 0;
  });
  if (!shown.length) {
    list.appendChild(
      el("li", {
        class: "empty",
        text: allow.emails.length ? "No emails match your search." : "No emails yet. Add your candidates above.",
      }),
    );
  }
  shown.forEach(function (email) {
    var button = el("button", {
      type: "button",
      class: "rm",
      text: "Remove",
      "aria-label": "Remove " + email,
      onclick: function () {
        button.disabled = true;
        updateAllow({
          action: "remove",
          email: email,
        })
          .then(function () {
            setMessage(byId("addm"), "Removed " + email + ".");
          })
          .catch(function (error) {
            button.disabled = false;
            setMessage(byId("addm"), error.message, true);
          });
      },
    });
    list.appendChild(
      el("li", { "data-i": email.charAt(0).toUpperCase() }, [
        el("span", {
          text: email,
        }),
        button,
      ]),
    );
  });
}
byId("sw").onclick = function () {
  var button = this as HTMLButtonElement;
  button.disabled = true;
  setMessage(byId("swm"), "");
  updateAllow({
    action: "enable",
    on: !allow.enabled,
  })
    .then(function () {
      setMessage(byId("swm"), allow.enabled ? "Turned on. Only listed emails can book now." : "Turned off. Anyone with the link can book.");
    })
    .catch(function (error) {
      button.disabled = false;
      setMessage(byId("swm"), error.message, true);
    });
};
byId("addb").onclick = function () {
  var button = this as HTMLButtonElement;
  var text = byId<HTMLTextAreaElement>("add").value;
  if (!text.trim()) {
    byId("add").focus();
    return setMessage(byId("addm"), "Paste at least one email first.", true);
  }
  button.disabled = true;
  updateAllow({
    action: "add",
    text: text,
  })
    .then(function (result) {
      button.disabled = false;
      var parts = ["Added " + plural(result.added, "email") + "."];
      if (result.existing) {
        parts.push(result.existing + " already on the list.");
      }
      if (result.invalid.length) {
        parts.push("Left in the box because they aren't valid emails: " + result.invalid.join(", ") + ".");
      }
      byId<HTMLTextAreaElement>("add").value = result.invalid.join(`
`);
      setMessage(byId("addm"), parts.join(" "), !result.added && result.invalid.length > 0);
    })
    .catch(function (error) {
      button.disabled = false;
      setMessage(byId("addm"), error.message, true);
    });
};
byId("impb").onclick = function () {
  var button = this as HTMLButtonElement;
  button.disabled = true;
  updateAllow({
    action: "importBooked",
  })
    .then(function (result) {
      button.disabled = false;
      setMessage(
        byId("addm"),
        result.added
          ? "Added " + plural(result.added, "email") + " from past bookings."
          : "Everyone who has booked is already on the list.",
      );
    })
    .catch(function (error) {
      button.disabled = false;
      setMessage(byId("addm"), error.message, true);
    });
};
byId("aq").oninput = renderAllow;
function showTab(tab: string) {
  var isAllow = tab === "allow";
  byId("viewCal").hidden = isAllow;
  byId("viewAllow").hidden = !isAllow;
  byId("tabCal").setAttribute("aria-selected", String(!isAllow));
  byId("tabAllow").setAttribute("aria-selected", String(isAllow));
  history.replaceState(null, "", isAllow ? "/admin/allowlist" : "/admin" + location.search);
  document.title = (isAllow ? "Allowed emails" : "Calendar") + " · " + document.title.split(" · ").pop();
  if (isAllow) {
    request("/admin/api/allowlist")
      .then(function (result) {
        allow = result.state;
        renderAllow();
      })
      .catch(function (error) {
        setMessage(byId("swm"), error.message, true);
      });
  }
}
byId("tabCal").onclick = function () {
  showTab("cal");
};
byId("tabAllow").onclick = function () {
  showTab("allow");
};
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
      state = JSON.parse(event.data);
    } catch {
      return;
    }
    remember(event.data);
    checkForUpdate();
    live = true;
    allBookingsAt = 0;
    render();
    if (allowLoaded && !byId("viewAllow").hidden && (state.allow.count !== allow.emails.length || state.allow.enabled !== allow.enabled)) {
      request("/admin/api/allowlist")
        .then(function (result) {
          allow = result.state;
          renderAllow();
        })
        .catch(function () {});
    }
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
          location.reload();
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
// Swipe the agenda sideways to move a week, like paging in a calendar app.
(function () {
  var box = byId("agenda");
  var startX = 0;
  var startY = 0;
  box.addEventListener(
    "touchstart",
    function (event) {
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
    },
    { passive: true },
  );
  box.addEventListener("touchend", function (event) {
    var dx = event.changedTouches[0].clientX - startX;
    var dy = event.changedTouches[0].clientY - startY;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) {
      return;
    }
    byId(dx < 0 ? "next" : "prev").click();
    box.classList.remove("swipe-next", "swipe-prev");
    void box.offsetWidth;
    box.classList.add(dx < 0 ? "swipe-next" : "swipe-prev");
  });
})();
byId("today").onclick = function () {
  agendaScrolled = false;
  selectedDay = dayKeyOf(new Date());
  weekOf = weekStart(selectedDay);
  byId("week").textContent = "";
  render();
};
byId("pick").onchange = function () {
  if ((this as HTMLInputElement).value) {
    selectedDay = (this as HTMLInputElement).value;
    weekOf = weekStart(selectedDay);
    render();
  }
};
byId("mNew").onclick = showNewBooking;
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
        state = fresh;
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
    location.reload();
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
