// The ⋯ menu in the header: New booking (Alerts on phones), candidates, interviewers, downloads and sign-out.
export function setupDownloadMenu() {
  const btn = document.getElementById("dlBtn")!;
  const menu = document.getElementById("dlMenu")!;
  if (!btn || !menu) {
    return;
  }
  const home = menu.parentElement;
  const phone = matchMedia("(max-width:760px)");
  function setOpen(open: boolean) {
    // On phones the menu is a bottom sheet over a dimmed page. The header's frosted glass would hold a fixed menu
    // inside the header, so the sheet moves to the page body while it's open, and back beside the button on computers.
    if (open) {
      const parent = phone.matches ? document.body : home;
      if (parent && menu.parentElement !== parent) {
        parent.appendChild(menu);
      }
    }
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", String(open));
    document.body.classList.toggle("dm-open", open && phone.matches);
  }
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener("click", function (e) {
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
