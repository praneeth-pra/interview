// Candidates (⋯ menu): the emails allowed to book and send payments, and the switch that turns the list on.
import { byId, el, setMessage } from "./dom";
import { plural } from "./labels";
import { request } from "./api";
import { state } from "./state";
import { openPanel, panel } from "./panel";
import type { AllowAdded, AllowAnswer, Allowlist } from "./types";

let allow: Allowlist = {
  enabled: false,
  emails: [],
};
let allowLoaded = false;
// T: what this action answers (adding emails also says how many were added, already there, or not emails)
function updateAllow<T extends AllowAnswer = AllowAnswer>(change: Record<string, unknown>) {
  return request<T>("/admin/api/allowlist", change).then(function (result) {
    allow = result.state;
    allowLoaded = true;
    renderAllow();
    return result;
  });
}
function renderAllow() {
  const toggle = byId<HTMLButtonElement>("sw");
  toggle.disabled = false;
  toggle.setAttribute("aria-checked", String(allow.enabled));
  byId("swd").textContent = allow.enabled
    ? "On. Only the " + plural(allow.emails.length, "email") + " below can book and send payments."
    : "Off. Anyone with the booking or payment link can use it.";
  byId("cnt").textContent = plural(allow.emails.length, "email");
  const query = byId<HTMLInputElement>("aq").value.trim().toLowerCase();
  const list = byId("alist");
  list.textContent = "";
  const shown = allow.emails.filter(function (email) {
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
    const button = el("button", {
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
// The Candidates section's buttons: the on/off switch, adding pasted emails and importing everyone who has booked.
export function setupAllowlist() {
  byId("sw").onclick = function () {
    const button = this as HTMLButtonElement;
    button.disabled = true;
    setMessage(byId("swm"), "");
    updateAllow({
      action: "enable",
      on: !allow.enabled,
    })
      .then(function () {
        setMessage(
          byId("swm"),
          allow.enabled
            ? "Turned on. Only listed emails can book and send payments now."
            : "Turned off. Anyone with the links can book and send payments.",
        );
      })
      .catch(function (error) {
        button.disabled = false;
        setMessage(byId("swm"), error.message, true);
      });
  };
  byId("addb").onclick = function () {
    const button = this as HTMLButtonElement;
    const text = byId<HTMLTextAreaElement>("add").value;
    if (!text.trim()) {
      byId("add").focus();
      return setMessage(byId("addm"), "Paste at least one email first.", true);
    }
    button.disabled = true;
    updateAllow<AllowAdded>({
      action: "add",
      text: text,
    })
      .then(function (result) {
        button.disabled = false;
        const parts = ["Added " + plural(result.added, "email") + "."];
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
    const button = this as HTMLButtonElement;
    button.disabled = true;
    updateAllow<AllowAnswer & { added: number }>({
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
}
// Candidates: who may book. Opens in the side panel like Interview supporters and Admins.
export function showCandidates() {
  panel.refresh = null;
  const body = openPanel("Candidates", "Emails allowed to book an interview.");
  const section = byId("viewAllow");
  body.classList.add("grp");
  body.appendChild(section);
  section.hidden = false;
  request<AllowAnswer>("/admin/api/allowlist")
    .then(function (result) {
      allow = result.state;
      renderAllow();
    })
    .catch(function (error) {
      setMessage(byId("swm"), error.message, true);
    });
}
// New live state: when the Candidates panel is open and the list changed elsewhere, fetch it again.
export function syncAllow() {
  if (allowLoaded && !byId("viewAllow").hidden && (state.allow.count !== allow.emails.length || state.allow.enabled !== allow.enabled)) {
    request<AllowAnswer>("/admin/api/allowlist")
      .then(function (result) {
        allow = result.state;
        renderAllow();
      })
      .catch(function () {});
  }
}
