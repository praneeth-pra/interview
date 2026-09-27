// The booking panel: one interview's details, its supporter and round status, and cancelling or moving it.
import { byId, el, setMessage, toast } from "./dom";
import { addDays, dayKeyOf, formatIst, formatRange, formatTime, shortDate, timeAgo, weekStart } from "./time";
import { ROUND_STATUSES, byWhom, plural, roundStatus, statusPill, titleCase, type RoundStatus } from "./labels";
import { request } from "./api";
import { sameCompany } from "../../same-company";
import { colorClass, state, view, render } from "./state";
import { closePanel, icon, initials, openPanel, panel, setPanelAvatar } from "./panel";
import type { Booking } from "./types";
import { allBookings, findBooking, loadAllBookings } from "./bookings";

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
    return !supported || (option.value !== "noshow" && option.value !== "other");
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
  card.appendChild(
    el("p", { class: "sub rs-hint", text: current ? "Tap " + current.label + " again to clear it." : "Tap how the round went." }),
  );
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
export function showBooking(id: string, refresh?: boolean) {
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
  var body = openPanel(
    titleCase(booking.name),
    [booking.company, booking.round].filter(Boolean).join(" · ") || "No company given",
    refresh,
  );
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
        el("div", { class: "bk-row" }, [icon(name), el("div", null, [el("small", { text: label }), el("span", null, [value])])]),
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
      box.appendChild(
        el("p", { class: "sub", text: "You can record who gave interview support once it starts at " + formatTime(start) + "." }),
      );
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
                  confirm(
                    "Record " + name + " as the interview supporter for " + titleCase(booking.name) + "? This can't be changed later.",
                  )
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
              text: [sameSpelling(other) ? "" : other.company, other.round].filter(Boolean).join(" · ") || "Interview",
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
export function showCancel(booking: Booking) {
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
export function timePicker(duration: number, day: string | null, ignoreId?: string) {
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
export function goToTime(startMs: number) {
  var day = dayKeyOf(new Date(startMs));
  view.day = day;
  view.week = weekStart(day);
  render();
}
export function showReschedule(booking: Booking) {
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
