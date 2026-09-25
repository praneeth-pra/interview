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
// The connection state shows only when something is wrong: "Offline" at once, "Reconnecting…" after a few seconds.
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
    }, 4000);
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
    "Needs interviewer",
    String(unassigned.length),
    unassigned.length
      ? function () {
          showList("Needs interviewer", "Started interviews with no interviewer recorded", unassigned);
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
    unassigned.length + (unassigned.length === 1 ? " interview needs an interviewer" : " interviews need an interviewer");
  line.onclick = function () {
    showList("Needs interviewer", "Started interviews with no interviewer recorded", unassigned);
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
            interviewer ? "Interviewer: " + interviewer : started ? "No interviewer recorded" : "",
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
                  title: "Needs interviewer",
                  "aria-label": "Needs interviewer",
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
      toast(name ? "Interviewer saved" : "Interviewer cleared");
    })
    .catch(function (error) {
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
  var interviewer = state.iv.assign[booking.id] || "";
  var upcoming = Date.parse(booking.start) > Date.now();
  refreshPanel = function () {
    showBooking(id, true);
  };
  var body = openPanel(titleCase(booking.name), statusOf(booking) + " · " + formatRange(booking), refresh);
  var details = el("dl", {
    class: "dl",
  });
  function row(label: string, value: Node | string | undefined) {
    if (value) {
      details.appendChild(
        el("dt", {
          text: label,
        }),
      );
      details.appendChild(el("dd", null, [value]));
    }
  }
  row(
    "Email",
    booking.email
      ? el("a", {
          href: "mailto:" + booking.email,
          text: booking.email,
        })
      : "",
  );
  row("Company", booking.company);
  row("Round", booking.round);
  row("Length", booking.duration + " min");
  row(
    "Booked",
    formatIst(
      {
        month: "short",
        day: "numeric",
        year: "numeric",
      },
      new Date(booking.createdAt),
    ) + (booking.source === "admin" ? " by you" : booking.source === "calendly" ? " in Calendly" : " by the candidate"),
  );
  if (booking.rescheduledAt) {
    row(
      "Moved",
      (booking.prevStart ? "From " + shortDate(booking.prevStart) + ", " + formatTime(new Date(booking.prevStart)) + " " : "") +
        byWhom(booking.rescheduledBy),
    );
  }
  if (booking.cancelled) {
    row("Cancelled", (booking.cancelledAt ? shortDate(booking.cancelledAt) + " " : "") + byWhom(booking.cancelledBy));
    row("Reason", booking.cancelReason);
  }
  body.appendChild(details);
  if (!booking.cancelled) {
    var box = el(
      "div",
      {
        class: "box",
      },
      [
        el("h3", {
          text: "Interviewer",
        }),
      ],
    );
    if (upcoming) {
      box.appendChild(
        el("p", {
          class: "sub",
          text: "You can record who took it once it starts at " + formatTime(start) + ".",
        }),
      );
    } else {
      var pills = el("div", {
        class: "pills",
      });
      var msg = el("p", {
        class: "msg",
        role: "status",
      });
      var names = interviewer ? [interviewer] : state.iv.names.slice();
      names.forEach(function (name) {
        pills.appendChild(
          el("button", {
            type: "button",
            class: colorClass(name),
            "aria-pressed": String(interviewer === name),
            disabled: !!interviewer,
            text: name,
            onclick: function () {
              if (
                !interviewer &&
                confirm("Record " + name + " as the interviewer for " + titleCase(booking.name) + "? This can't be changed later.")
              ) {
                saveInterviewer(booking, name, msg);
              }
            },
          }),
        );
      });
      box.appendChild(pills);
      if (interviewer) {
        box.appendChild(
          el("p", {
            class: "lockd",
            text: "Locked. The interviewer can't be changed once recorded.",
          }),
        );
      }
      var clash = clashFor(booking, interviewer);
      if (clash) {
        box.appendChild(
          el("div", {
            class: "warn",
            text: interviewer + " also has " + clash + " at the same time.",
          }),
        );
      }
      box.appendChild(msg);
    }
    body.appendChild(box);
    if (upcoming) {
      body.appendChild(
        el(
          "div",
          {
            class: "row",
          },
          [
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
              class: "ghost",
              text: "Cancel booking",
              onclick: function () {
                showCancel(booking);
              },
            }),
          ],
        ),
      );
    }
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
  var body = openPanel("Interviewers", "Rename, add or remove. Renaming also updates interviews already recorded.");
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
        "aria-label": "Interviewer " + (index + 1) + " name",
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
              "aria-label": "Remove " + (entry.to || "interviewer"),
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
      text: "+ Add interviewer",
      onclick: function () {
        if (list.length >= 12) {
          return setMessage(msg, "You can have up to 12 interviewers.", true);
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
          toast("Interviewers saved");
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
      el("li", null, [
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
    if (!stream || stream.readyState === 2) {
      connect();
    }
  }
});
if (boot.login) {
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
