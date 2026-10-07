// Contacts (the Contacts tab of the admin page, loaded in a frame): everyone who has booked, the latest activity
// first, and a page per contact with their Activity (every interview, reschedule and cancellation) and About
// (emails, bookings, interviews taken by each interviewer). Sections, in order: DOM and date helpers, the live state,
// the contacts list, then the contact page.
import { byId, el as make } from "../shared/dom";
import { setupPullRefresh } from "../shared/pull-refresh";
import { api, type Analytics, type DashState, type IvInfo, type Person, type TimelineEvent } from "./api";

// the open contact's page, and a counter so only the latest request draws it
let data: Analytics | null = null;
let loadSeq = 0;

function div(cls?: string | null, text?: string | null) {
  return el("div", cls, text);
}
function span(cls?: string | null, text?: string | null) {
  return el("span", cls, text);
}
let state: DashState = {
  ready: false,
  events: [],
  tz: "Asia/Kolkata",
  host: "",
  error: "",
  lastChecked: 0,
};
let live = false;
let lastSeen = 0;
let merge = true;
function mergeQuery() {
  if (merge) {
    return "&merge=1";
  } else {
    return "";
  }
}
let ivMap: Record<string, string> = {};
let ivNames: string[] = [];
let ivSig = "";
function ivSigOf(info: IvInfo) {
  return JSON.stringify(info.assign || {}) + "|" + JSON.stringify(info.names || []) + "|" + (info.persistent !== false);
}
function loadIv() {
  return api("/api/interviewers")
    .then((response) => response.json())
    .then((info) => {
      const signature = ivSigOf(info);
      ivMap = info.assign || {};
      ivNames = info.names || [];
      if (signature !== ivSig) {
        ivSig = signature;
        if (typeof onIv == "function") {
          onIv();
        }
      }
    })
    .catch(() => {});
}
function ivCls(name: string) {
  let index = ivNames.indexOf(name);
  if (index < 0) {
    index = 0;
    for (let i = 0; i < name.length; i++) {
      index += name.charCodeAt(i);
    }
  }
  return "ivc" + (index % 6);
}
// el(tag, class, text): this page's shorthand for the shared el()
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  return make(tag, { class: cls || null, text: text });
}
function fmt(options: Intl.DateTimeFormatOptions, date: Date | number) {
  return new Intl.DateTimeFormat(
    "en-US",
    Object.assign(
      {
        timeZone: state.tz,
      },
      options,
    ),
  ).format(date);
}
function ymd(date: Date | number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: state.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function t12(date: Date | number) {
  return fmt(
    {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    },
    date,
  )
    .replace(" AM", "am")
    .replace(" PM", "pm");
}
function niceName(name: string) {
  if (name === name.toLowerCase() && name !== name.toUpperCase()) {
    return name.replace(/(^|[\s\-'])(\p{L})/gu, (_match: string, before: string, letter: string) => before + letter.toUpperCase());
  } else {
    return name;
  }
}
function paintStatus() {
  const status = byId("status");
  const text = byId("statusText");
  status.className = "status" + (live && !state.error ? " live" : "");
  if (live) {
    if (lastSeen) {
      const seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
      text.textContent = "Live · checked " + (seconds < 60 ? seconds + "s" : Math.round(seconds / 60) + "m") + " ago";
    } else {
      text.textContent = "Live";
    }
  } else {
    text.textContent = "Reconnecting…";
  }
}
function paintBanner() {
  const message = state.error || (state.ready ? "" : "Loading bookings…");
  const banner = byId("banner");
  banner.textContent = message;
  banner.hidden = !message;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadIv();
    connect();
  }
});
setInterval(paintStatus, 5000);
setInterval(() => {
  loadIv();
  if (state.ready) {
    render();
  }
}, 60000);
loadIv();
let people: Person[] = [];
// the contact on screen; name and event come from the list, or from the page when it opened by itself
let chosen: { name: string; event: string } | null = null;
let peopleLoaded = false;
let peopleKey = "";
function words(text: string) {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}
function chosenName() {
  if (chosen && chosen.name) {
    return niceName(chosen.name);
  } else {
    return "";
  }
}
function loadPeople() {
  return api("/api/people" + (merge ? "?merge=1" : ""))
    .then((response) => response.json())
    .then((list) => {
      people = Array.isArray(list) ? list : [];
      peopleLoaded = true;
      renderPeople();
    })
    .catch(() => {
      peopleLoaded = true;
      renderPeople();
    });
}
function syncPeople() {
  const key = state.events.length + ":" + state.events.map((event) => event.invitee).join("|");
  if (state.ready && key !== peopleKey) {
    peopleKey = key;
    loadPeople();
  }
}
function skelRows(count: number, label: string) {
  const box = el("div");
  const msg = div("rempty");
  msg.appendChild(span("spin"));
  msg.appendChild(document.createTextNode(label));
  box.appendChild(msg);
  for (let i = 0; i < count; i++) {
    const row = div("rrow skel-rrow");
    row.appendChild(div("skel sk-line sk-w" + ((i % 3) + 1)));
    box.appendChild(row);
  }
  return box;
}
// ---- Contacts: everyone who has booked, the latest activity first (like the Calendly app's Contacts) ----
const SORTS = [
  ["recent", "All contacts", "Sorted by recent activity"],
  ["upcoming", "Upcoming", "Next meeting first"],
  ["name", "All contacts", "Sorted by name"],
];
let sortMode = "recent";
try {
  sortMode = localStorage.getItem("ct.sort") || "recent";
} catch (error) {}
let homeScroll = 0;
function initials(name: string) {
  const parts = niceName(String(name || "?"))
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
}
// "Today at 3:00pm", "Thursday at 3:00pm", "Last Friday at 12:00pm", "Sep 12 at 11:00am"
function meetingWhen(iso: string, now: number) {
  const date = new Date(iso);
  const days = dayNum(ymd(date)) - dayNum(ymd(new Date(now)));
  const label =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : days === -1
          ? "Yesterday"
          : Math.abs(days) < 7
            ? fmt({ weekday: "long" }, date)
            : days > -14 && days < 0
              ? "Last " + fmt({ weekday: "long" }, date)
              : fmt({ day: "numeric", month: "short" }, date);
  return label + " at " + t12(date);
}
// "now", "5h", "2d", "1w", "3mo"
function agoShort(iso: string, now: number) {
  const minutes = Math.max(0, (now - Date.parse(iso)) / 60000);
  if (minutes < 60) {
    return "now";
  } else if (minutes < 1440) {
    return Math.floor(minutes / 60) + "h";
  } else if (minutes < 1440 * 7) {
    return Math.floor(minutes / 1440) + "d";
  } else if (minutes < 1440 * 35) {
    return Math.floor(minutes / 10080) + "w";
  } else {
    return Math.floor(minutes / 43200) + "mo";
  }
}
const CAL_ICON = "M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4";
function svgIcon(path: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", path);
  svg.appendChild(line);
  return svg;
}
function sortedPeople(list: Person[]) {
  const copy = list.slice();
  if (sortMode === "name") {
    copy.sort((first, second) => niceName(first.name).localeCompare(niceName(second.name)));
  } else if (sortMode === "upcoming") {
    copy.sort((first, second) => {
      if (!!first.next !== !!second.next) {
        return first.next ? -1 : 1;
      }
      // no activity is "", which falls back to 0 as before
      return first.next
        ? Date.parse(first.next) - Date.parse(second.next)
        : Date.parse((second.activity || 0) as string) - Date.parse((first.activity || 0) as string);
    });
  } else {
    copy.sort((first, second) => Date.parse(second.activity || second.last) - Date.parse(first.activity || first.last));
  }
  return copy;
}
function paintSort() {
  const mode = SORTS.filter((entry) => entry[0] === sortMode)[0] || SORTS[0];
  byId("csortt").textContent = mode[1];
  byId("csortl").textContent = mode[2];
}
function renderPeople() {
  const box = byId("clist");
  paintSort();
  box.textContent = "";
  if (!peopleLoaded) {
    box.appendChild(skelRows(5, "Loading contacts…"));
    return;
  }
  const terms = words(byId<HTMLInputElement>("pq").value.trim());
  const now = Date.now();
  const shown = sortedPeople(people).filter((person) => {
    const text = (person.name + " " + niceName(person.name) + " " + (person.companies_ || "")).toLowerCase();
    return terms.every((term) => text.indexOf(term) >= 0);
  });
  if (!shown.length) {
    box.appendChild(div("rempty", people.length ? "No one matches your search." : "No contacts yet. People appear here once they book."));
    return;
  }
  shown.slice(0, 300).forEach((person) => {
    const row = el("button", "crow");
    row.type = "button";
    row.appendChild(span("cav", initials(person.name)));
    const main = div("cmain");
    const top = div("cline");
    top.appendChild(el("b", null, niceName(person.name)));
    top.appendChild(span("cago", person.activity ? agoShort(person.activity, now) : ""));
    main.appendChild(top);
    const meta = div("cmeta");
    meta.appendChild(svgIcon(CAL_ICON));
    meta.appendChild(
      span(
        null,
        person.next
          ? "Next meeting: " + meetingWhen(person.next, now)
          : person.past
            ? "Last meeting: " + meetingWhen(person.past, now)
            : person.count + (person.count === 1 ? " booking" : " bookings"),
      ),
    );
    main.appendChild(meta);
    row.appendChild(main);
    row.addEventListener("click", () => {
      choose(person);
    });
    box.appendChild(row);
  });
}
function choose(person: Person) {
  chosen = person;
  loadAnalytics(person.event);
}
// home ⇄ contact page
function slide(el: HTMLElement, name: string) {
  el.classList.remove("push-in", "pop-in");
  if (name) {
    void el.offsetWidth;
    el.classList.add(name);
  }
}
function showDetail() {
  const fromList = !byId("home").hidden;
  if (fromList) {
    homeScroll = window.scrollY;
  }
  byId("home").hidden = true;
  byId("an").hidden = false;
  slide(byId("an"), fromList ? "push-in" : "");
  window.scrollTo(0, 0);
  tellAdmin(true);
}
// In the admin, the page around this frame keeps a history entry while a person is open, so the phone's Back returns here.
function tellAdmin(open: boolean) {
  const host = window.parent;
  if (host && host !== window && host.__contact) {
    host.__contact(open);
  }
}
window.__contactBack = () => {
  if (!byId("an").hidden) {
    showHome();
  }
};
// In the iPhone home-screen app there is no browser swipe back, so a swipe from the left edge of a person's page drags
// it to the right, showing the list underneath, and lets go to go back (or springs back if it didn't go far). Safari and
// Android have their own edge swipe for Back, which already returns to the list.
(() => {
  if (navigator.standalone !== true) {
    return;
  }
  const page = byId("an");
  const list = byId("home");
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let lastX = 0;
  let lastT = 0;
  let speed = 0;
  let state = 0; // 0 idle, 1 edge touch not decided, 2 dragging
  function clear() {
    document.body.classList.remove("edge");
    page.style.transition = page.style.transform = "";
    list.style.transition = list.style.transform = list.style.opacity = list.style.top = "";
  }
  document.addEventListener(
    "touchstart",
    (event) => {
      const x = event.touches[0].clientX;
      state = !page.hidden && x < 24 && innerWidth <= 700 ? 1 : 0;
      startX = lastX = x;
      startY = event.touches[0].clientY;
      lastT = performance.now();
      dx = speed = 0;
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!state) {
        return;
      }
      const x = event.touches[0].clientX;
      if (state === 1) {
        const my = Math.abs(event.touches[0].clientY - startY);
        if (x - startX < 10 && my < 10) {
          return;
        }
        if (x - startX < my) {
          state = 0;
          return;
        }
        state = 2;
        // the list sits underneath at the place it was left
        list.style.top = page.offsetTop - homeScroll + "px";
        document.body.classList.add("edge");
      }
      event.preventDefault();
      const now = performance.now();
      if (now > lastT) {
        speed = speed * 0.2 + ((x - lastX) / (now - lastT)) * 0.8;
      }
      lastX = x;
      lastT = now;
      dx = Math.max(0, x - startX);
      const part = dx / innerWidth;
      page.style.transition = list.style.transition = "none";
      page.style.transform = "translateX(" + dx + "px)";
      list.style.transform = "translateX(" + (-24 + 24 * part) + "%)";
      list.style.opacity = String(0.6 + 0.4 * part);
    },
    { passive: false },
  );
  function end() {
    if (state !== 2) {
      state = 0;
      return;
    }
    state = 0;
    const go = dx > innerWidth * 0.35 || (speed > 0.4 && dx > 30 && performance.now() - lastT < 120);
    const ease = "0.22s cubic-bezier(0.2, 0.8, 0.2, 1)";
    page.style.transition = "transform " + ease;
    list.style.transition = "transform " + ease + ", opacity " + ease;
    page.style.transform = go ? "translateX(100%)" : "";
    list.style.transform = go ? "translateX(0)" : "translateX(-24%)";
    list.style.opacity = go ? "1" : "0.6";
    setTimeout(() => {
      clear();
      if (go) {
        showHome(true);
      }
    }, 220);
  }
  document.addEventListener("touchend", end);
  document.addEventListener("touchcancel", end);
})();
function showHome(swiped?: boolean) {
  tellAdmin(false);
  const fromPerson = !byId("an").hidden;
  byId("an").hidden = true;
  byId("home").hidden = false;
  slide(byId("home"), fromPerson && !swiped ? "pop-in" : "");
  chosen = null;
  data = null;
  loadSeq++;
  renderPeople();
  window.scrollTo(0, homeScroll);
}
function setTab(name: string) {
  [
    ["tabAct", "tpAct", "act"],
    ["tabAbout", "tpAbout", "about"],
  ].forEach((entry) => {
    const on = entry[2] === name;
    byId(entry[0]).setAttribute("aria-selected", String(on));
    byId(entry[1]).hidden = !on;
  });
  // the company search only filters Activity
  byId("asq").hidden = name !== "act";
}
byId<HTMLInputElement>("pq").addEventListener("input", () => {
  renderPeople();
});
byId<HTMLInputElement>("asq").addEventListener("input", () => {
  if (data) {
    renderActivity(data.events, Date.now());
  }
});
// On phones the search field is hidden until the search button in the admin header asks for it; returns whether
// it is now shown.
window.__contactSearch = () => {
  const field = byId<HTMLInputElement>("pq");
  const show = !document.body.classList.contains("cq") || !byId("an").hidden;
  document.body.classList.toggle("cq", show);
  if (!byId("an").hidden) {
    showHome();
  }
  if (show) {
    window.scrollTo(0, 0);
    field.focus();
  } else if (field.value) {
    field.value = "";
    renderPeople();
  }
  return show;
};
byId("csort").addEventListener("click", () => {
  const index = SORTS.map((entry) => entry[0]).indexOf(sortMode);
  sortMode = SORTS[(index + 1) % SORTS.length][0];
  try {
    localStorage.setItem("ct.sort", sortMode);
  } catch (error) {}
  renderPeople();
});
byId("back").addEventListener("click", () => showHome());
byId("tabAct").addEventListener("click", () => setTab("act"));
byId("tabAbout").addEventListener("click", () => setTab("about"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("an").hidden) {
    showHome();
  }
});
const DAY = 86400000;
function dayNum(day: string) {
  return Date.parse(day + "T00:00:00Z") / DAY;
}
function evState(event: TimelineEvent, now: number) {
  if (event.status === "canceled") {
    if (event.rescheduled) {
      return "rescheduled";
    } else {
      return "canceled";
    }
  } else if (event.noShow) {
    return "noshow";
  } else if (Date.parse(event.end) > now) {
    return "upcoming";
  } else {
    return "done";
  }
}
function loadAnalytics(eventId: string) {
  const requestId = ++loadSeq;
  data = null;
  showDetail();
  ["tpAct", "tpAbout"].forEach((id) => {
    byId(id).textContent = "";
  });
  byId("aemail").hidden = true;
  byId("acopy").hidden = true;
  byId<HTMLInputElement>("asq").value = "";
  byId("aname").textContent = chosenName();
  byId("av").textContent = initials(chosenName());
  byId("asub").textContent = "Loading…";
  api("/api/analytics?event=" + encodeURIComponent(eventId) + mergeQuery())
    .then((response) => response.json().then((json) => ({ ok: response.ok, j: json })))
    .then((reply) => {
      if (requestId === loadSeq) {
        if (!reply.ok) {
          byId("asub").textContent = (reply.j && reply.j.error) || "Couldn't load this contact.";
          return;
        }
        data = reply.j;
        if (chosen) {
          chosen.name ||= data!.name;
        } else {
          chosen = { name: data!.name, event: eventId };
        }
        renderAnalysis();
      }
    })
    .catch(() => {
      if (requestId === loadSeq) {
        byId("asub").textContent = "Couldn't load this contact. Check your connection and try again.";
      }
    });
}
// Pull to refresh: the list, and the open contact's page, fetched again and redrawn without clearing them first.
function refreshContact() {
  if (!chosen || byId("an").hidden) {
    return Promise.resolve();
  }
  const eventId = chosen.event;
  const requestId = loadSeq;
  return api("/api/analytics?event=" + encodeURIComponent(eventId) + mergeQuery())
    .then((response) => (response.ok ? response.json() : null))
    .then((fresh) => {
      if (fresh && requestId === loadSeq && chosen && chosen.event === eventId) {
        data = fresh;
        renderAnalysis();
      }
    })
    .catch(() => {});
}
function refreshAll() {
  return Promise.all([connect(), loadPeople(), loadIv(), refreshContact()]);
}
window.__contactRefresh = refreshAll;
// The admin's booking sheet opens a person here: straight to their page, with no slide in from the list.
window.__contactOpen = (eventId: string) => {
  if (!byId("home").hidden) {
    homeScroll = window.scrollY;
    byId("home").hidden = true;
  }
  chosen = { name: "", event: eventId };
  loadAnalytics(eventId);
};
setupPullRefresh({
  refresh: refreshAll,
  top: () => 0,
  // a person's page being swiped back to the list
  blocked: () => document.body.classList.contains("edge"),
  surface: "var(--c)",
  color: "var(--m)",
});
// interviewer names changed: redraw the open contact
function onIv() {
  if (data) {
    renderAnalysis();
  }
}
function openBooking(id: string) {
  const host = window.parent;
  if (host && host !== window && host.__openB) {
    host.__openB(id);
  }
}
const canOpenBooking = (() => {
  try {
    return window.parent !== window && !!window.parent.__openB;
  } catch (error) {
    return false;
  }
})();
// ---- Activity: every interview, reschedule and cancellation, newest first, grouped by day ----
function renderActivity(events: TimelineEvent[], now: number) {
  const box = byId("tpAct");
  box.textContent = "";
  const query = byId<HTMLInputElement>("asq").value.trim();
  const terms = words(query);
  const list = events
    .filter((event) => {
      const text = ((event.company || "") + " " + (event.round || "")).toLowerCase();
      return terms.every((term) => text.indexOf(term) >= 0);
    })
    .sort((first, second) => Date.parse(second.start) - Date.parse(first.start));
  if (!list.length) {
    box.appendChild(div("rempty", terms.length ? "No interviews match \u201c" + query + "\u201d." : "No activity yet."));
    return;
  }
  let lastDay = "";
  list.forEach((event) => {
    const start = new Date(event.start);
    const day = ymd(start);
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(div("aday", fmt({ weekday: "long", day: "numeric", month: "short" }, start)));
    }
    const kind = evState(event, now);
    const bookingId = event.rescheduled ? String(event.id).replace(/-moved$/, "") : event.id;
    const moved = event.rescheduled ? events.filter((other) => other.id === bookingId)[0] : null;
    const what =
      kind === "upcoming"
        ? "Upcoming interview"
        : kind === "done"
          ? "You had an interview"
          : kind === "noshow"
            ? event.missed === "other"
              ? "Didn't happen"
              : "No-show"
            : kind === "rescheduled"
              ? "Rescheduled" + (moved ? " to " + fmt({ weekday: "short", day: "numeric", month: "short" }, new Date(moved.start)) : "")
              : "Canceled" + (event.canceledBy === "invitee" ? " by the candidate" : event.canceledBy === "host" ? " by you" : "");
    const item = div("aitem " + kind);
    const head = div("ahead2");
    head.appendChild(svgIcon(CAL_ICON));
    head.appendChild(span("awhat", what));
    head.appendChild(span("atime", t12(start)));
    item.appendChild(head);
    const interviewer = ivMap[bookingId];
    const cardEl = el(canOpenBooking ? "button" : "div", "acard " + (interviewer ? ivCls(interviewer) : "none"));
    if (canOpenBooking) {
      (cardEl as HTMLButtonElement).type = "button";
      cardEl.addEventListener("click", () => openBooking(bookingId));
    }
    cardEl.appendChild(el("b", null, [event.company, event.round].filter(Boolean).join(" · ") || "Interview"));
    const minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
    cardEl.appendChild(
      div(
        "sub",
        minutes +
          "m" +
          (interviewer ? " · " + interviewer : kind === "done" ? " · Support not recorded" : "") +
          (event.cancelReason ? " · " + event.cancelReason : ""),
      ),
    );
    cardEl.appendChild(div("sub", t12(start) + " – " + t12(new Date(event.end))));
    item.appendChild(cardEl);
    box.appendChild(item);
  });
}
// ---- About: emails, first booking, totals, and combining people with the same name ----
function renderAbout(events: TimelineEvent[], now: number) {
  const box = byId("tpAbout");
  box.textContent = "";
  const group = div("agroup");
  function line(label: string, value: string) {
    const row = div("arow");
    row.appendChild(span("alabel", label));
    row.appendChild(el("b", null, value));
    group.appendChild(row);
  }
  (data!.emailList || []).forEach((email, index) => {
    line(index ? "Also" : "Email", email);
  });
  const created = events
    .map((event) => Date.parse(event.created || event.start))
    .filter((time) => !isNaN(time))
    .sort((first, second) => first - second)[0];
  if (created) {
    line("First booked", fmt({ day: "numeric", month: "short", year: "numeric" }, new Date(created)));
  }
  const real = events.filter((event) => !event.rescheduled);
  line("Bookings", real.length + " (" + real.filter((event) => event.status === "canceled").length + " canceled)");
  box.appendChild(group);
  // how many of this candidate's interviews each interviewer took
  const taken: Record<string, number> = {};
  let notRecorded = 0;
  events.forEach((event) => {
    if (event.status === "active" && !event.noShow && Date.parse(event.end) <= now) {
      const interviewer = ivMap[event.id];
      if (interviewer) {
        taken[interviewer] = (taken[interviewer] || 0) + 1;
      } else {
        notRecorded++;
      }
    }
  });
  const names = Object.keys(taken).sort((first, second) => taken[second] - taken[first] || (first < second ? -1 : 1));
  if (names.length || notRecorded) {
    box.appendChild(div("ahead3", "Interview support given"));
    const ivGroup = div("agroup");
    names.forEach((name) => {
      const row = div("arow");
      const label = span("alabel ivn " + ivCls(name), name);
      row.appendChild(label);
      row.appendChild(el("b", null, taken[name] + (taken[name] === 1 ? " interview" : " interviews")));
      ivGroup.appendChild(row);
    });
    if (notRecorded) {
      const missing = div("arow");
      missing.appendChild(span("alabel", "Not recorded"));
      missing.appendChild(el("b", null, String(notRecorded)));
      ivGroup.appendChild(missing);
    }
    box.appendChild(ivGroup);
  }
  if (data!.emails > 1 || !merge) {
    const note = div("anote");
    note.appendChild(
      document.createTextNode(
        data!.emails > 1
          ? "Bookings from " + data!.emails + " email addresses with the same name are shown as one person. "
          : "Showing this email address only. ",
      ),
    );
    const button = el("button", "linkbtn", data!.emails > 1 ? "Show separately" : "Combine again");
    button.addEventListener("click", () => {
      setMerge(!merge || data!.emails <= 1);
    });
    note.appendChild(button);
    box.appendChild(note);
  }
}
// ---- Analytics: what needs doing, then the numbers that matter to an interviewer ----
function renderAnalysis() {
  if (data) {
    const events = data.events;
    const now = Date.now();
    byId("aname").textContent = niceName(data.name);
    byId("av").textContent = initials(data.name);
    const upcoming = events
      .filter((event) => event.status === "active" && Date.parse(event.end) > now)
      .sort((first, second) => Date.parse(first.start) - Date.parse(second.start))[0];
    byId("asub").textContent = upcoming ? "Next meeting: " + meetingWhen(upcoming.start, now) : "No upcoming meetings";
    const firstEmail = (data.emailList || [])[0] || "";
    const mail = byId<HTMLAnchorElement>("aemail");
    mail.href = "mailto:" + firstEmail;
    mail.hidden = !firstEmail;
    byId("acopy").hidden = !firstEmail;
    renderActivity(events, now);
    renderAbout(events, now);
  }
}
function render() {
  paintBanner();
  paintStatus();
  // the open contact too: "Next meeting: Today at 3:00pm" and upcoming/done depend on the time now
  if (data) {
    renderAnalysis();
  }
  renderPeople();
  syncPeople();
}
function setMerge(on: boolean) {
  merge = on;
  loadPeople();
  if (chosen) {
    loadAnalytics(chosen.event);
  }
}
byId("acopy").onclick = () => {
  const email = data && data.emailList && data.emailList[0];
  const label = byId("acopy").querySelector("span")!;
  if (email && navigator.clipboard) {
    navigator.clipboard.writeText(email).then(() => {
      label.textContent = "Copied";
      setTimeout(() => {
        label.textContent = "Copy";
      }, 1500);
    });
  }
};
const eventParam = new URLSearchParams(location.search).get("event");
if (eventParam && /^[0-9a-f-]{36}$/i.test(eventParam)) {
  chosen = {
    name: "",
    event: eventParam,
  };
  loadAnalytics(eventParam);
}
loadPeople();
connect();
function connect() {
  return api("/api/state")
    .then(function (response) {
      return response.json();
    })
    .then(function (fresh) {
      state = fresh;
      live = true;
      lastSeen = Date.now();
      render();
    })
    .catch(function () {
      live = false;
      paintStatus();
    });
}
setInterval(function () {
  if (document.visibilityState === "visible") {
    connect();
  }
}, 60000);
