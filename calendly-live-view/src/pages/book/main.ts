// The booking page: pick a length, day and time, enter details, confirm. The same page handles the
// candidate's manage link (/b/<id>?t=...): reschedule or cancel an existing booking.
import { el } from "../shared/dom";
import { DURATIONS, card, manage, render, setDraw, state } from "./app";
import { loadDays } from "./slots";
import { renderInfo } from "./info";
import { renderCalendar, renderTimes } from "./calendar";
import { readMe } from "./returning";
import { renderDetails } from "./details";
import { renderDone } from "./done";
import { renderCancel, renderConfirm, renderManage } from "./manage";
import { renderMessage } from "./message";
import { applyDraftForm, readDraft, resumeDraft, saveDraft } from "./draft";

// Draws the card for the current step.
function drawCard() {
  saveDraft();
  const focusedId = document.activeElement && document.activeElement.id;
  let list = card.querySelector(".tlist");
  const scrollTop = list && !state.anim ? list.scrollTop : 0;
  card.innerHTML = "";
  card.className = "card" + (state.step !== "pick" || !state.date ? " narrow" : "") + (state.step === "details" ? " details" : "");
  if (state.step === "done") {
    return renderDone();
  }
  if (state.step === "msg") {
    return renderMessage();
  }
  card.appendChild(renderInfo());
  const main = el("div", {
    class: "main",
  });
  if (state.step === "pick") {
    main.appendChild(renderCalendar());
    if (state.date) {
      main.appendChild(renderTimes());
    }
  } else if (state.step === "manage") {
    main.appendChild(renderManage());
  } else if (state.step === "cancel") {
    main.appendChild(renderCancel());
  } else if (state.step === "confirm") {
    main.appendChild(renderConfirm());
  } else {
    main.appendChild(renderDetails());
  }
  card.appendChild(main);
  state.anim = false;
  if (scrollTop && (list = card.querySelector(".tlist"))) {
    list.scrollTop = scrollTop;
  }
  if (focusedId && document.getElementById(focusedId)) {
    document.getElementById(focusedId)!.focus({
      preventScroll: true,
    });
  }
}
setDraw(drawCard);
// A returning candidate on the same device: start with the email and name they booked with last time.
const savedMe = manage ? null : readMe();
if (savedMe) {
  state.form.email = savedMe.email;
  state.form.name = savedMe.name;
}
if (manage) {
  if (manage.error) {
    state.step = "msg";
    state.msg = {
      title: "This link doesn't work",
      body: manage.error,
    };
  } else if (manage.cancelled) {
    state.step = "msg";
    state.msg = {
      title: "This interview was cancelled",
      body: "It's no longer on the calendar.",
      again: true,
    };
  } else {
    state.step = "manage";
    state.dur = DURATIONS.indexOf(manage.duration) >= 0 ? manage.duration : 30;
    const action = new URLSearchParams(location.search).get("a");
    if (action && history.replaceState) {
      history.replaceState(null, "", location.pathname + "?t=" + encodeURIComponent(manage.t));
    }
    if (!manage.past && action === "cancel") {
      state.step = "cancel";
    }
    if (!manage.past && action === "reschedule") {
      state.step = "pick";
    }
  }
  render();
  if (state.step === "pick") {
    loadDays();
  }
} else {
  // after a refresh, pick up where the candidate was (see draft.ts)
  const draft = readDraft();
  if (draft) {
    applyDraftForm(draft);
  }
  render();
  loadDays().then(function () {
    if (draft) {
      resumeDraft(draft);
    }
  });
  // typing changes the form without a redraw; keep the saved copy current
  document.addEventListener("input", saveDraft);
  addEventListener("pagehide", saveDraft);
}
setInterval(function () {
  if (state.step === "pick") {
    render();
  }
}, 60000);
