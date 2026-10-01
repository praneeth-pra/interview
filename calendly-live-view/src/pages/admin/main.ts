// The admin page: starts everything up, draws the calendar (week.ts, agenda.ts, summary.ts), switches tabs, keeps the
// live connection to /admin/stream and reloads after a deploy. Each panel and tab has its own module.
import { byId } from "./dom";
import { addDays, dayKeyOf, weekStart } from "./time";
import { freshReload, request } from "./api";
import { setupAlerts } from "./alerts";
import { setupThemeSwitch } from "./theme-switch";
import { setupDownloadMenu } from "./download-menu";
import { setupNav } from "./nav";
import { revenueShown, showRevenue } from "./revenue";
import { setupStatsFrame } from "./stats-frame";
import { boot, forget, remember, render, setRender, setState, state, view } from "./state";
import { closePanel, openPanel, panel } from "./panel";
import { showInterviewers } from "./interviewers";
import { showAdmins } from "./admins";
import { renderEnquiryBadge, setupEnquiries, showEnquiries } from "./enquiries";
import { refreshPayments, showPayments } from "./payments";
import { setupAllowlist, showCandidates, syncAllow } from "./allowlist";
import { forgetAllBookings, loadAllBookings } from "./bookings";
import { showBooking } from "./booking-panel";
import { renderWeek } from "./week";
import { renderAgenda, setupAgendaSwipe } from "./agenda";
import { renderAttention, renderCards, renderLegend } from "./summary";
import { setupSearch } from "./search";
import { setupPullRefresh } from "../shared/pull-refresh";
import type { State } from "./types";

