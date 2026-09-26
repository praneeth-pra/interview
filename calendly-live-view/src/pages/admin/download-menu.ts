// The ⋯ menu in the header: New booking (Alerts on phones), candidates, interviewers, downloads and sign-out.
export function setupDownloadMenu() {
  var btn = document.getElementById("dlBtn");
  var menu = document.getElementById("dlMenu");
  if (!btn || !menu) {
    return;
  }
  function setOpen(open: boolean) {
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", function (e) {
    // Alerts opens its own sheet, so the click must not reach the document listener that closes it again.
    if ((e.target as Element).closest("#mAlerts")) {
      e.stopPropagation();
      setOpen(false);
      var alertsButton = document.getElementById("pushBtn");
      if (alertsButton) {
        alertsButton.click();
      }
      return;
    }
    if ((e.target as Element).closest("a, button")) {
      setTimeout(function () {
        setOpen(false);
      }, 0);
    }
  });
  document.addEventListener("click", function (e) {
    if (!menu.hidden && !menu.contains(e.target as Node)) {
      setOpen(false);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !menu.hidden) {
      setOpen(false);
      btn.focus();
    }
  });
}
