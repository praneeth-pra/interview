// The light/dark switch in the header. theme.js (loaded in <head>) applies the choice before the page draws; this
// flips it, remembers it on this device, and tells the Contacts frame.
export function setupThemeSwitch() {
  var button = document.getElementById("thBtn")!;
  var switchTo = (window as any).__theme as ((theme: string) => void) | undefined;
  if (!button || !switchTo) {
    return;
  }
  var root = document.documentElement;
  function current() {
    return root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function label() {
    button.setAttribute("aria-label", current() === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.title = button.getAttribute("aria-label")!;
  }
  button.addEventListener("click", function () {
    var next = current() === "dark" ? "light" : "dark";
    switchTo!(next);
    var frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
    var contacts = frame && (frame.contentWindow as any);
    if (contacts && contacts.__theme) {
      contacts.__theme(next);
    }
    label();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", label);
  addEventListener("storage", label);
  label();
}
