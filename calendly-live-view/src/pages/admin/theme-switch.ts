// The light/dark switch in the header. theme.js (loaded in <head>) applies the choice before the page draws; this
// flips it, remembers it on this device, and tells the Contacts frame.
export function setupThemeSwitch() {
  const button = document.getElementById("thBtn")!;
  const switchTo = window.__theme;
  if (!button || !switchTo) {
    return;
  }
  const root = document.documentElement;
  function current() {
    return root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
  function label() {
    button.setAttribute("aria-label", current() === "dark" ? "Switch to light mode" : "Switch to dark mode");
    button.title = button.getAttribute("aria-label")!;
  }
  button.addEventListener("click", function () {
    const next = current() === "dark" ? "light" : "dark";
    switchTo!(next);
    const frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
    const contacts = frame && (frame.contentWindow as any);
    if (contacts && contacts.__theme) {
      contacts.__theme(next);
    }
    label();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", label);
  addEventListener("storage", label);
  label();
}