let live = false; // connected to /admin/stream
let stream: EventSource | null = null;
const dateParam = new URLSearchParams(location.search).get("date");
if (/^\d{4}-\d{2}-\d{2}$/.test(dateParam || "")) {
  view.day = dateParam;
}
// The connection state shows only when something is wrong: "Offline" at once, "Reconnecting…" after 8 seconds.
let statusTimer = 0;
function renderStatus() {
  const status = byId("status");
  const offline = navigator.onLine === false;
  status.lastChild!.textContent = live ? "Live" : offline ? "Offline" : "Reconnecting…";
  clearTimeout(statusTimer);
  if (live) {
    status.className = "status live";
  } else if (offline) {
    status.className = "status bad";
  } else if (status.className.indexOf("bad") < 0) {
    statusTimer = window.setTimeout(function () {
      if (!live) {
        status.className = "status bad";
      }
    }, 8000);
  }
}
function drawAll() {
  renderEnquiryBadge();
  refreshPayments();
  view.week ||= weekStart(view.day || dayKeyOf(new Date()));
  renderStatus();
  if (state.ready) {
    byId("banner").hidden = true;
    renderCards();
    renderAttention();
    renderLegend();
    renderWeek();
    renderAgenda();
    if (panel.refresh && !byId("panel").hidden) {
      panel.refresh();
    }
  }
}
setRender(drawAll);
setupEnquiries();
setupSearch();
setupAllowlist();
function showTab(tab: string) {
  byId("viewCal").hidden = false;
  byId("tabCal").setAttribute("aria-selected", "true");
  history.replaceState(null, "", "/admin" + location.search);
  document.title = "Calendar · " + document.title.split(" · ").pop();
  if (tab === "allow") {
    showCandidates();
  }
}
byId("tabCal").onclick = function () {
  showTab("cal");
};
byId("mCand").onclick = showCandidates;
// Revenue on phones (owners only): the ⋯ menu opens it in the bottom sheet, like Candidates, rather than as a page.
// The desktop header tab still opens the page.
function showRevenueSheet() {
  // admins who aren't owners don't have Revenue
  if (byId("tabRev").hidden) {
    return;
  }
  panel.refresh = null;
  const body = openPanel("Revenue", "Confirmed payments over the last 12 months.");
  body.classList.add("rv");
  body.appendChild(byId("revBody").closest(".enqview")!);
  showRevenue();
}
byId("mRev").onclick = showRevenueSheet;
function connect() {
  if (stream) {
    stream.close();
  }
  stream = new EventSource("/admin/stream");
  stream.onopen = function () {
    live = true;
    renderStatus();
  };
  stream.addEventListener("state", function (event) {
    try {
      setState(JSON.parse(event.data));
    } catch {
      return;
    }
    remember(event.data);
    checkForUpdate();
    live = true;
    forgetAllBookings();
    render();
    syncAllow();
  });
  stream.addEventListener("tick", function () {
    if (!live) {
      live = true;
      renderStatus();
    }
  });
  stream.onerror = function () {
    live = false;
    renderStatus();
    fetch("/admin/api/state")
      .then(function (response) {
        if (response.status === 401) {
          freshReload();
        }
      })
      .catch(function () {});
    if (stream!.readyState === 2) {
      setTimeout(connect, 3000);
    }
  };
}
byId("prev").onclick = function () {
  view.week = addDays(view.week!, -7);
  view.day = null;
  render();
};
byId("next").onclick = function () {
  view.week = addDays(view.week!, 7);
  view.day = null;
  render();
};
setupAgendaSwipe();
byId("today").onclick = function () {
  view.day = dayKeyOf(new Date());
  view.week = weekStart(view.day);
  byId("week").textContent = "";
  render();
};
// On a phone, opening the Agenda brings the time now, or else the day's first interview, into view when it's further
// down. Desktops open it at the top like every other section, so switching tabs never moves the page.
byId("tabAg").addEventListener("click", function () {
  if (innerWidth > 760) {
    return;
  }
  // before the first frame, so the page doesn't show at the top and then jump
  requestAnimationFrame(function () {
    const mark = document.querySelector("#agenda .ag-now") || document.querySelector("#agenda .ag-i");
    if (mark && mark.getBoundingClientRect().top > innerHeight * 0.6) {
      scrollTo(0, scrollY + mark.getBoundingClientRect().top - innerHeight / 2);
    }
  });
});
// The week grid only scrolls to today when drawn fresh while visible, so redraw it when the phone's Calendar tab shows it.
document.querySelector(".bnav [data-go=cal]")!.addEventListener("click", function () {
  setTimeout(function () {
    byId("week").textContent = "";
    render();
  });
});
byId("pick").onchange = function () {
  if ((this as HTMLInputElement).value) {
    view.day = (this as HTMLInputElement).value;
    view.week = weekStart(view.day);
    render();
  }
};
byId("mIv").onclick = showInterviewers;
byId("pclose").onclick = closePanel;
byId("pback").onclick = closePanel;
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !byId("panel").hidden) {
    closePanel();
  }
});
// The latest bookings from the server, asked for directly rather than waiting on the live connection, which is
// reopened if it dropped.
function fetchState() {
  if (!stream || stream.readyState === 2 || !live) {
    connect();
  }
  return request<State>("/admin/api/state")
    .then(function (fresh) {
      setState(fresh);
      remember(JSON.stringify(fresh));
      forgetAllBookings();
      render();
      syncAllow();
      checkForUpdate();
    })
    .catch(function () {});
}
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") {
    fetchState();
  }
});
// Pull down from the top of the page on a phone to refresh the tab on screen in place: the bookings always, plus the
// Enquiries, Payments or Revenue list when that's the tab, or the Contacts frame. The data comes from the API, which the
// service worker never saves, so it's always fresh. A new build found on the way reloads the page (checkForUpdate).
setupPullRefresh({
  refresh: function () {
    const work: Promise<unknown>[] = [fetchState()];
    if (!byId("viewEnq").hidden) {
      work.push(showEnquiries(true));
    } else if (!byId("viewPay").hidden) {
      work.push(showPayments(true));
    } else if (revenueShown()) {
      work.push(showRevenue());
    } else if (!byId("viewStats").hidden) {
      const frame = document.querySelector<HTMLIFrameElement>("iframe.la-frame");
      const contacts = frame && frame.contentWindow && frame.contentWindow.__contactRefresh;
      if (contacts) {
        work.push(contacts());
      }
    }
    return Promise.all(work);
  },
  top: function () {
    return document.querySelector(".top")!.getBoundingClientRect().bottom;
  },
  // the sheets and the ⋯ menu have their own swipe down
  blocked: function (target) {
    const classes = document.body.classList;
    return (
      classes.contains("sheet") || classes.contains("pp-open") || classes.contains("dm-open") || !!target.closest("#panel, .dlmenu, .bnav")
    );
  },
  surface: "var(--card)",
  color: "var(--blue)",
});
window.__enq = showEnquiries;
window.__pay = showPayments;
window.__rev = showRevenue;
// leaving the tab brings the count back for anything new
new MutationObserver(renderEnquiryBadge).observe(byId("viewEnq"), { attributes: true, attributeFilter: ["hidden"] });
if (boot.login) {
  byId("mAdm").hidden = false;
  byId("mAdm").onclick = showAdmins;
  byId("mOut").hidden = false;
  byId("mOut").onclick = function () {
    forget();
    fetch("/admin/logout", {
      method: "POST",
    }).then(function () {
      location.href = "/admin";
    });
  };
}
setInterval(render, 60000);
addEventListener("online", renderStatus);
addEventListener("offline", renderStatus);
window.__openB = function (id) {
  loadAllBookings().then(function () {
    showBooking(id);
  });
};
// After a deploy the server restarts, and a phone that kept the app open reconnects to it with the old page still
// showing. When the live state reports a different build, reload: straight away if nothing is open, otherwise the next
// time the app comes back to the foreground or the sheet closes. Once per build, so a stale offline copy can't loop.
let updateWaiting = false;
function checkForUpdate() {
  if (!state.build || !boot.build || state.build === boot.build) {
    return;
  }
  try {
    if (sessionStorage.getItem("adm.reloaded") === state.build) {
      return;
    }
  } catch (e) {}
  updateWaiting = true;
  const busy =
    !byId("panel").hidden ||
    document.body.classList.contains("pp-open") ||
    /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
  if (document.visibilityState === "hidden" || !busy) {
    try {
      sessionStorage.setItem("adm.reloaded", state.build);
    } catch (e) {}
    freshReload();
  }
}
document.addEventListener("visibilitychange", function () {
  if (updateWaiting && document.visibilityState === "visible") {
    checkForUpdate();
  }
});
new MutationObserver(function () {
  if (updateWaiting && byId("panel").hidden) {
    checkForUpdate();
  }
}).observe(byId("panel"), { attributes: true, attributeFilter: ["hidden"] });
showTab(boot.tab);
render();
connect();
// The service worker keeps the app openable offline; alerts.ts reuses the same registration for push.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(function () {});
}

setupAlerts();
setupNav();
setupStatsFrame();
setupDownloadMenu();
setupThemeSwitch();
