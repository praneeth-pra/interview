// Unavailability (⋯ menu): days or hours candidates can't book, with an optional note only admins see. Interviews already
// booked in that time stay as they are; saving says how many there are. The list shows times that haven't ended.
import { el, setMessage, toast } from "./dom";
import { request } from "./api";
import { state } from "./state";
import { openPanel, panel } from "./panel";
import { addDays, blockLabel, dayKeyOf, formatTime, istMs } from "./time";
import type { Block } from "./types";

let wholeDays = true; // the kind of time last picked, kept while the page is open

export function showUnavailable() {
  const body = openPanel("Unavailability", "Candidates can't book these times. Interviews already booked stay as they are.");
  const today = dayKeyOf(new Date());
  const msg = el("p", { class: "msg", role: "status" });
  const list = el("div", { class: "unl" });

  // ---- the form: whole days (from and to) or some hours on one day
  const fromDate = el("input", { type: "date", id: "unFrom", min: today }) as HTMLInputElement;
  const toDate = el("input", { type: "date", id: "unTo", min: today }) as HTMLInputElement;
  const fromTime = el("select", { id: "unStart" }) as HTMLSelectElement;
  const toTime = el("select", { id: "unEnd" }) as HTMLSelectElement;
  const note = el("input", {
    type: "text",
    id: "unNote",
    maxlength: "120",
    autocomplete: "off",
    placeholder: "e.g. Travelling",
  }) as HTMLInputElement;
  fromDate.value = toDate.value = today;
  // half-hour steps across the working day; "to" can also be the end of the working day
  for (let m = state.hours.start; m <= state.hours.end; m += 30) {
    const label = formatTime(istMs(today, m));
    if (m < state.hours.end) {
      fromTime.appendChild(el("option", { value: String(m), text: label }));
    }
    if (m > state.hours.start) {
      toTime.appendChild(el("option", { value: String(m), text: label }));
    }
  }
  fromTime.value = String(Math.min(state.hours.end - 30, Math.max(state.hours.start, 14 * 60)));
  toTime.value = String(Math.min(state.hours.end, +fromTime.value + 180));
  fromDate.onchange = function () {
    if (toDate.value < fromDate.value) {
      toDate.value = fromDate.value;
    }
    toDate.min = fromDate.value || today;
  };
  fromTime.onchange = function () {
    if (+toTime.value <= +fromTime.value) {
      toTime.value = String(+fromTime.value + 30);
    }
  };
  const field = (id: string, text: string, input: HTMLElement) => el("div", { class: "f" }, [el("label", { for: id, text: text }), input]);
  const fromField = field("unFrom", "From", fromDate);
  const toRow = el("div", { class: "two" }, [field("unStart", "From", fromTime), field("unEnd", "Until", toTime)]);
  const toField = field("unTo", "Until", toDate);
  const dateRow = el("div", { class: "two" }, [fromField, toField]);
  const kindDays = el("button", { type: "button", text: "Whole days" });
  const kindHours = el("button", { type: "button", text: "Some hours" });
  function setKind(days: boolean) {
    wholeDays = days;
    kindDays.setAttribute("aria-pressed", String(days));
    kindHours.setAttribute("aria-pressed", String(!days));
    fromField.querySelector("label")!.textContent = days ? "From" : "Date";
    toField.hidden = !days;
    toRow.hidden = days;
    setMessage(msg, "");
  }
  kindDays.onclick = function () {
    setKind(true);
  };
  kindHours.onclick = function () {
    setKind(false);
  };
  const add = el("button", { type: "button", class: "pri", text: "Add unavailability" }) as HTMLButtonElement;
  add.onclick = function () {
    setMessage(msg, "");
    const day = fromDate.value;
    if (!day) {
      setMessage(msg, "Pick a date.", true);
      return fromDate.focus();
    }
    const startMs = wholeDays ? istMs(day, 0) : istMs(day, +fromTime.value);
    const endMs = wholeDays ? istMs(addDays(toDate.value || day, 1), 0) : istMs(day, +toTime.value);
    add.disabled = true;
    request<{ clashes: number }>("/admin/api/unavailable", { startMs: startMs, endMs: endMs, note: note.value })
      .then(function (result) {
        note.value = "";
        toast("Unavailability added");
        if (result.clashes) {
          setMessage(
            msg,
            (result.clashes === 1 ? "1 interview is" : result.clashes + " interviews are") +
              " already booked in that time and stay as they are. Move or cancel them from the calendar if needed.",
          );
        }
      })
      .catch(function (error) {
        setMessage(msg, error.message, true);
      })
      .then(function () {
        add.disabled = false;
      });
  };
  body.appendChild(
    el("div", { class: "unform" }, [
      el("div", { class: "paysw", role: "group", "aria-label": "Unavailable for" }, [kindDays, kindHours]),
      dateRow,
      toRow,
      field("unNote", "Note (only admins see it)", note),
      add,
      msg,
    ]),
  );
  setKind(wholeDays);

  // ---- the list, redrawn when the live state changes
  body.appendChild(el("h3", { class: "unh", text: "Coming up" }));
  body.appendChild(list);
  function draw() {
    const now = Date.now();
    const blocks = (state.blocks || []).filter(function (block) {
      return Date.parse(block.end) > now;
    });
    list.textContent = "";
    if (!blocks.length) {
      list.appendChild(el("p", { class: "sub", text: "Nothing marked. Candidates can book any free time." }));
      return;
    }
    blocks.forEach(function (block: Block) {
      const label = blockLabel(block);
      list.appendChild(
        el("div", { class: "unrow" }, [
          el("div", { class: "unt" }, [el("b", { text: label }), block.note ? el("span", { text: block.note }) : null]),
          el("button", {
            type: "button",
            class: "rm",
            text: "Remove",
            "aria-label": "Remove " + label,
            onclick: function (event: Event) {
              const button = event.currentTarget as HTMLButtonElement;
              button.disabled = true;
              request("/admin/api/unavailable/delete", { id: block.id })
                .then(function () {
                  toast("Candidates can book that time again");
                })
                .catch(function (error) {
                  button.disabled = false;
                  setMessage(msg, error.message, true);
                });
            },
          }),
        ]),
      );
    });
  }
  panel.refresh = draw;
  draw();
}
