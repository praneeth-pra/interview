// What the admin page knows: the boot data from the page shell and the latest live state from the server, kept on
// this device between visits.
import type { State } from "./types";

export const boot = JSON.parse(document.getElementById("boot").textContent);
export let state: State = {
  ready: false,
  events: [],
  changes: [],
  iv: {
    names: [],
    assign: {},
  },
  allow: {
    enabled: false,
    count: 0,
  },
  hours: {
    start: 540,
    end: 1260,
  },
  email: false,
};
// The last state seen is kept on this device so the app opens with the bookings already on screen, and still shows
// them offline. It is dropped on sign-out and whenever the sign-in page shows.
const STATE_KEY = "adm.state";
export const SEEN_KEY = "adm.enqSeen"; // when this admin last opened Enquiries, so the badge is right before the server answers
export function remember(text: string) {
  try {
    localStorage.setItem(STATE_KEY, text);
  } catch (e) {}
}
export function forget() {
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(SEEN_KEY);
  } catch (e) {}
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage("signed-out");
  }
}
try {
  var savedState = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
  if (savedState && savedState.ready && Array.isArray(savedState.events)) {
    state = savedState;
  }
} catch (e) {}
export function colorClass(name: string) {
  var index = state.iv.names.indexOf(name);
  if (index < 0) {
    index = 0;
    for (var pos = 0; pos < name.length; pos++) {
      index += name.charCodeAt(pos);
    }
  }
  return "c" + (index % 6);
}
// The live state replaced by a newer one from /admin/stream or /admin/api/state.
export function setState(next: State) {
  state = next;
}
