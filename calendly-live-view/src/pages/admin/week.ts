// The week grid: seven days of hour rows, each booking a block sized to its length, overlaps side by side.
import { byId, el } from "./dom";
import { addDays, blockSpan, dayKeyOf, formatDay, hourLabel, minutesOfDay } from "./time";
import { missedLabel, statusPill, titleCase } from "./labels";
import { colorClass, state, view } from "./state";
import { layoutColumns, type Item } from "./layout";
import { showBooking } from "./booking-panel";

const HOUR_PX = 64;
// The unavailable times on a day, as bands in minutes since midnight, cut to the hours from firstMin to lastMin.
export function dayBlocks(day: string, firstMin: number, lastMin: number) {
  const out: { from: number; to: number; note: string }[] = [];
  (state.blocks || []).forEach(function (block) {
    const span = blockSpan(block, day);
    if (span && span.to > firstMin && span.from < lastMin) {
      out.push({ from: Math.max(firstMin, span.from), to: Math.min(lastMin, span.to), note: block.note });
    }
  });
  return out;
}
// A hatched band behind the interviews; px: the height of an hour.
export function blockBand(band: { from: number; to: number; note: string }, firstMin: number, px: number, className: string) {
  const box = el("div", { class: className }, [el("span", { text: "Time off" + (band.note ? " · " + band.note : "") })]);
  box.style.top = ((band.from - firstMin) / 60) * px + "px";
  box.style.height = ((band.to - band.from) / 60) * px + "px";
  return box;
}
export function dayItems(day: string): Item[] {
  return state.events
    .filter(function (booking) {
      return dayKeyOf(new Date(booking.start)) === day;
    })
    .map(function (booking): Item {
      const start = new Date(booking.start);
      const from = minutesOfDay(start);
      const minutes = Math.max(15, Math.round((Date.parse(booking.end) - +start) / 60000));
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
// "Sep 21 – 27", "Sep 28 – Oct 4", with the year only when it isn't this year.
function weekTitle(first: string) {
  const last = addDays(first, 6);
  const year = first.slice(0, 4) !== dayKeyOf(new Date()).slice(0, 4) ? ", " + last.slice(0, 4) : "";
  const sameMonth = first.slice(0, 7) === last.slice(0, 7);
  return (
    formatDay(first, { month: "short", day: "numeric" }) +
    " – " +
    (sameMonth ? String(+last.slice(8)) : formatDay(last, { month: "short", day: "numeric" })) +
    year
  );
}
export function renderWeek() {
  const today = dayKeyOf(new Date());
  const days = [];
  const itemsByDay: Item[][] = [];
  let i;
  let fromMin = state.hours.start;
  let toMin = state.hours.end;
  const now = Date.now();
  const nowMin = minutesOfDay(new Date());
  for (i = 0; i < 7; i++) {
    days.push(addDays(view.week!, i));
    itemsByDay.push(dayItems(days[i]));
  }
  itemsByDay.forEach(function (items) {
    items.forEach(function (item) {
      fromMin = Math.min(fromMin, item.from);
      toMin = Math.max(toMin, item.to);
    });
  });
  const firstHour = Math.floor(fromMin / 60);
  const lastHour = Math.min(24, Math.ceil(toMin / 60));
  const height = (lastHour - firstHour) * HOUR_PX;
  byId("title").textContent = weekTitle(view.week!);
  byId<HTMLInputElement>("pick").value = view.day || today;
  const week = byId("week");
  const firstPaint = !week.firstChild;
  const scrollX = week.scrollLeft;
  const scrollY = week.scrollTop;
  week.textContent = "";
  const grid = el("div", {
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
  const axis = el("div", {
    class: "axis",
  });
  axis.style.height = height + "px";
  i = firstHour;
  for (; i <= lastHour; i++) {
    const label = el("span", {
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
    const column = el("div", {
      class: "col" + (day === today ? " today" : ""),
    });
    column.style.height = height + "px";
    dayBlocks(day, firstHour * 60, lastHour * 60).forEach(function (band) {
      column.appendChild(blockBand(band, firstHour * 60, HOUR_PX, "blk"));
    });
    layoutColumns(itemsByDay[index]);
    itemsByDay[index].forEach(function (item) {
      const booking = item.booking;
      const interviewer = state.iv.assign[booking.id];
      const cols = item.group!.cols.length;
      const isPast = Date.parse(booking.end) <= now;
      const started = Date.parse(booking.start) <= now;
      const boxHeight = Math.max(22, ((item.to - item.from) / 60) * HOUR_PX - 2);
      const button = el(
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
            interviewer
              ? "Interview support: " + interviewer
              : booking.missed
                ? missedLabel(booking)
                : started
                  ? "Interview support not recorded"
                  : "",
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
      button.style.left = "calc(" + (item.col! * 100) / cols + "% + 2px)";
      button.style.width = "calc(" + 100 / cols + "% - 4px)";
      column.appendChild(button);
    });
    if (day === today && nowMin >= firstHour * 60 && nowMin <= lastHour * 60) {
      const nowLine = el("div", {
        class: "now",
      });
      nowLine.style.top = ((nowMin - firstHour * 60) / 60) * HOUR_PX + "px";
      column.appendChild(nowLine);
    }
    grid.appendChild(column);
  });
  week.appendChild(grid);
  if (firstPaint) {
    const todayIndex = days.indexOf(today);
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
