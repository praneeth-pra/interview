// A returning candidate: the name booked with before on this device or for this email, and the companies used.
import { el } from "./dom";
import { companies } from "./companies";
import { state } from "./app";
import type { Me } from "./types";

var ME_KEY = "bk.me";
var nameCache: Record<string, string> = {};
export const WELCOME_BACK = "Welcome back. We filled in the name from your earlier booking.";
export function readMe(): Me | null {
  try {
    var me = JSON.parse(localStorage.getItem(ME_KEY) || "null");
    return me && typeof me.email === "string" && typeof me.name === "string" && Array.isArray(me.companies) ? me : null;
  } catch (error) {
    return null;
  }
}
export function rememberBooking(name: string, email: string, company: string) {
  var old = readMe();
  var earlier = old && sameEmail(old.email, email) ? old.companies : [];
  var companies = [company].concat(earlier).filter(function (item, index, all) {
    return (
      typeof item === "string" &&
      item.trim() &&
      all.findIndex(function (other) {
        return String(other).toLowerCase() === item.toLowerCase();
      }) === index
    );
  });
  try {
    localStorage.setItem(ME_KEY, JSON.stringify({ email: email, name: name, companies: companies.slice(0, 4) }));
  } catch (error) {
    // private mode or storage full: the form just won't be pre-filled next time
  }
}
function sameEmail(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}
// "Same company as before?" buttons above the Company field, shown while the email is the one this device booked with.
export function previousCompanies() {
  var me = readMe();
  if (!me || !me.companies.length) {
    return null;
  }
  var buttons = me.companies.map(function (company) {
    return el(
      "button",
      {
        type: "button",
        class: "pcb",
        "aria-pressed": sameEmail(company, state.form.company) ? "true" : "false",
        onclick: function () {
          state.form.company = company;
          delete state.fieldErr.company;
          var input = document.getElementById("fcompany") as HTMLInputElement;
          if (input) {
            input.value = company;
            input.removeAttribute("aria-invalid");
            input.removeAttribute("aria-describedby");
          }
          var errorEl = document.getElementById("fcompanye");
          if (errorEl) {
            errorEl.remove();
          }
          markPreviousCompany();
        },
      },
      [company],
    );
  });
  return el(
    "div",
    {
      class: "prevco",
      id: "prevco",
      role: "group",
      "aria-labelledby": "prevcoh",
      hidden: !sameEmail(me.email, state.form.email),
    },
    [
      el("div", { class: "prevco-h", id: "prevcoh" }, ["Interviewing with the same company as before?"]),
      el("div", { class: "prevco-l" }, buttons),
    ],
  );
}
export function markPreviousCompany() {
  var box = document.getElementById("prevco");
  if (box) {
    box.querySelectorAll(".pcb").forEach(function (button) {
      button.setAttribute("aria-pressed", sameEmail(button.textContent || "", state.form.company) ? "true" : "false");
    });
  }
}
export function showPreviousCompanies() {
  var box = document.getElementById("prevco");
  var me = readMe();
  if (box && me) {
    box.hidden = !sameEmail(me.email, state.form.email);
  }
}
export function setNameHint(text: string) {
  var hint = document.getElementById("fnameh");
  if (hint) {
    hint.textContent = text;
  }
}
function lookupName(email: string, callback: (name: string) => void) {
  var key = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
    return callback("");
  }
  if (Object.prototype.hasOwnProperty.call(nameCache, key)) {
    return callback(nameCache[key]);
  }
  fetch("/api/lookup?email=" + encodeURIComponent(key))
    .then(function (res) {
      if (res.ok) {
        return res.json();
      } else {
        return {
          name: "",
        };
      }
    })
    .then(function (data) {
      nameCache[key] = String(data.name || "");
      callback(nameCache[key]);
    })
    .catch(function () {
      callback("");
    });
}
export function prefillName(email: string) {
  lookupName(email, function (name) {
    if (state.step === "details" && state.form.email.trim().toLowerCase() === email.trim().toLowerCase()) {
      var input = document.getElementById("fname") as HTMLInputElement;
      if (!name) {
        if (state.nameAuto) {
          state.nameAuto = false;
          state.form.name = "";
          if (input) {
            input.value = "";
          }
          setNameHint("");
        }
        return;
      }
      if (!state.form.name.trim() || !!state.nameAuto) {
        state.form.name = name;
        state.nameAuto = true;
        setNameHint(WELCOME_BACK);
        if (input) {
          input.value = name;
          input.removeAttribute("aria-invalid");
          var errorEl = document.getElementById("fnamee");
          if (errorEl) {
            errorEl.remove();
          }
        }
        delete state.fieldErr.name;
      }
    }
  });
}
