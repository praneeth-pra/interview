// A refresh keeps the booking where it was: the length, day and time picked, the step (times or details) and what was
// typed are saved in this tab's sessionStorage, and restored when the page loads again. Only the tab that started it
// sees it, and it is dropped once the booking is made. Not used for manage links, which carry their own state.
import { DURATIONS, manage, render, state } from "./app";
import { fetchSlots } from "./slots";
import type { State } from "./types";

const KEY = "booking-draft";
const MAX_AGE = 12 * 3600000;
type Draft = {
  at: number;
  step: "pick" | "details";
  dur: number;
  date: string | null;
  slot: number | null;
  form: State["form"];
};

export function saveDraft() {
  if (manage) {
    return;
  }
  try {
    if (state.step === "done") {
      sessionStorage.removeItem(KEY);
    } else if (state.step === "pick" || state.step === "details") {
      const draft: Draft = {
        at: Date.now(),
        step: state.step === "details" && state.slot ? "details" : "pick",
        dur: state.dur,
        date: state.date,
        slot: state.slot,
        form: state.form,
      };
      sessionStorage.setItem(KEY, JSON.stringify(draft));
    }
  } catch (error) {
    // storage blocked or full: a refresh starts over, as before
  }
}
export function readDraft(): Draft | null {
  if (manage) {
    return null;
  }
  try {
    const draft = JSON.parse(sessionStorage.getItem(KEY) || "null") as Draft | null;
    if (!draft || typeof draft.at !== "number" || Date.now() - draft.at > MAX_AGE || DURATIONS.indexOf(draft.dur) < 0) {
      return null;
    }
    return draft;
  } catch (error) {
    return null;
  }
}
// Before the days load: the length and what was typed.
export function applyDraftForm(draft: Draft) {
  state.dur = draft.dur;
  (Object.keys(state.form) as (keyof State["form"])[]).forEach(function (key) {
    if (draft.form && typeof draft.form[key] === "string" && draft.form[key]) {
      state.form[key] = draft.form[key].slice(0, 200);
    }
  });
}
// After the days load: the day, then the time and the details step if that time is still free.
export function resumeDraft(draft: Draft) {
  if (state.step !== "pick" || state.date || !draft.date) {
    return; // nothing to restore, or the candidate already moved on
  }
  const wantedTime = draft.step === "details" && draft.slot;
  if (!state.openSet[draft.date]) {
    if (wantedTime) {
      state.err = "The time you picked is no longer available. Pick another time.";
      render();
    }
    return;
  }
  state.date = draft.date;
  state.viewY = +draft.date.slice(0, 4);
  state.viewM = +draft.date.slice(5, 7);
  state.slots = null;
  render();
  fetchSlots(draft.date, state.dur).then(function (slots) {
    if (state.date !== draft.date || state.step !== "pick") {
      return;
    }
    state.slots = slots || [];
    if (wantedTime && slots && slots.indexOf(draft.slot!) >= 0) {
      state.slot = draft.slot;
      state.step = "details";
      state.fieldErr = {};
    } else if (wantedTime) {
      state.err = "The time you picked is no longer available. Pick another time.";
    } else if (draft.slot && slots && slots.indexOf(draft.slot) >= 0) {
      state.slot = draft.slot;
    }
    render();
  });
}
