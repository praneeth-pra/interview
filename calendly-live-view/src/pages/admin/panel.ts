// The side panel (a bottom sheet on phones) that bookings, lists and the ⋯ menu's sections open in, and the icons and
// avatar in it.
import { byId, el } from "./dom";
import { titleCase } from "./labels";
import { colorClass } from "./state";

// What the open panel shows: refresh redraws it when new data arrives; bookingId is the booking on screen, if any.
export const panel: { refresh: (() => void) | null; bookingId: string } = { refresh: null, bookingId: "" };
var returnFocus: HTMLElement | null = null; // focused before the panel opened
// The Candidates panel borrows the allowlist section itself, so its buttons keep their handlers. Put it back in the page
// (hidden) whenever the panel closes or shows something else.
export function parkAllow() {
  var section = byId("viewAllow");
  if (section.parentElement !== document.querySelector("main")) {
    section.hidden = true;
    document.querySelector("main").appendChild(section);
  }
  // the Revenue sheet borrows the Revenue page's contents the same way
  var revenue = byId("revBody").closest(".enqview");
  if (revenue.parentElement !== byId("viewRev")) {
    byId("viewRev").appendChild(revenue);
  }
}
export function openPanel(title: string, subtitle?: string, keepFocus?: boolean) {
  parkAllow();
  if (!keepFocus && byId("panel").hidden) {
    returnFocus = document.activeElement as HTMLElement;
  }
  byId("ptitle").textContent = title;
  byId("psub").textContent = subtitle || "";
  setPanelAvatar(null);
  panel.bookingId = "";
  var body = byId("pbody");
  body.textContent = "";
  body.classList.remove("grp", "rv");
  byId("panel").hidden = false;
  byId("pback").hidden = false;
  if (!keepFocus) {
    byId("pclose").focus();
  }
  return body;
}
export function closePanel() {
  parkAllow();
  byId("panel").hidden = true;
  byId("pback").hidden = true;
  panel.refresh = null;
  if (returnFocus && document.contains(returnFocus)) {
    returnFocus.focus();
  }
  returnFocus = null;
}
// Small line icons for the booking sheet (24×24, stroked with the text colour).
var ICON: Record<string, string> = {
  mail: "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  chart: "M5 20v-7M12 20V5M19 20v-10M3 20h18",
  person: "M12 11.6a3.6 3.6 0 1 0 0-7.2 3.6 3.6 0 0 0 0 7.2zM5 20c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6",
  cal: "M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4",
  clock: "M12 7v5l3 2M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17z",
  moved: "M4 12h13M13 7l5 5-5 5",
  x: "M6 6l12 12M18 6 6 18",
  note: "M5 4h14v16H5zM8.5 9h7M8.5 13h7M8.5 17h4",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14",
};
export function icon(name: string) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICON[name]);
  svg.appendChild(path);
  return svg;
}
export function initials(name: string) {
  var words = titleCase(name).trim().split(/\s+/).filter(Boolean);
  return ((words[0] || "?").charAt(0) + (words.length > 1 ? words[words.length - 1].charAt(0) : "")).toUpperCase();
}
// The avatar in the sheet header: the candidate's initials, in the interviewer's colour once recorded.
export function setPanelAvatar(name: string | null, interviewer?: string) {
  var avatar = document.getElementById("pav");
  if (!avatar) {
    var head = document.querySelector(".phead");
    avatar = el("span", { id: "pav", class: "pav", "aria-hidden": "true" });
    head.insertBefore(avatar, head.firstChild);
  }
  avatar.hidden = !name;
  avatar.textContent = name ? initials(name) : "";
  avatar.className = "pav " + (interviewer ? colorClass(interviewer) : "cn");
}
