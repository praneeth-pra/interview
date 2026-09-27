// A full-card message: a link that doesn't work, a cancelled interview, or an error.
import { el } from "./dom";
import { ICONS } from "./icons";
import { card, render, state } from "./app";

export function renderMessage() {
  var msg = state.msg;
  var section = el("section", {
    class: "done",
  });
  var inner = el("div", {
    class: "done-in",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "logo",
        "aria-hidden": "true",
      },
      [],
    ),
  );
  var heading = el(
    "h1",
    msg.check
      ? {
          html: ICONS.check + "<span></span>",
        }
      : null,
    msg.check ? null : [msg.title],
  );
  if (msg.check) {
    heading.lastChild.textContent = msg.title;
  }
  inner.appendChild(heading);
  inner.appendChild(el("p", null, [msg.body]));
  var actions = [];
  if (msg.manage) {
    actions.push(
      el(
        "button",
        {
          type: "button",
          class: "pill",
          onclick: function () {
            state.step = "manage";
            state.msg = null;
            render();
          },
        },
        ["Back to your interview"],
      ),
    );
  }
  if (msg.again) {
    actions.push(
      el(
        "a",
        {
          class: "pill",
          href: "/booking",
        },
        ["Book a new time"],
      ),
    );
  }
  if (actions.length) {
    inner.appendChild(
      el(
        "div",
        {
          class: "acts",
        },
        actions,
      ),
    );
  }
  section.appendChild(inner);
  card.appendChild(section);
}
