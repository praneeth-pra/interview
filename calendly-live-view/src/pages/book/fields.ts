// The details form's fields: plain text fields, the interview round and the company with its suggestions.
import { el } from "./dom";
import { companies, loadCompanies, suggestCompanies } from "./companies";
import { state } from "./app";
import { markPreviousCompany } from "./returning";
import type { FieldOptions, State } from "./types";

export function textField(id: string, key: keyof State["form"], label: string, type: string, opts?: FieldOptions) {
  opts = opts || {};
  var error = state.fieldErr[key];
  var input = el("input", {
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
      var errorEl = document.getElementById(id + "e");
      if (errorEl) {
        errorEl.remove();
      }
    }
  });
  var children: HTMLElement[] = [
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
        [error],
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
// Interview round: a dropdown of the usual rounds; "Other" opens a text box for anything else.
var ROUNDS = ["1st round", "2nd round", "3rd round", "Manager round", "HR round", "Final round", "Demo"];
export function roundField() {
  var current = state.form.round.trim();
  var custom = !!current && ROUNDS.indexOf(current) < 0;
  var select = el("select", {
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
  var other = el("input", {
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
    select.classList.toggle("empty", !select.value);
    if (select.value === "__other") {
      other.hidden = false;
      state.form.round = other.value;
      other.focus();
    } else {
      other.hidden = true;
      state.form.round = select.value;
    }
  });
  other.addEventListener("input", function () {
    state.form.round = other.value;
  });
  return el("div", { class: "f" }, [el("label", { for: "fround" }, ["Interview round"]), select, other]);
}
export function companyField() {
  var id = "fcompany";
  var listId = "fcompany-list";
  var matches = [];
  var active = -1;
  var input = el("input", {
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
  var list = el("ul", {
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
    for (var k = 0; k < list.children.length; k++) {
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
  function choose(index) {
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
      var query = input.value.trim();
      matches = suggestCompanies(query);
      if (matches.length === 1 && matches[0].name.toLowerCase() === query.toLowerCase()) {
        matches = [];
      }
      if (!matches.length) {
        return close();
      }
      list.innerHTML = "";
      var lower = query.toLowerCase();
      matches.forEach(function (match, index) {
        var label = el("span", {
          class: "cb-n",
        });
        var at = match.name.toLowerCase().indexOf(lower);
        if (at >= 0) {
          label.appendChild(document.createTextNode(match.name.slice(0, at)));
          label.appendChild(el("b", null, [match.name.slice(at, at + query.length)]));
          label.appendChild(document.createTextNode(match.name.slice(at + query.length)));
        } else {
          label.appendChild(document.createTextNode(match.name));
        }
        var option = el(
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
      var errorEl = document.getElementById(id + "e");
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
    var open = !list.hidden;
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
