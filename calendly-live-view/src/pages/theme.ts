// Loaded in <head> of the admin, Contacts and sign-in pages, before they draw: applies the light or dark choice made
// with the header switch on this device. With no choice the pages follow the phone's setting. The admin calls
// window.__theme("light" | "dark") to switch; other open tabs and the Contacts frame follow through the storage event.
(function () {
  const root = document.documentElement;
  function apply(theme: string) {
    if (theme === "light" || theme === "dark") {
      root.setAttribute("data-theme", theme);
    } else {
      root.removeAttribute("data-theme");
    }
    // The phone's status bar colour: each page has one theme-color for light and one for dark; a choice uses its own
    // colour for both.
    const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
    let pick = "";
    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i];
      if (!meta.dataset.c) {
        meta.dataset.c = meta.content;
      }
      if (theme && (meta.media || "").indexOf(theme) >= 0) {
        pick = meta.dataset.c;
      }
    }
    for (let k = 0; k < metas.length; k++) {
      metas[k].content = pick || metas[k].dataset.c!; // saved by the loop above
    }
  }
  let saved = "";
  try {
    saved = localStorage.getItem("theme") || "";
  } catch (e) {}
  apply(saved);
  window.__theme = function (theme: string) {
    try {
      localStorage.setItem("theme", theme);
    } catch (e) {}
    apply(theme);
  };
  addEventListener("storage", function (e: StorageEvent) {
    if (e.key === "theme") {
      apply(e.newValue || "");
    }
  });
})();
