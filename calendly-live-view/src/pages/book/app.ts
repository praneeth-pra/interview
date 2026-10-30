// What the booking page knows: the boot data from the page shell, the page's state, and render().
import type { Manage, State } from "./types";

export const boot = JSON.parse(document.getElementById("boot")!.textContent);
export const hostName = boot.host;
export const eventName = boot.event;
export const manage: Manage | null = boot.manage;
export const info = boot.info;
export const DURATIONS = [30, 60, 90];
// A demo (anyone can book one) has no interview invite, and its name and email aren't tied together: no name filled in from
// the email, no "same company as before", and nothing remembered on this device.
export const isDemo = (round: string) => /\bdemo\b/i.test(round);
export let state: State = {
  dur: 30,
  days: [],
  openSet: {},
  viewY: 0,
  viewM: 0,
  date: null,
  slots: null,
  slot: null,
  step: "pick",
  booking: null,
  err: "",
  fieldErr: {},
  form: {
    name: "",
    email: "",
    company: "",
    round: "",
  },
  busy: false,
};
export const card = document.getElementById("card")!;
export const ignoreQuery = manage && manage.id ? "&ignore=" + manage.id + "&t=" + manage.t : "";
// A fresh start, after a booking is done.
export function setState(next: State) {
  state = next;
}
// Every change draws the card again from state; main.ts says how.
let draw = function () {};
export function render() {
  draw();
}
export function setDraw(fn: () => void) {
  draw = fn;
}
