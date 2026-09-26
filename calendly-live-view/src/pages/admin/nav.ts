// Phone bottom navigation and section title, the Contacts tab, the week/agenda switch (remembered; agenda by default
// on phones) and the bottom-sheet panel, which can be swiped down to close.
export function setupNav() {
  function byId(id: string) {
    return document.getElementById(id);
  }
  var body = document.body;
  var nav = document.querySelector(".bnav");
  function currentView() {
    if (!byId("viewStats").hidden) {
      return "stats";
    } else if (!byId("viewAllow").hidden) {
      return "allow";
    } else {
      return "cal";
    }
  }
  var TITLES = { cal: "Calendar", allow: "Emails", stats: "Contacts" };
  function sync() {
    var current = currentView();
    byId("sect").textContent = TITLES[current];
    body.classList.toggle("on-cal", current === "cal");
    nav.querySelectorAll("[data-go]").forEach(function (button) {
      button.classList.toggle("on", button.getAttribute("data-go") === current);
    });
    byId("tabStats").setAttribute("aria-selected", String(current === "stats"));
    if (current === "stats") {
      byId("tabCal").setAttribute("aria-selected", "false");
      byId("tabAllow").setAttribute("aria-selected", "false");
    }
  }
  function showStats() {
    try {
      history.replaceState(null, "", "/admin?view=analytics");
    } catch (e) {}
    byId("viewCal").hidden = true;
    byId("viewAllow").hidden = true;
    byId("viewStats").hidden = false;
    sync();
    window.scrollTo(0, 0);
    if (window.__stats) {
      window.__stats();
    }
  }
  byId("tabStats").onclick = showStats;
  ["tabCal", "tabAllow"].forEach(function (id) {
    byId(id).addEventListener("click", function () {
      byId("viewStats").hidden = true;
      try {
        var url = new URL(location.href);
        if (url.searchParams.get("view") === "analytics") {
          url.searchParams.delete("view");
          history.replaceState(null, "", url.pathname + url.search);
        }
      } catch (e) {}
      sync();
    });
  });
  nav.addEventListener("click", function (e) {
    var button = (e.target as Element).closest("[data-go]");
    if (!button) {
      return;
    }
    var target = button.getAttribute("data-go");
    if (target === "alerts") {
      e.stopPropagation();
      var alertsButton = byId("pushBtn");
      if (alertsButton) {
        alertsButton.click();
      }
      return;
    }
    if (target === "stats") {
      showStats();
      return;
    }
    var tab = byId(target === "allow" ? "tabAllow" : "tabCal");
    if (tab) {
      tab.click();
    }
    window.scrollTo(0, 0);
    sync();
  });
  new MutationObserver(sync).observe(byId("viewAllow"), {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  sync();
  if (new URLSearchParams(location.search).get("view") === "analytics") {
    setTimeout(showStats, 0);
  }
  var phone = matchMedia("(max-width:760px)").matches;
  var saved = "";
  try {
    saved = localStorage.getItem("adm.view") || "";
  } catch (e) {}
  var weekView = saved ? saved === "week" : !phone;
  function view(week: boolean) {
    if (week !== weekView) {
      try {
        localStorage.setItem("adm.view", week ? "week" : "agenda");
      } catch (e) {}
    }
    weekView = week;
    body.classList.toggle("wkv", week);
    byId("vAg").setAttribute("aria-selected", String(!week));
    byId("vWk").setAttribute("aria-selected", String(week));
  }
  byId("vAg").onclick = function () {
    view(false);
  };
  // The search button in the phone header shows the candidate search under the week title.
  var searchButton = byId("qbtn");
  searchButton.onclick = function () {
    var open = !body.classList.contains("q-open");
    body.classList.toggle("q-open", open);
    searchButton.setAttribute("aria-expanded", String(open));
    if (open) {
      window.scrollTo(0, 0);
      byId("q").focus();
    }
  };
  byId("vWk").onclick = function () {
    view(true);
  };
  view(weekView);
  var panel = byId("panel");
  new MutationObserver(function () {
    body.classList.toggle("sheet", !panel.hidden);
    panel.style.transform = "";
  }).observe(panel, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  // Drag the sheet down by its handle or title to close it, like a native sheet.
  var dragFrom = 0;
  var dragBy = 0;
  var dragging = false;
  panel.addEventListener(
    "touchstart",
    function (event: TouchEvent) {
      if (!matchMedia("(max-width:760px)").matches) {
        dragging = false;
        return;
      }
      var onHead = (event.target as Element).closest(".grab, .phead");
      var atTop = byId("pbody").scrollTop <= 0;
      dragging = !!onHead || (atTop && !(event.target as Element).closest("input, textarea, select, button"));
      dragFrom = event.touches[0].clientY;
      dragBy = 0;
    },
    { passive: true },
  );
  panel.addEventListener(
    "touchmove",
    function (event: TouchEvent) {
      if (!dragging) {
        return;
      }
      dragBy = Math.max(0, event.touches[0].clientY - dragFrom);
      if (dragBy > 4) {
        panel.style.transition = "none";
        panel.style.transform = "translateY(" + dragBy + "px)";
      }
    },
    { passive: true },
  );
  panel.addEventListener("touchend", function () {
    if (!dragging) {
      return;
    }
    dragging = false;
    panel.style.transition = "";
    if (dragBy > 110) {
      panel.style.transform = "translateY(100%)";
      setTimeout(function () {
        byId("pclose").click();
      }, 180);
    } else {
      panel.style.transform = "";
    }
  });
}
