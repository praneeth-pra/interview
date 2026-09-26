// Section tabs (Calendar is the week grid, Agenda the day's timeline, then Contacts and Enquiries) in the header and the
// phone bottom bar, the phone section title, and the bottom-sheet panel, which can be swiped down to close.
export function setupNav() {
  function byId(id: string) {
    return document.getElementById(id);
  }
  var body = document.body;
  var nav = document.querySelector(".bnav");
  var weekView = new URLSearchParams(location.search).get("view") !== "agenda";
  function currentView() {
    if (!byId("viewStats").hidden) {
      return "stats";
    } else if (!byId("viewEnq").hidden) {
      return "enq";
    } else if (!weekView) {
      return "ag";
    } else {
      return "cal";
    }
  }
  var TITLES = { cal: "Calendar", ag: "Agenda", stats: "Contacts", enq: "Enquiries" };
  // Switching sections: the bottom bar's highlight slides to the new tab, and the page slides in from the side of travel.
  var ORDER = ["cal", "ag", "stats", "enq"];
  var pill = document.createElement("span");
  pill.className = "bnav-pill";
  pill.setAttribute("aria-hidden", "true");
  nav.insertBefore(pill, nav.firstChild);
  var main = document.querySelector("main");
  var lastView = "";
  var slideFrom = "";
  function placePill() {
    var active = nav.querySelector<HTMLElement>("[data-go].on");
    pill.hidden = !active;
    if (active) {
      pill.style.width = active.offsetWidth + "px";
      pill.style.transform = "translateX(" + active.offsetLeft + "px)";
    }
  }
  addEventListener("resize", placePill);
  function slide(from: string, to: string) {
    main.classList.remove("tab-next", "tab-prev", "tab-fade");
    void main.offsetWidth;
    // Contacts sizes its frame from where it sits, so it fades in without sliding
    main.classList.add(to === "stats" ? "tab-fade" : ORDER.indexOf(to) > ORDER.indexOf(from) ? "tab-next" : "tab-prev");
  }
  main.addEventListener("animationend", function (event) {
    if (event.target === main) {
      main.classList.remove("tab-next", "tab-prev", "tab-fade");
    }
  });
  function sync() {
    var current = currentView();
    if (current !== lastView) {
      // one tap can pass through Calendar on its way to Agenda: slide from where the tap started
      if (lastView && !slideFrom) {
        slideFrom = lastView;
        setTimeout(function () {
          slideFrom = "";
        });
      }
      if (slideFrom && slideFrom !== current) {
        slide(slideFrom, current);
      }
      lastView = current;
    }
    byId("sect").textContent = TITLES[current];
    byId("qbtn").setAttribute("aria-expanded", String(current === "stats" && body.classList.contains("cq-open")));
    body.classList.toggle("on-cal", current === "cal" || current === "ag");
    nav.querySelectorAll("[data-go]").forEach(function (button) {
      button.classList.toggle("on", button.getAttribute("data-go") === current);
    });
    byId("tabCal").setAttribute("aria-selected", String(current === "cal"));
    byId("tabAg").setAttribute("aria-selected", String(current === "ag"));
    byId("tabStats").setAttribute("aria-selected", String(current === "stats"));
    byId("tabEnq").setAttribute("aria-selected", String(current === "enq"));
    placePill();
  }
  function showStats() {
    try {
      history.replaceState(null, "", "/admin?view=analytics");
    } catch (e) {}
    byId("viewCal").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewStats").hidden = false;
    sync();
    window.scrollTo(0, 0);
    if (window.__stats) {
      window.__stats();
    }
  }
  byId("tabStats").onclick = showStats;
  function showEnq() {
    try {
      history.replaceState(null, "", "/admin?view=enquiries");
    } catch (e) {}
    byId("viewCal").hidden = true;
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = false;
    sync();
    window.scrollTo(0, 0);
    if (window.__enq) {
      window.__enq();
    }
  }
  byId("tabEnq").onclick = showEnq;
  function showCal(week: boolean) {
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = true;
    view(week);
    try {
      var url = new URL(location.href);
      if (week) {
        url.searchParams.delete("view");
      } else {
        url.searchParams.set("view", "agenda");
      }
      history.replaceState(null, "", url.pathname + url.search);
    } catch (e) {}
    sync();
  }
  byId("tabCal").addEventListener("click", function () {
    showCal(true);
  });
  byId("tabAg").onclick = function () {
    byId("tabCal").click();
    showCal(false);
  };
  nav.addEventListener("click", function (e) {
    var button = (e.target as Element).closest("[data-go]");
    if (!button) {
      return;
    }
    var target = button.getAttribute("data-go");
    if (target === "stats") {
      showStats();
      return;
    }
    if (target === "enq") {
      showEnq();
      return;
    }
    byId(target === "ag" ? "tabAg" : "tabCal").click();
    window.scrollTo(0, 0);
  });
  var startView = new URLSearchParams(location.search).get("view");
  if (startView === "analytics") {
    setTimeout(showStats, 0);
  } else if (startView === "enquiries") {
    setTimeout(showEnq, 0);
  }
  function view(week: boolean) {
    weekView = week;
    body.classList.toggle("wkv", week);
    sync();
  }
  // The search button in the phone header shows the contact search above the Contacts list. Phones have no
  // candidate search on the Calendar, so the button is hidden there.
  var searchButton = byId("qbtn");
  searchButton.onclick = function () {
    if (currentView() !== "stats") {
      return;
    }
    var frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
    var toggle = frame && (frame.contentWindow as any).__contactSearch;
    if (toggle) {
      var shown = !!toggle();
      body.classList.toggle("cq-open", shown);
      searchButton.setAttribute("aria-expanded", String(shown));
    }
  };
  view(weekView);
  sync();
  // the highlight starts in place, then animates from the next switch on
  requestAnimationFrame(function () {
    placePill();
    requestAnimationFrame(function () {
      nav.classList.add("ready");
    });
  });
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
