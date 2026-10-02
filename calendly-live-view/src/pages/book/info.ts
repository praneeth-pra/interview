// The panel beside the calendar: who, what, how long, and the chosen time.
import { el } from "../shared/dom";
import { ICONS } from "./icons";
import { formatRange } from "./time";
import { DURATIONS, card, eventName, hostName, info, manage, render, state } from "./app";
import { loadDays, showSlots } from "./slots";
import type { Step } from "./types";

export function renderInfo() {
  const backTo: Step | null =
    state.step === "details" || state.step === "confirm"
      ? "pick"
      : manage && (state.step === "pick" || state.step === "cancel")
        ? "manage"
        : null;
  const section = el("section", {
    class: "info" + (backTo ? " has-back" : ""),
  });
  if (backTo) {
    card.appendChild(
      el("button", {
        class: "back",
        id: "back",
        "aria-label": backTo === "pick" ? "Back to times" : "Back to your interview",
        html: ICONS.left,
        onclick: function () {
          state.step = backTo!;
          state.err = "";
          render();
          if (backTo === "pick" && !state.days.length) {
            loadDays();
          }
        },
      }),
    );
  }
  // the name as on the landing page ("Hi" in the accent), linking back to it
  const cut = hostName.indexOf("-");
  section.appendChild(
    el("a", { class: "host", href: "/" }, cut > 0 ? [el("em", { text: hostName.slice(0, cut) }), hostName.slice(cut)] : [hostName]),
  );
  section.appendChild(
    el(
      "h1",
      {
        class: "ev",
      },
      [eventName],
    ),
  );
  const onDetails = state.step === "details";
  if (state.step === "pick") {
    const lengths = el("div", {
      class: "dur-opts",
      role: "group",
      "aria-label": "Meeting length",
    });
    DURATIONS.forEach(function (minutes) {
      lengths.appendChild(
        el(
          "button",
          {
            type: "button",
            id: "dur" + minutes,
            "aria-pressed": String(state.dur === minutes),
            onclick: function () {
              if (state.dur !== minutes) {
                state.dur = minutes;
                state.slot = null;
                loadDays(true).then(function () {
                  if (state.date) {
                    showSlots();
                  }
                });
              }
            },
          },
          [minutes + " min"],
        ),
      );
    });
    section.appendChild(
      el(
        "div",
        {
          class: "dur",
        },
        [
          el("div", {
            class: "dur-l",
            html: ICONS.clock + "<span>Meeting length</span>",
          }),
          lengths,
        ],
      ),
    );
  }
  const meta = el("ul", {
    class: "meta",
  });
  if (onDetails) {
    meta.appendChild(
      el("li", {
        html: ICONS.clock + "<span>" + state.dur + " min</span>",
      }),
    );
    meta.appendChild(
      el("li", {
        class: "hl",
        html: ICONS.cal + "<span></span>",
      }),
    );
    meta.lastChild!.lastChild!.textContent = formatRange(state.slot!, state.dur);
    meta.appendChild(
      el("li", {
        html: ICONS.globe + "<span>India Standard Time</span>",
      }),
    );
  } else if (manage && (state.step === "manage" || state.step === "cancel")) {
    meta.appendChild(
      el("li", {
        html: ICONS.clock + "<span>" + manage.duration + " min</span>",
      }),
    );
    meta.appendChild(
      el("li", {
        class: "hl",
        html: ICONS.cal + "<span></span>",
      }),
    );
    meta.lastChild!.lastChild!.textContent = formatRange(Date.parse(manage.start), manage.duration);
    meta.appendChild(
      el("li", {
        html: ICONS.globe + "<span>India Standard Time</span>",
      }),
    );
  }
  if (info.loc) {
    meta.appendChild(
      el("li", {
        html: ICONS.pin + "<span></span>",
      }),
    );
    meta.lastChild!.lastChild!.textContent = info.loc;
  }
  section.appendChild(meta);
  if (info.desc) {
    const desc = el("p", {
      class: "desc",
      html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.6M10 6.4v.1" stroke-linecap="round"/></svg><span></span>',
    });
    desc.lastChild!.textContent = info.desc;
    section.appendChild(desc);
  }
  return section;
}
