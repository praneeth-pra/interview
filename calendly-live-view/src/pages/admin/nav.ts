// Section tabs (Calendar is the week grid, Agenda the day's timeline, then Contacts, Enquiries, Payments and Analytics) in the
// header and the phone bottom bar, the phone section title, and the bottom-sheet panel, which can be swiped down to close.
// Phones keep five buttons in the bottom bar, so Analytics opens from the ⋯ menu there.
export function setupNav() {
  function byId(id: string) {
    return document.getElementById(id);
  }
  var body = document.body;
  var nav = document.querySelector(".bnav");
  // Phones with little memory (Chrome on Android says how much) scroll more smoothly without the frosted-glass bars.
  var memory = (navigator as any).deviceMemory;
  if (memory && memory <= 4) {
    document.documentElement.classList.add("lite");
  }
  var weekView = new URLSearchParams(location.search).get("view") !== "agenda";
  function currentView() {
    if (!byId("viewStats").hidden) {
      return "stats";
    } else if (!byId("viewEnq").hidden) {
      return "enq";
    } else if (!byId("viewPay").hidden) {
      return "pay";
    } else if (!byId("viewRev").hidden) {
      return "rev";
    } else if (!weekView) {
      return "ag";
    } else {
      return "cal";
    }
  }
  var TITLES = { cal: "Calendar", ag: "Agenda", stats: "Contacts", enq: "Enquiries", pay: "Payments", rev: "Analytics" };
  // Switching sections is instant; only the bottom bar's highlight slides to the new tab.
  var pill = document.createElement("span");
  pill.className = "bnav-pill";
  pill.setAttribute("aria-hidden", "true");
  nav.insertBefore(pill, nav.firstChild);
  function placePill() {
    var active = nav.querySelector<HTMLElement>("[data-go].on");
    pill.hidden = !active;
    if (active) {
      pill.style.width = active.offsetWidth + "px";
      pill.style.transform = "translateX(" + active.offsetLeft + "px)";
    }
  }
  addEventListener("resize", placePill);
  function sync() {
    var current = currentView();
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
    byId("tabPay").setAttribute("aria-selected", String(current === "pay"));
    byId("tabRev").setAttribute("aria-selected", String(current === "rev"));
    placePill();
  }
  // Each tab opens where you left it. The page is one long scroll, so remember its position per tab.
  var scrolls: { [view: string]: number } = {};
  addEventListener(
    "scroll",
    function () {
      scrolls[currentView()] = window.scrollY;
    },
    { passive: true },
  );
  function arrive(key: string) {
    var top = scrolls[key] || 0;
    window.scrollTo(0, top);
    // a tab that redraws on arrival can be shorter for a frame, so try again once it has drawn
    requestAnimationFrame(function () {
      if (currentView() === key && window.scrollY !== top) {
        window.scrollTo(0, top);
      }
    });
  }
  // Phone Back (or iPhone's swipe back) closes an open sheet first, then returns to the tab the admin opened on, and only
  // then leaves. Leaving that tab adds one history entry; later switches replace it, so Back never walks through every tab.
  var homeView = "";
  var onTab = false;
  var restoring = false;
  function setUrl(url: string, key: string) {
    if (restoring) {
      return;
    }
    try {
      if (homeView && key === homeView && onTab) {
        onTab = false;
        history.back();
      } else if (homeView && key !== homeView && !onTab) {
        onTab = true;
        history.pushState({ tab: 1 }, "", url);
      } else {
        history.replaceState(history.state, "", url);
      }
    } catch (e) {}
  }
  function showStats() {
    setUrl("/admin?view=analytics", "stats");
    byId("viewCal").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewPay").hidden = true;
    byId("viewRev").hidden = true;
    byId("viewStats").hidden = false;
    sync();
    arrive("stats");
    if (window.__stats) {
      window.__stats();
    }
  }
  byId("tabStats").onclick = showStats;
  function showEnq() {
    // admins who aren't owners don't have this tab
    if (byId("tabEnq").hidden) {
      return;
    }
    setUrl("/admin?view=enquiries", "enq");
    byId("viewCal").hidden = true;
    byId("viewStats").hidden = true;
    byId("viewPay").hidden = true;
    byId("viewRev").hidden = true;
    byId("viewEnq").hidden = false;
    sync();
    arrive("enq");
    if (window.__enq) {
      window.__enq();
    }
  }
  byId("tabEnq").onclick = showEnq;
  function showPay() {
    // admins who aren't owners don't have this tab
    if (byId("tabPay").hidden) {
      return;
    }
    // keep ?pay= from a payment alert, so the tab can open that payment
    var pay = new URLSearchParams(location.search).get("pay");
    setUrl("/admin?view=payments" + (pay ? "&pay=" + encodeURIComponent(pay) : ""), "pay");
    byId("viewCal").hidden = true;
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewRev").hidden = true;
    byId("viewPay").hidden = false;
    sync();
    arrive("pay");
    if (window.__pay) {
      window.__pay();
    }
  }
  byId("tabPay").onclick = showPay;
  function showRev() {
    // admins who aren't owners don't have this tab
    if (byId("tabRev").hidden) {
      return;
    }
    setUrl("/admin?view=revenue", "rev");
    byId("viewCal").hidden = true;
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewPay").hidden = true;
    byId("viewRev").hidden = false;
    sync();
    arrive("rev");
    if (window.__rev) {
      window.__rev();
    }
  }
  byId("tabRev").onclick = showRev;
  byId("mRev").onclick = showRev;
  function showCal(week: boolean) {
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewPay").hidden = true;
    byId("viewRev").hidden = true;
    view(week);
    try {
      var url = new URL(location.href);
      if (week) {
        url.searchParams.delete("view");
      } else {
        url.searchParams.set("view", "agenda");
      }
      setUrl(url.pathname + url.search, week ? "cal" : "ag");
    } catch (e) {}
    sync();
    arrive(week ? "cal" : "ag");
  }
  byId("tabCal").addEventListener("click", function () {
    showCal(true);
  });
  byId("tabAg").onclick = function () {
    // the Calendar click only shows the calendar section; the Agenda is the one to remember in history
    var was = restoring;
    restoring = true;
    byId("tabCal").click();
    restoring = was;
    showCal(false);
  };
  nav.addEventListener("click", function (e) {
    var button = (e.target as Element).closest("[data-go]");
    if (!button) {
      return;
    }
    var target = button.getAttribute("data-go");
    // tapping the tab you're already on scrolls it back to the top, like a native tab bar
    if (target === currentView()) {
      window.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      return;
    }
    if (target === "stats") {
      showStats();
      return;
    }
    if (target === "enq") {
      showEnq();
      return;
    }
    if (target === "pay") {
      showPay();
      return;
    }
    byId(target === "ag" ? "tabAg" : "tabCal").click();
  });
  var startView = new URLSearchParams(location.search).get("view");
  if (startView === "analytics") {
    setTimeout(showStats, 0);
  } else if (startView === "enquiries") {
    setTimeout(showEnq, 0);
  } else if (startView === "payments") {
    setTimeout(showPay, 0);
  } else if (startView === "revenue") {
    setTimeout(showRev, 0);
  }
  setTimeout(function () {
    homeView = currentView();
  }, 0);
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
  var sheet = byId("panel");
  var sheetEntry = false;
  var skipPop = false;
  new MutationObserver(function () {
    if (!sheet.hidden && !sheetEntry) {
      sheetEntry = true;
      try {
        history.pushState({ sheet: 1 }, "", location.href);
      } catch (e) {}
    } else if (sheet.hidden && sheetEntry) {
      // closed by its button, the backdrop or a swipe: drop the entry Back would otherwise spend on it
      sheetEntry = false;
      skipPop = true;
      history.back();
    }
  }).observe(sheet, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  addEventListener("popstate", function () {
    if (skipPop) {
      skipPop = false;
      return;
    }
    if (sheetEntry) {
      sheetEntry = false;
      byId("pclose").click();
      return;
    }
    var shown = new URLSearchParams(location.search).get("view");
    restoring = true;
    if (shown === "analytics") {
      showStats();
    } else if (shown === "enquiries") {
      showEnq();
    } else if (shown === "payments") {
      showPay();
    } else if (shown === "revenue") {
      showRev();
    } else {
      byId(shown === "agenda" ? "tabAg" : "tabCal").click();
    }
    restoring = false;
    onTab = !!homeView && currentView() !== homeView;
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
      if (dragBy > 0) {
        // Stop iOS from also rubber-banding the sheet's scroll area, which pulls the content away from the
        // header and leaves a blank gap while the sheet moves.
        event.preventDefault();
      }
      if (dragBy > 4) {
        panel.style.transition = "none";
        panel.style.transform = "translateY(" + dragBy + "px)";
      }
    },
    { passive: false },
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
