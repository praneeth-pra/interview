// A candidate's manage link: the booking, rescheduling it and cancelling it.
import { el } from "../shared/dom";
import { ICONS } from "./icons";
import { formatRange } from "./time";
import { eventName, hostName, manage, render, state } from "./app";
import { clearSlots, loadDays, showSlots } from "./slots";

// result: the server's JSON answer
// the server's answer: emailed says whether an email went out; a reschedule also sends the booking's new time
type ChangeResult = { emailed?: boolean; booking?: { start: string; end: string; duration: number } };
function postChange(url: string, payload: Record<string, unknown>, onSuccess: (result: ChangeResult) => void) {
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(function (res) {
      return res.json().then(function (body) {
        return {
          ok: res.ok,
          j: body,
        };
      });
    })
    .then(function (result) {
      state.busy = false;
      if (result.ok) {
        onSuccess(result.j);
        render();
        window.scrollTo(0, 0);
        return;
      }
      if (result.j.retry) {
        clearSlots();
        state.step = "pick";
        state.err = result.j.error;
        loadDays(true).then(function () {
          if (state.date) {
            showSlots();
          } else {
            render();
          }
        });
        return;
      }
      state.err = result.j.error || "Something went wrong. Try again.";
      render();
    })
    .catch(function () {
      state.busy = false;
      state.err = "Couldn't reach the server. Check your connection and try again.";
      render();
    });
}
export function renderManage() {
  const section = el("section", {
    class: "form",
    "aria-labelledby": "mh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "mh",
      },
      ["Your Interview"],
    ),
  );
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
  section.appendChild(
    el(
      "p",
      {
        class: "lead",
      },
      ["Booked for " + manage!.name + " (" + manage!.email + ")."],
    ),
  );
  if (manage!.past) {
    section.appendChild(
      el(
        "p",
        {
          class: "lead",
        },
        ["This interview has already started, so it can't be changed here. Reply to your confirmation email if you need help."],
      ),
    );
    return section;
  } else {
    section.appendChild(
      el(
        "div",
        {
          class: "acts2",
        },
        [
          el(
            "button",
            {
              type: "button",
              class: "submit",
              id: "rsb",
              onclick: function () {
                state.step = "pick";
                state.err = "";
                state.date = null;
                state.slot = null;
                state.slots = null;
                render();
                loadDays();
              },
            },
            ["Reschedule"],
          ),
          el(
            "button",
            {
              type: "button",
              class: "ghost",
              id: "cxb",
              onclick: function () {
                state.step = "cancel";
                state.err = "";
                render();
                const reasonBox = document.getElementById("reason");
                if (reasonBox) {
                  reasonBox.focus();
                }
              },
            },
            ["Cancel interview"],
          ),
        ],
      ),
    );
    return section;
  }
}
export function renderCancel() {
  const form = el("form", {
    class: "form",
    novalidate: true,
    "aria-labelledby": "ch",
    onsubmit: function (event: SubmitEvent) {
      event.preventDefault();
      if (!state.busy) {
        state.busy = true;
        state.err = "";
        render();
        postChange(
          "/api/manage/cancel",
          {
            id: manage!.id,
            t: manage!.t,
            reason: (state.reason || "").trim(),
          },
          function (result) {
            manage!.cancelled = true;
            state.step = "msg";
            state.msg = {
              title: "Interview cancelled",
              body:
                "Your " +
                eventName.toLowerCase() +
                " on " +
                formatRange(Date.parse(manage!.start), manage!.duration) +
                " is cancelled." +
                (result.emailed ? " We've emailed you a confirmation." : ""),
              again: true,
            };
          },
        );
      }
    },
  });
  form.appendChild(
    el(
      "h2",
      {
        id: "ch",
      },
      ["Cancel Interview"],
    ),
  );
  if (state.err) {
    form.appendChild(
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
  form.appendChild(
    el(
      "p",
      {
        class: "lead",
      },
      ["Your time will be released and " + hostName + " will be told."],
    ),
  );
  const reasonBox = el("textarea", {
    id: "reason",
    maxlength: 500,
    rows: 4,
  });
  reasonBox.value = state.reason || "";
  reasonBox.addEventListener("input", function () {
    state.reason = reasonBox.value;
  });
  form.appendChild(
    el(
      "div",
      {
        class: "f",
      },
      [
        el(
          "label",
          {
            for: "reason",
          },
          ["Reason for cancelling (optional)"],
        ),
        reasonBox,
      ],
    ),
  );
  form.appendChild(
    el(
      "button",
      {
        type: "submit",
        class: "submit danger",
        id: "cxgo",
        disabled: state.busy,
      },
      [state.busy ? "Cancelling…" : "Cancel interview"],
    ),
  );
  return form;
}
export function renderConfirm() {
  const section = el("section", {
    class: "form",
    "aria-labelledby": "rh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "rh",
      },
      ["Confirm New Time"],
    ),
  );
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
  const meta = el("ul", {
    class: "meta chg",
  });
  function timeItem(cls: string, label: string, text: string) {
    const li = el("li", {
      class: cls,
      html: ICONS.cal + "<span></span>",
    });
    li.lastChild!.textContent = text;
    li.setAttribute("aria-label", label + ": " + text);
    return li;
  }
  meta.appendChild(timeItem("old", "Current time", formatRange(Date.parse(manage!.start), manage!.duration)));
  meta.appendChild(timeItem("hl", "New time", formatRange(state.slot!, state.dur)));
  section.appendChild(meta);
  section.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "submit",
        id: "rsgo",
        disabled: state.busy,
        onclick: function () {
          if (!state.busy) {
            state.busy = true;
            state.err = "";
            render();
            postChange(
              "/api/manage/reschedule",
              {
                id: manage!.id,
                t: manage!.t,
                startMs: state.slot,
                duration: state.dur,
              },
              function (result) {
                manage!.start = result.booking!.start; // a reschedule's answer always has it
                manage!.end = result.booking!.end;
                manage!.duration = result.booking!.duration;
                state.dur = manage!.duration;
                state.days = [];
                state.date = null;
                state.slot = null;
                clearSlots();
                state.step = "msg";
                state.msg = {
                  title: "Interview rescheduled",
                  check: true,
                  body:
                    "Your " +
                    eventName.toLowerCase() +
                    " is now " +
                    formatRange(Date.parse(manage!.start), manage!.duration) +
                    "." +
                    (result.emailed ? " We've emailed you an updated invite." : ""),
                  manage: true,
                };
              },
            );
          }
        },
      },
      [state.busy ? "Rescheduling…" : "Reschedule"],
    ),
  );
  return section;
}
