// The details form's fields: plain text fields, the interview round and the company with its suggestions.
import { el } from "../shared/dom";
import { companies, loadCompanies, suggestCompanies, type Match } from "./companies";
import { render, state } from "./app";
import { markPreviousCompany } from "./returning";
import type { FieldOptions, State } from "./types";

// A field's error, with "the onboarding form" (the server's answer to a new email) as a link to that page.
function errorParts(error: string) {
  const at = error.indexOf("the onboarding form");
  if (at < 0) {
    return [error];
  }
  const link = el("a", { href: "/onboarding", text: "the onboarding form" });
  return [error.slice(0, at), link, error.slice(at + "the onboarding form".length)];
}
export function textField(id: string, key: keyof State["form"], label: string, type: string, opts?: FieldOptions) {
  opts = opts || {};
  const error = state.fieldErr[key];
  const input = el("input", {
    id: id,
    type: type,
    name: key,
    autocomplete: opts.ac || "off",
    required: !!opts.req,
    "aria-invalid": error ? "true" : null,
    "aria-describedby": error ? id + "e" : null,
    list: opts.list || null,
    placeholder: opts.ph || null,
    maxlength: opts.max || 120,
  });
  input.value = state.form[key];
  input.addEventListener("input", function () {
    state.form[key] = input.value;
    if (state.fieldErr[key]) {
      delete state.fieldErr[key];
      input.removeAttribute("aria-invalid");
      const errorEl = document.getElementById(id + "e");
      if (errorEl) {
        errorEl.remove();
      }
    }
  });
  const children: HTMLElement[] = [
    el(
      "label",
      {
        for: id,
      },
      [label + (opts.req ? " *" : "")],
    ),
    input,
  ];
  if (error) {
    children.push(
      el(
        "div",
        {
          class: "ferr",
          id: id + "e",
        },
        errorParts(error),
      ),
    );
  }
  return el(
    "div",
    {
      class: "f",
    },
    children,
  );
}
// Interview round: a dropdown of the usual rounds; "Other" opens a text box for anything else. Only signed-in admins
// get Demo (the server refuses it from anyone else), and a demo needs no interview invite.
export const isDemo = (round: string) => /\bdemo\b/i.test(round);
export function roundField() {
  const ROUNDS = ["1st round", "2nd round", "3rd round", "Manager round", "HR round", "Final round"].concat(state.admin ? ["Demo"] : []);
  const current = state.form.round.trim();
  const custom = !!current && ROUNDS.indexOf(current) < 0;
  const select = el("select", {
    id: "fround",
    name: "round",
    class: "rsel" + (current ? "" : " empty"),
  });
  select.appendChild(el("option", { value: "" }, ["Select a round"]));
  ROUNDS.forEach(function (round) {
    select.appendChild(el("option", { value: round }, [round]));
  });
  select.appendChild(el("option", { value: "__other" }, ["Other…"]));
  select.value = custom ? "__other" : current;
  const other = el("input", {
    id: "fround-other",
    type: "text",
    name: "round-other",
    autocomplete: "off",
    maxlength: 60,
    placeholder: "Type the round",
    "aria-label": "Interview round",
    hidden: !custom,
  });
  other.value = custom ? current : "";
  select.addEventListener("change", function () {
    const wasDemo = isDemo(state.form.round);
    select.classList.toggle("empty", !select.value);
    if (select.value === "__other") {
      other.hidden = false;
      state.form.round = other.value;
      other.focus();
    } else {
      other.hidden = true;
      state.form.round = select.value;
    }
    // the invite box comes and goes with Demo
    if (isDemo(state.form.round) !== wasDemo) {
      render();
    }
  });
  other.addEventListener("input", function () {
    state.form.round = other.value;
  });
  return el("div", { class: "f" }, [el("label", { for: "fround" }, ["Interview round"]), select, other]);
}
export function companyField() {
  const id = "fcompany";
  const listId = "fcompany-list";
  let matches: Match[] = [];
  let active = -1;
  const input = el("input", {
    id: id,
    type: "text",
    name: "company",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    required: true,
    "aria-invalid": state.fieldErr.company ? "true" : null,
    "aria-describedby": state.fieldErr.company ? id + "e" : null,
    maxlength: 120,
  });
  input.value = state.form.company;
  const list = el("ul", {
    class: "cb-list",
    id: listId,
    role: "listbox",
    "aria-label": "Company suggestions",
    hidden: true,
  });
  function close() {
    list.hidden = true;
    list.innerHTML = "";
    matches = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function highlight(index: number, scroll?: boolean) {
    active = index;
    for (let k = 0; k < list.children.length; k++) {
      list.children[k].setAttribute("aria-selected", String(k === index));
    }
    if (index < 0) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", listId + "-" + index);
    if (scroll) {
      list.children[index].scrollIntoView({
        block: "nearest",
      });
    }
  }
  function choose(index: number) {
    input.value = matches[index].name;
    state.form.company = matches[index].name;
    markPreviousCompany();
    close();
  }
  function update() {
    if (document.activeElement === input) {
      if (!companies) {
        loadCompanies(update);
        return;
      }
      const query = input.value.trim();
      matches = suggestCompanies(query);
      if (matches.length === 1 && matches[0].name.toLowerCase() === query.toLowerCase()) {
        matches = [];
      }
      if (!matches.length) {
        return close();
      }
      list.innerHTML = "";
      const lower = query.toLowerCase();
      matches.forEach(function (match, index) {
        const label = el("span", {
          class: "cb-n",
        });
        const at = match.name.toLowerCase().indexOf(lower);
        if (at >= 0) {
          label.appendChild(document.createTextNode(match.name.slice(0, at)));
          label.appendChild(el("b", null, [match.name.slice(at, at + query.length)]));
          label.appendChild(document.createTextNode(match.name.slice(at + query.length)));
        } else {
          label.appendChild(document.createTextNode(match.name));
        }
        const option = el(
          "li",
          {
            id: listId + "-" + index,
            class: "cb-opt",
            role: "option",
            "aria-selected": "false",
          },
          [
            label,
            match.via
              ? el(
                  "span",
                  {
                    class: "cb-a",
                  },
                  [match.via],
                )
              : null,
          ],
        );
        option.addEventListener("mousedown", function (event) {
          event.preventDefault();
        });
        option.addEventListener("mousemove", function () {
          if (active !== index) {
            highlight(index, false);
          }
        });
        option.addEventListener("click", function () {
          choose(index);
        });
        list.appendChild(option);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
    }
  }
  input.addEventListener("input", function () {
    state.form.company = input.value;
    markPreviousCompany();
    if (state.fieldErr.company) {
      delete state.fieldErr.company;
      input.removeAttribute("aria-invalid");
      const errorEl = document.getElementById(id + "e");
      if (errorEl) {
        errorEl.remove();
      }
    }
    update();
  });
  input.addEventListener("focus", function () {
    loadCompanies();
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", function (event) {
    const open = !list.hidden;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (open) {
        highlight(active < matches.length - 1 ? active + 1 : 0, true);
      } else {
        update();
      }
    } else if (event.key === "ArrowUp") {
      if (open) {
        event.preventDefault();
        highlight(active > 0 ? active - 1 : matches.length - 1, true);
      }
    } else if (event.key === "Enter") {
      if (open && active >= 0) {
        event.preventDefault();
        choose(active);
      } else if (open) {
        close();
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
    } else if (event.key === "Tab" && open && active >= 0) {
      choose(active);
    }
  });
  return el(
    "div",
    {
      class: "f",
    },
    [
      el(
        "label",
        {
          for: id,
        },
        ["Company *"],
      ),
      el(
        "div",
        {
          class: "cbw",
        },
        [input, list],
      ),
      state.fieldErr.company
        ? el(
            "div",
            {
              class: "ferr",
              id: id + "e",
            },
            [state.fieldErr.company],
          )
        : null,
    ],
  );
}
