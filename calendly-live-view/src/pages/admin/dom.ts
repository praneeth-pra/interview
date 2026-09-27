// The admin page's DOM helpers: the shared byId() and el(), plus onEnterOrSpace(), the toast and form messages.
import { byId, el } from "../shared/dom";

export type { Attrs, Child } from "../shared/dom";
function onEnterOrSpace(action: () => void) {
  return function (event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// Every toast confirms something just saved, so it also gives a short buzz on phones that support it (Android; iPhones ignore it).
function toast(text: string) {
  try {
    if (navigator.vibrate && matchMedia("(pointer: coarse)").matches) {
      navigator.vibrate(10);
    }
  } catch (e) {}
  var box = byId("toast");
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    box.hidden = true;
  }, 3200);
}
function setMessage(box: HTMLElement, text: string, isError?: boolean) {
  box.textContent = text;
  box.className = "msg" + (isError ? " err" : "");
}

export { byId, el, onEnterOrSpace, toast, setMessage };
