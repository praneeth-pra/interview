// The agenda: one day at a time with a week strip, and sideways swipes between days on phones.
import { byId, el } from "./dom";
import { addDays, dayKeyOf, formatDay, formatTime, hourLabel, minutesOfDay, weekStart } from "./time";
import { statusPill, titleCase } from "./labels";
import { colorClass, render, state, view } from "./state";
import { showBooking } from "./booking-panel";
import { blockBand, dayBlocks, dayItems } from "./week";
import { layoutColumns } from "./layout";

// The agenda: one day at a time, like a phone calendar's Day view. A week strip picks the day (the day on screen circled
// in orange, dots for days with interviews), then an hour grid holds that day's interviews as blocks sized to their
// length, tinted in the interview supporter's colour (grey when none), with a line at the current time today.
const AGENDA_HOUR_PX = 80;
export function agendaDay() {
  const today = dayKeyOf(new Date());
  if (view.day && weekStart(view.day) === view.week) {
    return view.day;
  }
  if (weekStart(today) === view.week) {
    return today;
  }
  for (let i = 0; i < 7; i++) {
    if (dayItems(addDays(view.week!, i)).length) {
      return addDays(view.week!, i);
    }
  }
  return view.week;
}
export function pickAgendaDay(day: string) {
  view.day = day;
  view.week = weekStart(day);
  render();
}
export function renderAgenda() {
  const box = byId("agenda");
  if (!box) {
    return;
  }
  const today = dayKeyOf(new Date());
  const now = Date.now();
  const shown = agendaDay();
  box.textContent = "";
  const strip = el("div", {
    class: "ws",
    role: "group",
    "aria-label": "Days",
  });
  for (let i = 0; i < 7; i++) {
    const day = addDays(view.week!, i);
    const count = dayItems(day).length;
    const dots = el("span", {
      class: "ws-d",
      "aria-hidden": "true",
    });
    // a dot per interview in its supporter's colour, up to three, then "+N"
    dayItems(day).forEach(function (item, index) {
      const interviewer = state.iv.assign[item.booking.id];
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
        [
          el("span", { class: "ws-w", text: formatDay(day, { weekday: "short" }) }),
          el("b", { text: formatDay(day, { day: "numeric" }) }),
          dots,
        ],
      ),
    );
  }
  box.appendChild(strip);
  const items = dayItems(shown!);
  layoutColumns(items);
  box.appendChild(
    el("div", { class: "ag-h" + (shown === today ? " today" : "") }, [
      el("b", { text: formatDay(shown!, { weekday: "long" }) + "," }),
      el("span", { text: formatDay(shown!, { day: "numeric", month: "short" }) }),
      el("em", {
        text: items.length
          ? items.length + (items.length === 1 ? " interview" : " interviews")
          : dayBlocks(shown!, 0, 1440).length
            ? "Time off"
            : "No interviews",
      }),
    ]),
  );
  // the hours shown: working hours, stretched to fit the day's interviews and, today, the time now
  const nowMin = minutesOfDay(new Date());
  let fromMin = state.hours.start;
  let toMin = state.hours.end;
  items.forEach(function (item) {
    fromMin = Math.min(fromMin, item.from);
    toMin = Math.max(toMin, item.to);
  });
  if (shown === today && nowMin >= 7 * 60) {
    fromMin = Math.min(fromMin, nowMin);
    toMin = Math.max(toMin, nowMin + 30);
  }
  const firstHour = Math.floor(fromMin / 60);
  const lastHour = Math.min(24, Math.ceil(toMin / 60));
  const grid = el("div", { class: "ag-grid" });
  grid.style.height = (lastHour - firstHour) * AGENDA_HOUR_PX + "px";
  for (let hour = firstHour; hour <= lastHour; hour++) {
    const line = el("div", { class: "ag-hr" }, [el("span", { text: hour === 12 ? "Noon" : hourLabel(hour) })]);
    line.style.top = (hour - firstHour) * AGENDA_HOUR_PX + "px";
    grid.appendChild(line);
  }
  const lane = el("div", { class: "ag-lane" });
  dayBlocks(shown!, firstHour * 60, lastHour * 60).forEach(function (band) {
    lane.appendChild(blockBand(band, firstHour * 60, AGENDA_HOUR_PX, "blk ag-blk"));
  });
  items.forEach(function (item) {
    const booking = item.booking;
    const interviewer = state.iv.assign[booking.id];
    const isPast = Date.parse(booking.end) <= now;
    const needsSupport = !interviewer && Date.parse(booking.start) <= now && !booking.missed;
    const cols = item.group!.cols.length;
    const height = Math.max(26, ((item.to - item.from) / 60) * AGENDA_HOUR_PX - 2);
    const block = el(
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
    block.style.left = "calc(" + (item.col! * 100) / cols + "% + 2px)";
    block.style.width = "calc(" + 100 / cols + "% - 4px)";
    lane.appendChild(block);
  });
  grid.appendChild(lane);
  if (shown === today && nowMin >= firstHour * 60 && nowMin <= lastHour * 60) {
    const nowLine = el("div", { class: "ag-now" }, [el("span", { text: formatTime(now) })]);
    nowLine.style.top = ((nowMin - firstHour * 60) / 60) * AGENDA_HOUR_PX + "px";
    grid.appendChild(nowLine);
  }
  box.appendChild(grid);
}
// Swipe the agenda sideways to move a day, like paging in a calendar app: the day follows the finger, and a long drag or
// a quick flick moves to the next or previous day; anything less springs back. Swipes that start at the screen's left
// edge are left to the browser's own swipe back.
export function setupAgendaSwipe() {
  const box = byId("agenda");
  // Only the day moves with the finger (its heading and hour grid); the week strip stays put and its orange highlight
  // moves to the new day. Looked up each time: every redraw of the agenda replaces them.
  function day() {
    return Array.from(box.querySelectorAll<HTMLElement>(".ag-h, .ag-grid"));
  }
  function style(transition: string, transform: string, opacity: string) {
    day().forEach(function (part) {
      part.style.transition = transition;
      part.style.transform = transform;
      part.style.opacity = opacity;
    });
  }
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let lock = 0; // 1 sideways (ours), -1 up and down (the page scrolls), 0 not decided yet
  let lastX = 0;
  let lastT = 0;
  let speed = 0; // px per ms
  function reset() {
    style("", "", "");
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
      // The end of the touch is heard on the element it started on: if a redraw removes that element mid-swipe, the
      // event no longer reaches the agenda, and the day would be left half moved.
      event.target!.addEventListener("touchend", end, { once: true });
      event.target!.addEventListener("touchcancel", end, { once: true });
    },
    { passive: true },
  );
  box.addEventListener(
    "touchmove",
    function (event) {
      if (lock === -1) {
        return;
      }
      const x = event.touches[0].clientX;
      const mx = x - startX;
      const my = event.touches[0].clientY - startY;
      if (lock === 0) {
        if (Math.abs(mx) < 10 && Math.abs(my) < 10) {
          return;
        }
        lock = Math.abs(mx) > Math.abs(my) * 1.3 ? 1 : -1;
        if (lock !== 1) {
          return;
        }
      }
      const now = performance.now();
      if (now > lastT) {
        speed = speed * 0.2 + ((x - lastX) / (now - lastT)) * 0.8;
      }
      lastX = x;
      lastT = now;
      dx = mx;
      style("none", "translateX(" + dx + "px)", String(1 - Math.min(Math.abs(dx) / innerWidth, 0.6) * 0.6));
    },
    { passive: true },
  );
  function end() {
    if (lock !== 1) {
      lock = 0;
      return;
    }
    lock = 0;
    const flick = Math.abs(speed) > 0.45 && Math.abs(dx) > 24 && speed * dx > 0 && performance.now() - lastT < 120;
    if (Math.abs(dx) < 80 && !flick) {
      style("transform 0.24s var(--ease), opacity 0.24s ease", "", "");
      return;
    }
    const next = dx < 0;
    style("transform 0.13s ease-in, opacity 0.13s ease-in", "translateX(" + (next ? -1 : 1) * Math.round(innerWidth * 0.5) + "px)", "0");
    setTimeout(function () {
      reset();
      pickAgendaDay(addDays(agendaDay()!, next ? 1 : -1));
      box.classList.remove("swipe-next", "swipe-prev");
      void box.offsetWidth;
      box.classList.add(next ? "swipe-next" : "swipe-prev");
    }, 130);
  }
}
