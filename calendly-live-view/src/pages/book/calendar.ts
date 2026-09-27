// Picking a time: the month calendar, the day's times and the Next button.
import { el } from "./dom";
import { ICONS } from "./icons";
import { formatIst, formatRange, formatTime, middayOf, todayKey } from "./time";
import { card, manage, render, state } from "./app";
import { fetchSlots, showSlots } from "./slots";

export function renderCalendar() {
  var section = el("section", {
    class: "pick",
    "aria-labelledby": "pickh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "pickh",
      },
      [manage ? "Pick a New Date & Time" : "Select a Date & Time"],
    ),
  );
  if (manage) {
    section.appendChild(
      el(
        "p",
        {
          class: "was",
        },
        ["Currently " + formatRange(Date.parse(manage.start), manage.duration)],
      ),
    );
  }
  if (state.err) {
    section.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  var year = state.viewY;
  var month = state.viewM;
  if (!year) {
    section.appendChild(
      el("div", {
        class: "spin",
        "aria-label": "Loading",
      }),
    );
    return section;
  }
  var firstKey = state.days.length ? state.days[0].key : "";
  var lastKey = state.days.length ? state.days[state.days.length - 1].key : "";
  function monthKey(y, m) {
    return y + "-" + String(m).padStart(2, "0");
  }
  var canPrev = firstKey && firstKey.slice(0, 7) < monthKey(year, month);
  var canNext = lastKey && lastKey.slice(0, 7) > monthKey(year, month);
  var monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  section.appendChild(
    el(
      "div",
      {
        class: "mhead",
      },
      [
        el("button", {
          class: "nav",
          id: "prevm",
          type: "button",
          "aria-label": "Previous month",
          disabled: !canPrev,
          html: ICONS.left,
          onclick: function () {
            state.viewM--;
            if (state.viewM < 1) {
              state.viewM = 12;
              state.viewY--;
            }
            render();
          },
        }),
        el(
          "div",
          {
            class: "m",
            "aria-live": "polite",
          },
          [monthLabel],
        ),
        el("button", {
          class: "nav",
          id: "nextm",
          type: "button",
          "aria-label": "Next month",
          disabled: !canNext,
          html: ICONS.right,
          onclick: function () {
            state.viewM++;
            if (state.viewM > 12) {
              state.viewM = 1;
              state.viewY++;
            }
            render();
          },
        }),
      ],
    ),
  );
  var grid = el("div", {
    class: "grid",
    role: "group",
    "aria-label": monthLabel,
  });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (weekday) {
    grid.appendChild(
      el(
        "div",
        {
          class: "wd",
          "aria-hidden": "true",
        },
        [weekday],
      ),
    );
  });
  for (
    var leadingBlanks = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7,
      daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(),
      today = todayKey(),
      blank = 0;
    blank < leadingBlanks;
    blank++
  ) {
    grid.appendChild(el("div"));
  }
  for (var dayOfMonth = 1; dayOfMonth <= daysInMonth; dayOfMonth++) {
    (function (day) {
      var key = monthKey(year, month) + "-" + String(day).padStart(2, "0");
      var isOpen = !!state.openSet[key];
      var className = "day" + (isOpen ? " open" : "") + (key === today ? " today" : "");
      var label = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(Date.UTC(year, month - 1, day)));
      if (isOpen) {
        grid.appendChild(
          el(
            "button",
            {
              type: "button",
              class: className,
              id: "d" + key,
              "aria-pressed": String(state.date === key),
              "aria-label": label + (key === today ? ", today" : "") + ", times available",
              onpointerenter: function () {
                fetchSlots(key, state.dur);
              },
              onclick: function () {
                if (state.date !== key) {
                  state.date = key;
                  state.anim = true; // start the new day's list at its top
                  showSlots(true);
                }
              },
            },
            [String(day)],
          ),
        );
      } else {
        grid.appendChild(
          el(
            "div",
            {
              class: className,
              "aria-label": label + ", no times available",
            },
            [String(day)],
          ),
        );
      }
    })(dayOfMonth);
  }
  section.appendChild(grid);
  var tz = el("span", {
    html: ICONS.globe + "<span></span>",
  });
  tz.lastChild.textContent = "India Standard Time (" + formatTime(Date.now()) + ")";
  section.appendChild(
    el(
      "div",
      {
        class: "tz",
      },
      [el("b", null, ["Time zone"]), tz],
    ),
  );
  return section;
}
export function renderTimes() {
  var section = el("section", {
    class: "times",
    "aria-labelledby": "timesh",
  });
  section.appendChild(
    el(
      "h3",
      {
        id: "timesh",
      },
      [
        formatIst(middayOf(state.date), {
          weekday: "long",
          month: "long",
          day: "numeric",
        }),
      ],
    ),
  );
  var list = el("div", {
    class: "tlist" + (state.stale ? " stale" : ""),
    "aria-busy": state.stale ? "true" : null,
  });
  if (state.slots === null) {
    list.appendChild(
      el("div", {
        class: "spin",
        "aria-label": "Loading times",
      }),
    );
  } else if (state.slots.length) {
    state.slots.forEach(function (ms) {
      var selected = state.slot === ms;
      var row = el("div", {
        class: "slot" + (selected ? " sel" : ""),
      });
      row.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "t",
            id: "s" + ms,
            "aria-pressed": String(selected),
            disabled: !!state.stale,
            onclick: function () {
              toggleSlot(ms);
            },
          },
          [formatTime(ms)],
        ),
      );
      if (selected) {
        row.appendChild(nextButton(ms));
      }
      list.appendChild(row);
    });
  } else {
    list.appendChild(
      el(
        "p",
        {
          class: "empty",
        },
        ["No times left on this day. Pick another date."],
      ),
    );
  }
  section.appendChild(list);
  return section;
}
function nextButton(ms) {
  return el(
    "button",
    {
      type: "button",
      class: "go",
      id: "go",
      "aria-label": (manage ? "Next: confirm " : "Next: enter your details for ") + formatTime(ms),
      onclick: function () {
        state.err = "";
        if (manage) {
          state.step = "confirm";
          render();
          var confirmButton = document.getElementById("rsgo");
          if (confirmButton) {
            confirmButton.focus();
          }
          return;
        }
        state.step = "details";
        state.fieldErr = {};
        render();
        // On a phone, open the details page at its top without popping the keyboard up; on a computer, start typing.
        if (matchMedia("(max-width: 900px)").matches) {
          window.scrollTo(0, 0);
          return;
        }
        var firstField = document.getElementById(state.form.email ? "fname" : "femail");
        if (firstField) {
          firstField.focus();
        }
      },
    },
    ["Next"],
  );
}
function toggleSlot(ms) {
  var previous = card.querySelector<HTMLElement>(".slot.sel");
  if (previous) {
    previous.classList.remove("sel");
    (previous.firstChild as HTMLElement).setAttribute("aria-pressed", "false");
    if ((previous.lastChild as HTMLElement).className === "go") {
      previous.removeChild(previous.lastChild);
    }
  }
  if (state.slot === ms) {
    state.slot = null;
    return;
  }
  state.slot = ms;
  var button = document.getElementById("s" + ms);
  if (!button) {
    return render();
  }
  (button.parentNode as HTMLElement).classList.add("sel");
  button.setAttribute("aria-pressed", "true");
  var next = nextButton(ms);
  button.parentNode.appendChild(next);
  next.focus({
    preventScroll: true,
  });
}
