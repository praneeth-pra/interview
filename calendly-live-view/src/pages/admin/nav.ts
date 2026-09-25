// Phone bottom navigation, the Analytics tab, the week/agenda switch and the bottom-sheet panel.
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
  function sync() {
    var current = currentView();
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
  var weekView = true;
  function view(week: boolean) {
    weekView = week;
    body.classList.toggle("wkv", week);
    byId("vAg").setAttribute("aria-selected", String(!week));
    byId("vWk").setAttribute("aria-selected", String(week));
  }
  byId("vAg").onclick = function () {
    view(false);
  };
  var newButton = byId("newb");
  var topRight = document.querySelector(".top .tr");
  var phoneWidth = matchMedia("(max-width:760px)");
  function place() {
    if (newButton.parentNode !== topRight) {
      topRight.appendChild(newButton);
    }
  }
  place();
  if (phoneWidth.addEventListener) {
    phoneWidth.addEventListener("change", place);
  } else {
    phoneWidth.addListener(place);
  }
  byId("vWk").onclick = function () {
    view(true);
  };
  view(weekView);
  var panel = byId("panel");
  new MutationObserver(function () {
    body.classList.toggle("sheet", !panel.hidden);
  }).observe(panel, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
}
