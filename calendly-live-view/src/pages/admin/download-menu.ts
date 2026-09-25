// The Download button menu (CSV and JSON exports).
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
    if ((e.target as Element).closest("a")) {
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
