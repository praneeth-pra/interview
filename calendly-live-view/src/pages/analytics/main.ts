// Contacts (the Contacts tab of the admin page, loaded in a frame): everyone who has booked, the latest activity
// first, and a page per contact with their Activity (every interview, reschedule and cancellation) and About
// (emails, bookings, interviews taken by each interviewer). Sections, in order: DOM and date helpers, the live state,
// the contacts list, then the contact page.
import { api } from "./api";

function div(cls?: string | null, text?: string | null) {
  return el("div", cls, text);
}
function span(cls?: string | null, text?: string | null) {
  return el("span", cls, text);
}
var state = {
  ready: false,
  events: [],
  tz: "Asia/Kolkata",
  host: "",
  error: "",
  lastChecked: 0,
};
var live = false;
var stream = null;
var lastSeen = 0;
var merge = true;
function mergeQuery() {
  if (merge) {
    return "&merge=1";
  } else {
    return "";
  }
}
var ivMap = {};
var ivNames = [];
var ivSig = "";
function ivSigOf(info) {
  return JSON.stringify(info.assign || {}) + "|" + JSON.stringify(info.names || []) + "|" + (info.persistent !== false);
}
function loadIv() {
  api("/api/interviewers")
    .then((response) => response.json())
    .then((info) => {
      var signature = ivSigOf(info);
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
function ivCls(name) {
  var index = ivNames.indexOf(name);
  if (index < 0) {
    index = 0;
    for (var i = 0; i < name.length; i++) {
      index += name.charCodeAt(i);
    }
  }
  return "ivc" + (index % 6);
}
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string | null): HTMLElementTagNameMap[K] {
  var node = document.createElement(tag);
  if (cls) {
    node.className = cls;
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
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
function ymd(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: state.tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
function t12(date) {
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
function niceName(name) {
  if (name === name.toLowerCase() && name !== name.toUpperCase()) {
    return name.replace(/(^|[\s\-'])(\p{L})/gu, (match, before, letter) => before + letter.toUpperCase());
  } else {
    return name;
  }
}
function paintStatus() {
  var status = byId("status");
  var text = byId("statusText");
  status.className = "status" + (live && !state.error ? " live" : "");
  if (live) {
    if (lastSeen) {
      var seconds = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
      text.textContent = "Live · checked " + (seconds < 60 ? seconds + "s" : Math.round(seconds / 60) + "m") + " ago";
    } else {
      text.textContent = "Live";
    }
  } else {
    text.textContent = "Reconnecting…";
  }
}
function paintBanner() {
  var message = state.error || (state.ready ? "" : "Loading bookings…");
  var banner = byId("banner");
  banner.textContent = message;
  banner.hidden = !message;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadIv();
    api("/api/state")
      .then((response) => response.json())
      .then((fresh) => {
        state = fresh;
        lastSeen = Date.now();
        render();
      })
      .catch(() => {});
    if (!stream || stream.readyState === 2) {
      connect();
    }
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
var people = [];
var chosen = null;
var peopleLoaded = false;
var peopleKey = "";
function words(text) {
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
  api("/api/people" + (merge ? "?merge=1" : ""))
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
  var key = state.events.length + ":" + state.events.map((event) => event.invitee).join("|");
  if (state.ready && key !== peopleKey) {
    peopleKey = key;
    loadPeople();
  }
}
function skelRows(count, label) {
  var box = el("div");
  var msg = div("rempty");
  msg.appendChild(span("spin"));
  msg.appendChild(document.createTextNode(label));
  box.appendChild(msg);
  for (var i = 0; i < count; i++) {
    var row = div("rrow skel-rrow");
    row.appendChild(div("skel sk-line sk-w" + ((i % 3) + 1)));
    box.appendChild(row);
  }
  return box;
}
// ---- Contacts: everyone who has booked, the latest activity first (like the Calendly app's Contacts) ----
var SORTS = [
  ["recent", "All contacts", "Sorted by recent activity"],
  ["upcoming", "Upcoming", "Next meeting first"],
  ["name", "All contacts", "Sorted by name"],
];
var sortMode = "recent";
try {
  sortMode = localStorage.getItem("ct.sort") || "recent";
} catch (error) {}
var homeScroll = 0;
function initials(name) {
  var parts = niceName(String(name || "?")).trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?").charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : "")).toUpperCase();
}
// "Today at 3:00pm", "Thursday at 3:00pm", "Last Friday at 12:00pm", "Sep 12 at 11:00am"
function meetingWhen(iso, now) {
  var date = new Date(iso);
  var days = dayNum(ymd(date)) - dayNum(ymd(new Date(now)));
  var label =
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
function agoShort(iso, now) {
  var minutes = Math.max(0, (now - Date.parse(iso)) / 60000);
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
var CAL_ICON = "M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4";
function svgIcon(path) {
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  var line = document.createElementNS("http://www.w3.org/2000/svg", "path");
  line.setAttribute("d", path);
  svg.appendChild(line);
  return svg;
}
function sortedPeople(list) {
  var copy = list.slice();
  if (sortMode === "name") {
    copy.sort((first, second) => niceName(first.name).localeCompare(niceName(second.name)));
  } else if (sortMode === "upcoming") {
    copy.sort((first, second) => {
      if (!!first.next !== !!second.next) {
        return first.next ? -1 : 1;
      }
      return first.next ? Date.parse(first.next) - Date.parse(second.next) : Date.parse(second.activity || 0) - Date.parse(first.activity || 0);
    });
  } else {
    copy.sort((first, second) => Date.parse(second.activity || second.last) - Date.parse(first.activity || first.last));
  }
  return copy;
}
function paintSort() {
  var mode = SORTS.filter((entry) => entry[0] === sortMode)[0] || SORTS[0];
  byId("csortt").textContent = mode[1];
  byId("csortl").textContent = mode[2];
}
function renderPeople() {
  var box = byId("clist");
  paintSort();
  box.textContent = "";
  if (!peopleLoaded) {
    box.appendChild(skelRows(5, "Loading contacts…"));
    return;
  }
  var terms = words(byId<HTMLInputElement>("pq").value.trim());
  var now = Date.now();
  var shown = sortedPeople(people).filter((person) => {
    var text = (person.name + " " + niceName(person.name) + " " + (person.companies_ || "")).toLowerCase();
    return terms.every((term) => text.indexOf(term) >= 0);
  });
  if (!shown.length) {
    box.appendChild(div("rempty", people.length ? "No one matches your search." : "No contacts yet. People appear here once they book."));
    return;
  }
  shown.slice(0, 300).forEach((person) => {
    var row = el("button", "crow");
    row.type = "button";
    row.appendChild(span("cav", initials(person.name)));
    var main = div("cmain");
    var top = div("cline");
    top.appendChild(el("b", null, niceName(person.name)));
    top.appendChild(span("cago", person.activity ? agoShort(person.activity, now) : ""));
    main.appendChild(top);
    var meta = div("cmeta");
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
function choose(person) {
  chosen = person;
  loadAnalytics(person.event);
}
// home ⇄ contact page
function showDetail() {
  if (!byId("home").hidden) {
    homeScroll = window.scrollY;
  }
  byId("home").hidden = true;
  byId("an").hidden = false;
  window.scrollTo(0, 0);
}
function showHome() {
  byId("an").hidden = true;
  byId("home").hidden = false;
  chosen = null;
  data = null;
  loadSeq++;
  renderPeople();
  window.scrollTo(0, homeScroll);
}
function setTab(name) {
  [
    ["tabAct", "tpAct", "act"],
    ["tabAbout", "tpAbout", "about"],
  ].forEach((entry) => {
    var on = entry[2] === name;
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
(window as any).__contactSearch = () => {
  var field = byId<HTMLInputElement>("pq");
  var show = !document.body.classList.contains("cq") || !byId("an").hidden;
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
  var index = SORTS.map((entry) => entry[0]).indexOf(sortMode);
  sortMode = SORTS[(index + 1) % SORTS.length][0];
  try {
    localStorage.setItem("ct.sort", sortMode);
  } catch (error) {}
  renderPeople();
});
byId("back").addEventListener("click", showHome);
byId("tabAct").addEventListener("click", () => setTab("act"));
byId("tabAbout").addEventListener("click", () => setTab("about"));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("an").hidden) {
    showHome();
  }
});
var DAY = 86400000;
function dayNum(day) {
  return Date.parse(day + "T00:00:00Z") / DAY;
}
function evState(event, now) {
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
var data = null;
var loadSeq = 0;
var renderedTz = "";
function loadAnalytics(eventId) {
  var requestId = ++loadSeq;
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
          chosen.name ||= data.name;
        } else {
          chosen = { name: data.name, event: eventId };
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
// interviewer names changed: redraw the open contact
function onIv() {
  if (data) {
    renderAnalysis();
  }
}
function openBooking(id) {
  var host = window.parent as any;
  if (host && host !== window && host.__openB) {
    host.__openB(id);
  }
}
var canOpenBooking = (() => {
  try {
    return window.parent !== window && !!(window.parent as any).__openB;
  } catch (error) {
    return false;
  }
})();
// ---- Activity: every interview, reschedule and cancellation, newest first, grouped by day ----
function renderActivity(events, now) {
  var box = byId("tpAct");
  box.textContent = "";
  var query = byId<HTMLInputElement>("asq").value.trim();
  var terms = words(query);
  var list = events
    .filter((event) => {
      var text = ((event.company || "") + " " + (event.round || "")).toLowerCase();
      return terms.every((term) => text.indexOf(term) >= 0);
    })
    .sort((first, second) => Date.parse(second.start) - Date.parse(first.start));
  if (!list.length) {
    box.appendChild(div("rempty", terms.length ? "No interviews match \u201c" + query + "\u201d." : "No activity yet."));
    return;
  }
  var lastDay = "";
  list.forEach((event) => {
    var start = new Date(event.start);
    var day = ymd(start);
    if (day !== lastDay) {
      lastDay = day;
      box.appendChild(div("aday", fmt({ weekday: "long", day: "numeric", month: "short" }, start)));
    }
    var kind = evState(event, now);
    var bookingId = event.rescheduled ? String(event.id).replace(/-moved$/, "") : event.id;
    var moved = event.rescheduled ? events.filter((other) => other.id === bookingId)[0] : null;
    var what =
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
    var item = div("aitem " + kind);
    var head = div("ahead2");
    head.appendChild(svgIcon(CAL_ICON));
    head.appendChild(span("awhat", what));
    head.appendChild(span("atime", t12(start)));
    item.appendChild(head);
    var interviewer = ivMap[bookingId];
    var cardEl = el(canOpenBooking ? "button" : "div", "acard " + (interviewer ? ivCls(interviewer) : "none"));
    if (canOpenBooking) {
      (cardEl as HTMLButtonElement).type = "button";
      cardEl.addEventListener("click", () => openBooking(bookingId));
    }
    cardEl.appendChild(el("b", null, [event.company, event.round].filter(Boolean).join(" · ") || "Interview"));
    var minutes = Math.round((Date.parse(event.end) - Date.parse(event.start)) / 60000);
    cardEl.appendChild(
      div("sub", minutes + "m" + (interviewer ? " · " + interviewer : kind === "done" ? " · Support not recorded" : "") + (event.cancelReason ? " · " + event.cancelReason : "")),
    );
    cardEl.appendChild(div("sub", t12(start) + " – " + t12(new Date(event.end))));
    item.appendChild(cardEl);
    box.appendChild(item);
  });
}
// ---- About: emails, first booking, totals, and combining people with the same name ----
function renderAbout(events, now) {
  var box = byId("tpAbout");
  box.textContent = "";
  var group = div("agroup");
  function line(label, value) {
    var row = div("arow");
    row.appendChild(span("alabel", label));
    row.appendChild(el("b", null, value));
    group.appendChild(row);
  }
  (data.emailList || []).forEach((email, index) => {
    line(index ? "Also" : "Email", email);
  });
  var created = events
    .map((event) => Date.parse(event.created || event.start))
    .filter((time) => !isNaN(time))
    .sort((first, second) => first - second)[0];
  if (created) {
    line("First booked", fmt({ day: "numeric", month: "short", year: "numeric" }, new Date(created)));
  }
  var real = events.filter((event) => !event.rescheduled);
  line("Bookings", real.length + " (" + real.filter((event) => event.status === "canceled").length + " canceled)");
  box.appendChild(group);
  // how many of this candidate's interviews each interviewer took
  var taken = {};
  var notRecorded = 0;
  events.forEach((event) => {
    if (event.status === "active" && !event.noShow && Date.parse(event.end) <= now) {
      var interviewer = ivMap[event.id];
      if (interviewer) {
        taken[interviewer] = (taken[interviewer] || 0) + 1;
      } else {
        notRecorded++;
      }
    }
  });
  var names = Object.keys(taken).sort((first, second) => taken[second] - taken[first] || (first < second ? -1 : 1));
  if (names.length || notRecorded) {
    box.appendChild(div("ahead3", "Interview support given"));
    var ivGroup = div("agroup");
    names.forEach((name) => {
      var row = div("arow");
      var label = span("alabel ivn " + ivCls(name), name);
      row.appendChild(label);
      row.appendChild(el("b", null, taken[name] + (taken[name] === 1 ? " interview" : " interviews")));
      ivGroup.appendChild(row);
    });
    if (notRecorded) {
      var missing = div("arow");
      missing.appendChild(span("alabel", "Not recorded"));
      missing.appendChild(el("b", null, String(notRecorded)));
      ivGroup.appendChild(missing);
    }
    box.appendChild(ivGroup);
  }
  if (data.emails > 1 || !merge) {
    var note = div("anote");
    note.appendChild(
      document.createTextNode(
        data.emails > 1
          ? "Bookings from " + data.emails + " email addresses with the same name are shown as one person. "
          : "Showing this email address only. ",
      ),
    );
    var button = el("button", "linkbtn", data.emails > 1 ? "Show separately" : "Combine again");
    button.addEventListener("click", () => {
      setMerge(!merge || data.emails <= 1);
    });
    note.appendChild(button);
    box.appendChild(note);
  }
}
// ---- Analytics: what needs doing, then the numbers that matter to an interviewer ----
function renderAnalysis() {
  if (data) {
    var events = data.events;
    var now = Date.now();
    byId("aname").textContent = niceName(data.name);
    byId("av").textContent = initials(data.name);
    var upcoming = events
      .filter((event) => event.status === "active" && Date.parse(event.end) > now)
      .sort((first, second) => Date.parse(first.start) - Date.parse(second.start))[0];
    byId("asub").textContent = upcoming ? "Next meeting: " + meetingWhen(upcoming.start, now) : "No upcoming meetings";
    var firstEmail = (data.emailList || [])[0] || "";
    var mail = byId<HTMLAnchorElement>("aemail");
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
  if (data && renderedTz !== state.tz) {
    renderAnalysis();
  }
  renderPeople();
  syncPeople();
}
function setMerge(on) {
  merge = on;
  loadPeople();
  if (chosen) {
    loadAnalytics(chosen.event);
  }
}
byId("acopy").onclick = () => {
  var email = data && data.emailList && data.emailList[0];
  var label = byId("acopy").querySelector("span");
  if (email && navigator.clipboard) {
    navigator.clipboard.writeText(email).then(() => {
      label.textContent = "Copied";
      setTimeout(() => {
        label.textContent = "Copy";
      }, 1500);
    });
  }
};
var eventParam = new URLSearchParams(location.search).get("event");
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
  api("/api/state")
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
