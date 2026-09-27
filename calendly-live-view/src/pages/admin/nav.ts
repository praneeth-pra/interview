// Section tabs (Calendar is the week grid, Agenda the day's timeline, then Contacts, Enquiries, Payments and Revenue) in the
// header and the phone bottom bar, the phone section title, and the bottom-sheet panel, which can be swiped down to close.
// Phones keep five buttons in the bottom bar, so Revenue opens from the ⋯ menu there, in the bottom sheet (main.ts).
import { byId } from "./dom";

export function setupNav() {
  const body = document.body;
  // Back-button bookkeeping for the bottom sheet (see the history handling further down).
  let skipPop = false;
  let afterPop: (() => void) | null = null;
  const nav = document.querySelector<HTMLElement>(".bnav")!;
  // Phones with little memory (Chrome on Android says how much) scroll more smoothly without the frosted-glass bars.
  const memory = navigator.deviceMemory;
  if (memory && memory <= 4) {
    document.documentElement.classList.add("lite");
  }
  let weekView = new URLSearchParams(location.search).get("view") !== "agenda";
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
  const TITLES: Record<string, string> = {
    cal: "Calendar",
    ag: "Agenda",
    stats: "Contacts",
    enq: "Enquiries",
    pay: "Payments",
    rev: "Revenue",
  };
  // Switching sections is instant; only the bottom bar's highlight slides to the new tab.
  const pill = document.createElement("span");
  pill.className = "bnav-pill";
  pill.setAttribute("aria-hidden", "true");
  nav.insertBefore(pill, nav.firstChild);
  function placePill() {
    const active = nav.querySelector<HTMLElement>("[data-go].on");
    pill.hidden = !active;
    if (active) {
      pill.style.width = active.offsetWidth + "px";
      pill.style.transform = "translateX(" + active.offsetLeft + "px)";
    }
  }
  addEventListener("resize", placePill);
  function sync() {
    const current = currentView();
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
  const scrolls: { [view: string]: number } = {};
  addEventListener(
    "scroll",
    function () {
      scrolls[currentView()] = window.scrollY;
    },
    { passive: true },
  );
  function arrive(key: string) {
    const top = scrolls[key] || 0;
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
  // Contacts is a page in a frame. Opening a person there adds a history entry (window.__contact), so Back returns to
  // the list first.
  let contactEntry = false;
  function contactWindow() {
    const frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
    return frame && (frame.contentWindow as Window | null);
  }
  window.__contact = function (open: boolean) {
    if (open && !contactEntry && currentView() === "stats") {
      contactEntry = true;
      try {
        history.pushState({ contact: 1 }, "", location.href);
      } catch (e) {}
    } else if (!open && contactEntry) {
      contactEntry = false;
      skipPop = true;
      history.back();
    }
  };
  let homeView = "";
  let onTab = false;
  let restoring = false;
  function setUrl(url: string, key: string) {
    if (restoring) {
      return;
    }
    // Leaving Contacts with a person open: go back to the list and spend that person's history entry first.
    if (contactEntry && key !== "stats") {
      contactEntry = false;
      const contacts = contactWindow();
      if (contacts && contacts.__contactBack) {
        contacts.__contactBack();
      }
      skipPop = true;
      afterPop = function () {
        applyUrl(url, key);
      };
      history.back();
      return;
    }
    applyUrl(url, key);
  }
  function applyUrl(url: string, key: string) {
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
    const pay = new URLSearchParams(location.search).get("pay");
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
    // the phone sheet holds the page's contents while it's open, so close it first
    if (!byId("panel").hidden && byId("panel").contains(byId("revBody"))) {
      byId("pclose").click();
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
  function showCal(week: boolean) {
    byId("viewStats").hidden = true;
    byId("viewEnq").hidden = true;
    byId("viewPay").hidden = true;
    byId("viewRev").hidden = true;
    view(week);
    try {
      const url = new URL(location.href);
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
    const was = restoring;
    restoring = true;
    byId("tabCal").click();
    restoring = was;
    showCal(false);
  };
  nav.addEventListener("click", function (e) {
    const button = (e.target as Element).closest("[data-go]");
    if (!button) {
      return;
    }
    const target = button.getAttribute("data-go");
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
  const startView = new URLSearchParams(location.search).get("view");
  if (startView === "analytics") {
    setTimeout(showStats, 0);
  } else if (startView === "enquiries") {
    setTimeout(showEnq, 0);
  } else if (startView === "payments") {
    setTimeout(showPay, 0);
  } else if (startView === "revenue") {
    // phones open Revenue in the bottom sheet, as the ⋯ menu does
    setTimeout(function () {
      if (matchMedia("(max-width: 900px)").matches) {
        byId("mRev").click();
      } else {
        showRev();
      }
    }, 0);
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
  const searchButton = byId("qbtn");
  searchButton.onclick = function () {
    if (currentView() !== "stats") {
      return;
    }
    const frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
    const toggle = frame && frame.contentWindow?.__contactSearch;
    if (toggle) {
      const shown = !!toggle();
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
  const sheet = byId("panel");
  let sheetEntry = false;
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
      const next = afterPop;
      afterPop = null;
      if (next) {
        next();
      }
      return;
    }
    if (sheetEntry) {
      sheetEntry = false;
      byId("pclose").click();
      return;
    }
    if (contactEntry) {
      contactEntry = false;
      const contacts = contactWindow();
      if (contacts && contacts.__contactBack) {
        contacts.__contactBack();
      }
      return;
    }
    const shown = new URLSearchParams(location.search).get("view");
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
  const panel = byId("panel");
  new MutationObserver(function () {
    body.classList.toggle("sheet", !panel.hidden);
    panel.style.transform = "";
  }).observe(panel, {
    attributes: true,
    attributeFilter: ["hidden"],
  });
  // Drag the sheet down by its handle or title to close it, like a native sheet: it follows the finger, the page behind
  // brightens as it goes, and a quick flick closes it even when it has only moved a little.
  let dragFrom = 0;
  let dragBy = 0;
  let dragging = false;
  let lastY = 0;
  let lastT = 0;
  let speed = 0; // px per ms, downwards
  const back = byId("pback");
  panel.addEventListener(
    "touchstart",
    function (event: TouchEvent) {
      if (!matchMedia("(max-width:760px)").matches) {
        dragging = false;
        return;
      }
      const onHead = (event.target as Element).closest(".grab, .phead");
      const atTop = byId("pbody").scrollTop <= 0;
      dragging = !!onHead || (atTop && !(event.target as Element).closest("input, textarea, select, button"));
      dragFrom = lastY = event.touches[0].clientY;
      lastT = performance.now();
      dragBy = 0;
      speed = 0;
    },
    { passive: true },
  );
  panel.addEventListener(
    "touchmove",
    function (event: TouchEvent) {
      if (!dragging) {
        return;
      }
      const y = event.touches[0].clientY;
      const now = performance.now();
      if (now > lastT) {
        speed = speed * 0.2 + ((y - lastY) / (now - lastT)) * 0.8;
      }
      lastY = y;
      lastT = now;
      dragBy = Math.max(0, y - dragFrom);
      if (dragBy > 0) {
        // Stop iOS from also rubber-banding the sheet's scroll area, which pulls the content away from the
        // header and leaves a blank gap while the sheet moves.
        event.preventDefault();
      }
      if (dragBy > 4) {
        panel.style.transition = "none";
        panel.style.transform = "translateY(" + dragBy + "px)";
        back.style.transition = "none";
        back.style.opacity = String(Math.max(0, 1 - dragBy / panel.offsetHeight));
      }
    },
    { passive: false },
  );
  panel.addEventListener("touchend", function () {
    if (!dragging) {
      return;
    }
    dragging = false;
    // a flick counts only if the finger was still moving when it lifted
    const flick = speed > 0.5 && dragBy > 24 && performance.now() - lastT < 120;
    if (dragBy > 110 || flick) {
      // finish at the finger's speed: a fast flick closes quickly, a slow drag glides
      const rest = panel.offsetHeight - dragBy;
      const ms = Math.round(Math.min(260, Math.max(120, rest / Math.max(speed, 1.2))));
      panel.style.transition = "transform " + ms + "ms cubic-bezier(0.2, 0.7, 0.3, 1)";
      panel.style.transform = "translateY(100%)";
      back.style.transition = "opacity " + ms + "ms ease";
      back.style.opacity = "0";
      setTimeout(function () {
        byId("pclose").click();
        back.style.transition = "";
        back.style.opacity = "";
      }, ms);
    } else {
      panel.style.transition = "";
      panel.style.transform = "";
      back.style.transition = "opacity 0.2s ease";
      back.style.opacity = "";
    }
  });
}
