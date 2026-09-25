// Person analytics (the Analytics tab of the admin page, loaded in a frame): pick a candidate, then see every company
// they interviewed with, how far each got, a timeline per company, and insights. Results (cleared, offer...) are saved
// through api(). Sections, in order: DOM and date helpers, the side panel (interviews of a person, who took an
// interview), the people picker, company progress (progress()), then rendering of the analysis.
import { api, knownCompanies } from "./api";
import { dupes, sameCompany, simKey } from "./companies";
import { bucketOf, roundKey, roundRank, roundShort } from "./rounds";

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
var reqId = 0;
var plinkOn = true;
var merge = true;
var takeEv = null;
var takeSaved = "";
var takeGo = false;
var takeTimer = 0;
function mergeQuery() {
  if (merge) {
    return "&merge=1";
  } else {
    return "";
  }
}
var ivMap = {};
var ivNames = [];
var ivInfo: { persistent: boolean; locked: boolean; canUnlock?: boolean } = {
  persistent: true,
  locked: false,
};
var ivSig = "";
function ivSigOf(info) {
  return JSON.stringify(info.assign || {}) + "|" + JSON.stringify(info.names || []) + "|" + (info.persistent !== false);
}
function loadIv() {
  api("/api/interviewers")
    .then((response) => response.json())
    .then((info) => {
      var signature = ivSigOf(info);
      ivInfo = info;
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
function avOf(name) {
  return String(name || "?")
    .trim()
    .charAt(0)
    .toUpperCase();
}
function getKey() {
  try {
    return localStorage.getItem("lv_edit") || "";
  } catch (error) {
    return "";
  }
}
function setKey(key) {
  try {
    localStorage.setItem("lv_edit", key);
  } catch (error) {}
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
function mod(date) {
  var hours = 0;
  var minutes = 0;
  new Intl.DateTimeFormat("en-GB", {
    timeZone: state.tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .forEach((part) => {
      if (part.type === "hour") {
        hours = +part.value;
      }
      if (part.type === "minute") {
        minutes = +part.value;
      }
    });
  return hours * 60 + minutes;
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
function addDays(day, count) {
  var date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}
function niceName(name) {
  if (name === name.toLowerCase() && name !== name.toUpperCase()) {
    return name.replace(/(^|[\s\-'])(\p{L})/gu, (match, before, letter) => before + letter.toUpperCase());
  } else {
    return name;
  }
}
function whenText(start, end) {
  return (
    fmt(
      {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      },
      start,
    ) +
    " · " +
    t12(start) +
    " – " +
    t12(end)
  );
}
// PUT through api(). A 401 "locked" asks for the edit password once and retries.
function sendPut(
  url: string,
  body: unknown,
  msg: HTMLElement | null,
  retried: boolean,
  onSaved: (reply: any) => void,
  onFailed?: (() => void) | null,
  headers?: Record<string, string>,
) {
  if (msg) {
    msg.textContent = "Saving…";
  }
  api(url, {
    method: "PUT",
    headers: Object.assign(
      {
        "Content-Type": "application/json",
        "x-edit-key": getKey(),
      },
      headers || {},
    ),
    body: JSON.stringify(body),
  })
    .then((response) =>
      response
        .json()
        .then((json) => ({
          s: response.status,
          j: json,
        }))
        .catch(() => ({
          s: response.status,
          j: {},
        })),
    )
    .then((reply) => {
      if (reply.s === 401 && reply.j && reply.j.error === "locked" && !retried) {
        var password = window.prompt("This dashboard is locked for changes. Enter the edit password:");
        if (password) {
          setKey(password);
          return sendPut(url, body, msg, true, onSaved, onFailed, headers);
        } else {
          if (msg) {
            msg.textContent = "Not saved: the edit password is needed.";
          }
          if (onFailed) {
            onFailed();
          }
          return;
        }
      }
      if (reply.s !== 200) {
        if (msg) {
          msg.textContent =
            reply.s === 409
              ? reply.j && reply.j.error === "not started"
                ? "This interview hasn't started yet."
                : "Already recorded. It can't be changed here."
              : reply.s === 401
                ? reply.j && reply.j.error === "wrong unlock password"
                  ? "Wrong unlock password."
                  : "Not saved: wrong edit password."
                : "Couldn't save. Try again.";
        }
        if (onFailed) {
          onFailed();
        }
        return;
      }
      onSaved(reply.j);
    })
    .catch(() => {
      if (msg) {
        msg.textContent = "Couldn't save. Check your connection and try again.";
      }
      if (onFailed) {
        onFailed();
      }
    });
}
function kvRow(parent: Node, label: string, value: string, cls?: string) {
  var row = div("kv" + (cls ? " " + cls : ""));
  row.appendChild(span(null, label));
  row.appendChild(el("b", null, value));
  parent.appendChild(row);
}
function card(label, value) {
  var box = div("card");
  box.appendChild(div("k", label));
  box.appendChild(div("v", value));
  return box;
}
function ivDesc(event) {
  return [event.company, event.round].filter(Boolean).join(" · ") || "Interview";
}
function ivOverlap(event, interviewer) {
  if (!interviewer) {
    return "";
  }
  var start = Date.parse(event.start);
  var end = Date.parse(event.end);
  for (var events = state.events || [], index = 0; index < events.length; index++) {
    var other = events[index];
    if (other.id !== event.id && ivMap[other.id] === interviewer && Date.parse(other.start) < end && Date.parse(other.end) > start) {
      return niceName(other.invitee) + " at " + t12(new Date(other.start));
    }
  }
  return "";
}
function openTake(event) {
  reqId++;
  takeEv = event;
  takeSaved = "";
  byId("ptitle").textContent = niceName(event.invitee);
  var link = byId<HTMLAnchorElement>("plink");
  link.href = "/analytics?event=" + encodeURIComponent(event.id);
  link.hidden = false;
  showPanel(true);
  paintTake();
}
function ivApply(info) {
  ivInfo = info;
  ivMap = info.assign || {};
  ivNames = info.names || [];
  ivSig = ivSigOf(info);
}
function takeTick() {
  if (takeEv && !takeGo && !byId("panel").hidden && Date.parse(takeEv.start) <= Date.now()) {
    paintTake();
  }
}
function paintTake() {
  var event = takeEv;
  var list = byId("plist");
  list.textContent = "";
  var interviewer = ivMap[event.id] || "";
  var start = new Date(event.start);
  var isPast = Date.parse(event.end) <= Date.now();
  var started = Date.parse(event.start) <= Date.now();
  takeGo = started;
  byId("psub").textContent =
    ivDesc(event) +
    " · " +
    fmt(
      {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
      },
      start,
    ) +
    " · " +
    t12(start) +
    " · " +
    (isPast ? "Completed" : started ? "In progress" : "Upcoming");
  if (!started && !interviewer) {
    var waitCard = div("rcard");
    waitCard.appendChild(div("tkq", "Who took this interview?"));
    waitCard.appendChild(div("sub", "You can choose once the interview starts, at " + t12(start) + "."));
    list.appendChild(waitCard);
    clearTimeout(takeTimer);
    takeTimer = setTimeout(takeTick, Math.min(Date.parse(event.start) - Date.now() + 400, 2147000000));
    return;
  }
  var takeCard = div("rcard" + (interviewer ? " locked" : isPast ? " need" : ""));
  var msg = div("rmsg");
  if (interviewer) {
    takeCard.appendChild(div("tkq", "Interview taken by"));
    takeCard.appendChild(div("tkby " + ivCls(interviewer), interviewer));
    msg.textContent = takeSaved === event.id ? "Saved and locked." : "Locked. This can't be changed.";
    takeCard.appendChild(msg);
    if (ivInfo.canUnlock) {
      var unlockButton = el("button", "linkbtn", "Unlock to change");
      unlockButton.addEventListener("click", () => {
        var password = window.prompt("Enter the unlock password to change this interviewer:");
        if (password) {
          var change = {};
          change[event.id] = "";
          sendPut(
            "/api/interviewers",
            {
              set: change,
              unlock: true,
            },
            msg,
            false,
            (info) => {
              ivApply(info);
              takeSaved = "";
              if (takeEv === event) {
                paintTake();
              }
              if (typeof onIv == "function") {
                onIv();
              }
            },
            null,
            {
              "x-unlock-key": password,
            },
          );
        }
      });
      takeCard.appendChild(unlockButton);
    }
  } else {
    takeCard.appendChild(div("tkq", "Who took this interview?"));
    var pills = div("pick");
    ivNames.forEach((name) => {
      var button = el("button", ivCls(name), name);
      button.addEventListener("click", () => {
        var change = {};
        change[event.id] = name;
        sendPut(
          "/api/interviewers",
          {
            set: change,
          },
          msg,
          false,
          (info) => {
            ivApply(info);
            takeSaved = event.id;
            if (takeEv === event) {
              paintTake();
            }
            if (typeof onIv == "function") {
              onIv();
            }
          },
          () => {
            loadIv();
          },
        );
      });
      pills.appendChild(button);
    });
    takeCard.appendChild(pills);
    takeCard.appendChild(msg);
  }
  var clash = ivOverlap(event, interviewer);
  if (clash) {
    takeCard.appendChild(div("iwarn", "Overlaps with " + clash));
  }
  if (!ivInfo.persistent) {
    takeCard.appendChild(div("iwarn", "Server storage is not attached, so this is only kept until the next restart."));
  }
  list.appendChild(takeCard);
}
function showPanel(open) {
  byId("panel").hidden = !open;
  byId("pback").hidden = !open;
  if (!open) {
    byId<HTMLAnchorElement>("plink").hidden = true;
  }
  if (open) {
    byId("pclose").focus();
  }
}
function closePanel() {
  reqId++;
  takeEv = null;
  showPanel(false);
}
function renderPerson(person) {
  var list = byId("plist");
  list.textContent = "";
  var completed = 0;
  var upcoming = 0;
  var noShows = 0;
  person.events.forEach((event) => {
    var start = new Date(event.start);
    var end = new Date(event.end);
    var item = div("pitem");
    var when = div("when", whenText(start, end));
    var label = event.status === "upcoming" ? "Upcoming" : event.status === "noshow" ? "No-show" : "Completed";
    when.appendChild(span("badge" + (event.status === "upcoming" ? " up" : event.status === "noshow" ? " ns" : ""), label));
    item.appendChild(when);
    var what = [event.company, event.round].filter(Boolean).join(" · ");
    if (what) {
      item.appendChild(div("what", what));
    }
    var meta = [event.name, event.location, ivMap[event.id] ? "Interviewer: " + ivMap[event.id] : ""].filter(Boolean).join(" · ");
    if (meta) {
      item.appendChild(div("meta", meta));
    }
    list.appendChild(item);
    if (event.status === "upcoming") {
      upcoming++;
    } else if (event.status === "noshow") {
      noShows++;
    } else {
      completed++;
    }
  });
  byId("ptitle").textContent = niceName(person.name);
  var total = person.events.length;
  byId("psub").textContent =
    total +
    (total === 1 ? " interview" : " interviews") +
    " · " +
    completed +
    " completed · " +
    upcoming +
    " upcoming" +
    (noShows ? " · " + noShows + " no-show" : "") +
    (person.emails > 1 ? " · " + person.emails + " email addresses combined" : "");
  if (!total) {
    list.appendChild(div("sub", "No interviews found for this person."));
  }
}
function openPerson(event) {
  var requestId = ++reqId;
  takeEv = null;
  byId("ptitle").textContent = niceName(event.invitee);
  byId("psub").textContent = "Loading interviews…";
  byId("plist").textContent = "";
  showPanel(true);
  var link = byId<HTMLAnchorElement>("plink");
  if (plinkOn) {
    link.href = "/analytics?event=" + encodeURIComponent(event.id);
    link.hidden = false;
  } else {
    link.hidden = true;
  }
  api("/api/person?event=" + encodeURIComponent(event.id) + mergeQuery())
    .then((response) =>
      response.json().then((json) => ({
        ok: response.ok,
        j: json,
      })),
    )
    .then((reply) => {
      if (requestId === reqId) {
        if (reply.ok) {
          renderPerson(reply.j);
        } else {
          byId("psub").textContent = (reply.j && reply.j.error) || "Couldn't load interviews.";
        }
      }
    })
    .catch(() => {
      if (requestId === reqId) {
        byId("psub").textContent = "Couldn't load interviews. Check your connection and try again.";
      }
    });
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
(() => {
  var startY = 0;
  var dragY = 0;
  var panel = byId("panel");
  var head = panel.querySelector<HTMLElement>(".phead");
  head.addEventListener(
    "touchstart",
    (event) => {
      startY = event.touches[0].clientY;
      dragY = 0;
    },
    {
      passive: true,
    },
  );
  head.addEventListener(
    "touchmove",
    (event) => {
      if ((dragY = event.touches[0].clientY - startY) > 0) {
        panel.style.transform = "translateY(" + dragY + "px)";
      }
    },
    {
      passive: true,
    },
  );
  head.addEventListener("touchend", () => {
    panel.style.transform = "";
    if (dragY > 90) {
      closePanel();
    }
    dragY = 0;
  });
})();
byId("pclose").onclick = closePanel;
byId("pback").onclick = closePanel;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !byId("panel").hidden) {
    closePanel();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadIv();
    takeTick();
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
  takeTick();
  if (state.ready) {
    render();
  }
}, 60000);
loadIv();
var people = [];
var chosen = null;
var pickerOpen = true;
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
function renderPeople() {
  var box = byId("plistbox");
  box.textContent = "";
  var query = byId<HTMLInputElement>("pq").value.trim();
  var terms = words(query === chosenName() ? "" : query);
  if (pickerOpen && terms.length) {
    if (!peopleLoaded) {
      box.hidden = false;
      box.appendChild(skelRows(3, "Loading people…"));
      return;
    }
    var matches = people.filter((person) => {
      var text = (person.name + " " + niceName(person.name) + " " + (person.company || "")).toLowerCase();
      for (var i = 0; i < terms.length; i++) {
        if (text.indexOf(terms[i]) < 0) {
          return false;
        }
      }
      return true;
    });
    box.hidden = false;
    if (matches.length) {
      matches.slice(0, 60).forEach((person) => {
        var row = div("rrow");
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.appendChild(span("rav", avOf(niceName(person.name))));
        var main = div("rmain");
        main.appendChild(el("b", null, niceName(person.name)));
        if (person.company) {
          main.appendChild(div("sub", person.company));
        }
        row.appendChild(main);
        var last = person.last
          ? fmt(
              {
                day: "numeric",
                month: "short",
                year: "numeric",
              },
              new Date(person.last),
            )
          : "";
        function open() {
          choose(person);
        }
        row.appendChild(
          span(
            "sub rmeta",
            person.count +
              (person.count === 1 ? " booking" : " bookings") +
              (last ? " · last " + last : "") +
              (person.emails > 1 ? " · " + person.emails + " emails" : ""),
          ),
        );
        row.addEventListener("mousedown", (event) => {
          event.preventDefault();
        });
        row.addEventListener("click", open);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
        box.appendChild(row);
      });
    } else {
      box.appendChild(div("rempty", people.length ? "No one matches." : "No people yet. They appear once their bookings have loaded."));
    }
  } else {
    box.hidden = true;
  }
}
function choose(person) {
  chosen = person;
  pickerOpen = false;
  byId<HTMLInputElement>("pq").value = chosenName();
  byId<HTMLInputElement>("pq").blur();
  renderPeople();
  onPick(person);
}
byId<HTMLInputElement>("pq").addEventListener("focus", function () {
  pickerOpen = true;
  this.select();
  renderPeople();
});
byId<HTMLInputElement>("pq").addEventListener("input", () => {
  pickerOpen = true;
  renderPeople();
});
byId<HTMLInputElement>("pq").addEventListener("blur", () => {
  setTimeout(() => {
    pickerOpen = false;
    renderPeople();
  }, 200);
});
byId<HTMLInputElement>("pq").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    pickerOpen = false;
    renderPeople();
  }
});
var DAY = 86400000;
var QUIET = 10;
var STATE_LABEL = {
  upcoming: "Upcoming",
  done: "Completed",
  noshow: "No-show",
  canceled: "Canceled",
  rescheduled: "Rescheduled",
};
var BADGE = {
  booked: ["Upcoming", "up"],
  waiting: ["Awaiting result", ""],
  quiet: ["No update", "warn"],
  noshow: ["No-show", "ns"],
  canceled: ["Canceled", "ns"],
  rescheduled: ["Rescheduled", "warn"],
};
var OV_BADGE = {
  cleared: ["Cleared", "ok"],
  notcleared: ["Not cleared", "ns"],
  hold: ["On hold", "warn"],
  offer: ["Offer", "ok"],
  withdrew: ["Withdrew", "ns"],
};
var OV_CHOICES = [
  ["", "Automatic"],
  ["cleared", "Cleared"],
  ["notcleared", "Not cleared"],
  ["hold", "On hold"],
  ["offer", "Offer"],
  ["withdrew", "Candidate withdrew"],
];
var results = {};
var savedJoins = {}; // company names combined with "Same company as…", for every candidate: lower-cased name → name it joins
var knownIndex = {}; // compact known company name or alias → its entry, so "TCS" and "Tata Consultancy Services" match
var auto = {};
knownCompanies().then((known) => {
  knownIndex = {};
  known.forEach((names, index) => {
    names.forEach((name) => {
      var key = compactName(name);
      if (key && knownIndex[key] === undefined) {
        knownIndex[key] = index;
      }
    });
  });
  if (data && known.length) {
    renderAnalysis();
  }
});
function compactName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function sameKnown(first, second) {
  var entry = knownIndex[compactName(first)];
  return entry !== undefined && entry === knownIndex[compactName(second)];
}
// Every name a saved join leads to from this one ("tcs" → "tata consultancy" → "tata consultancy services").
function joinTargets(name) {
  var found = [];
  for (var next = savedJoins[name]; next && found.indexOf(next) < 0 && found.length < 20; next = savedJoins[next]) {
    found.push(next);
  }
  return found;
}
function dayNum(day) {
  return Date.parse(day + "T00:00:00Z") / DAY;
}
function fetchResults(eventId) {
  var fallback = {
    results: {},
    persistent: true,
    locked: false,
    failed: true,
  };
  return api("/api/results?event=" + encodeURIComponent(eventId) + mergeQuery())
    .then((response) => response.json().then((json) => (response.ok ? json : fallback)))
    .catch(() => fallback);
}
function stats(events, now) {
  var counts = {
    held: [],
    noshow: 0,
    resched: 0,
    canceled: 0,
  };
  events.forEach((event) => {
    if (event.status !== "canceled") {
      if (Date.parse(event.end) <= now) {
        if (event.noShow) {
          counts.noshow++;
        } else {
          counts.held.push(event);
        }
      }
    } else if (event.rescheduled) {
      counts.resched++;
    } else {
      counts.canceled++;
    }
  });
  return counts;
}
function evState(event, now) {
  if (event.status === "canceled") {
    if (event.rescheduled) {
      return "rescheduled";
    } else {
      return "canceled";
    }
  } else if (Date.parse(event.end) > now) {
    return "upcoming";
  } else if (event.noShow) {
    return "noshow";
  } else {
    return "done";
  }
}
function relDay(time, now) {
  var days = dayNum(ymd(new Date(time))) - dayNum(ymd(new Date(now)));
  if (days <= 0) {
    return "Today";
  } else if (days === 1) {
    return "Tomorrow";
  } else {
    return "In " + days + " days";
  }
}
function canon(key) {
  return auto[key] || key;
}
function buildAuto(events) {
  var i;
  var j;
  var counts = {};
  var latest = {};
  var names = [];
  var parent = {};
  function rootOf(name) {
    while (parent[name] !== name) {
      name = parent[name];
    }
    return name;
  }
  events.forEach((event) => {
    var name = String(event.company || "")
      .trim()
      .toLowerCase();
    if (name) {
      if (counts[name] === undefined) {
        counts[name] = 0;
        latest[name] = 0;
        names.push(name);
      }
      counts[name]++;
      latest[name] = Math.max(latest[name], Date.parse(event.start));
    }
  });
  names.forEach((name) => {
    parent[name] = name;
  });
  i = 0;
  for (; i < names.length; i++) {
    for (j = i + 1; j < names.length; j++) {
      if (
        sameCompany(names[i], names[j]) ||
        sameKnown(names[i], names[j]) ||
        joinTargets(names[i]).indexOf(names[j]) >= 0 ||
        joinTargets(names[j]).indexOf(names[i]) >= 0
      ) {
        var rootA = rootOf(names[i]);
        var rootB = rootOf(names[j]);
        if (rootA !== rootB) {
          parent[rootB] = rootA;
        }
      }
    }
  }
  var groups = {};
  names.forEach((name) => {
    var root = rootOf(name);
    (groups[root] = groups[root] || []).push(name);
  });
  auto = {};
  Object.keys(groups).forEach((root) => {
    var group = groups[root];
    if (!(group.length < 2)) {
      var best = group[0];
      group.forEach((name) => {
        if (
          counts[name] !== counts[best]
            ? counts[name] > counts[best]
            : simKey(name) === simKey(best) && name.length !== best.length
              ? name.length < best.length
              : latest[name] > latest[best]
        ) {
          best = name;
        }
      });
      group.forEach((name) => {
        if (name !== best) {
          auto[name] = best;
        }
      });
    }
  });
}
function progress(events) {
  var now = Date.now();
  var byCompany = {};
  var keys = [];
  buildAuto(events);
  events.forEach((event) => {
    var company = String(event.company || "").trim();
    var key = canon(company.toLowerCase());
    if (!byCompany[key]) {
      byCompany[key] = {
        names: {},
        evs: [],
      };
      keys.push(key);
    }
    var group = byCompany[key];
    group.evs.push(event);
    group.names[company] = (group.names[company] || 0) + 1;
  });
  var gaps = [];
  keys.forEach((key) => {
    for (
      var starts = byCompany[key].evs
          .filter((event) => event.status !== "canceled")
          .map((event) => Date.parse(event.start))
          .sort((first, second) => first - second),
        i = 1;
      i < starts.length;
      i++
    ) {
      var gap = (starts[i] - starts[i - 1]) / DAY;
      if (gap >= 1) {
        gaps.push(gap);
      }
    }
  });
  var quietDays = QUIET;
  var personal = false;
  if (gaps.length >= 3) {
    var sorted = gaps.slice().sort((first, second) => first - second);
    var count = sorted.length;
    var median = count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;
    quietDays = Math.min(21, Math.max(5, Math.ceil(median * 1.5)));
    personal = true;
  }
  var rows = keys.map((key) => {
    var group = byCompany[key];
    var held = [];
    var canceled = [];
    var rescheduled = [];
    group.evs.forEach((event) => {
      if (event.status !== "canceled") {
        held.push(event);
      } else if (event.rescheduled) {
        rescheduled.push(event);
      } else {
        canceled.push(event);
      }
    });
    var relevant = held.length ? held : canceled.length ? canceled : rescheduled;
    var allRanked = relevant.every((event) => roundRank(event.round) !== null);
    var ordered = relevant.slice().sort((first, second) => {
      if (allRanked) {
        var diff = roundRank(first.round) - roundRank(second.round);
        if (diff) {
          return diff;
        }
      }
      return Date.parse(first.start) - Date.parse(second.start);
    });
    var current = ordered[ordered.length - 1];
    var note = "";
    if (held.length) {
      var laterCanceled = canceled
        .filter((event) => {
          var rank = roundRank(event.round);
          var currentRank = roundRank(current.round);
          return (
            Date.parse(event.start) > Date.parse(current.start) ||
            (allRanked && rank !== null && currentRank !== null && rank > currentRank)
          );
        })
        .sort((first, second) => Date.parse(second.start) - Date.parse(first.start));
      if (laterCanceled.length) {
        note = (laterCanceled[0].round || "An interview") + " was canceled";
      }
    }
    var starts = (held.length ? held : group.evs).map((event) => Date.parse(event.start));
    var bestName = "";
    var bestCount = 0;
    Object.keys(group.names).forEach((name) => {
      if (group.names[name] > bestCount || (group.names[name] === bestCount && name.toLowerCase() === key)) {
        bestCount = group.names[name];
        bestName = name;
      }
    });
    var status;
    var statusText;
    var whenIso;
    var whenLabel;
    var upcoming = held
      .filter((event) => Date.parse(event.end) > now)
      .sort((first, second) => Date.parse(first.start) - Date.parse(second.start));
    var past = held.filter((event) => Date.parse(event.end) <= now).sort((first, second) => Date.parse(second.end) - Date.parse(first.end));
    var lastEnd = past.length ? Date.parse(past[0].end) : 0;
    var since = lastEnd ? Math.floor((now - lastEnd) / DAY) : 0;
    var rank = roundRank(current.round);
    var nextStart = null;
    if (upcoming.length) {
      status = "booked";
      statusText = relDay((nextStart = Date.parse(upcoming[0].start)), now);
      whenIso = upcoming[0].start;
      whenLabel = "Next";
    } else {
      if (past.length) {
        whenIso = past[0].start;
        whenLabel = "Last";
      } else {
        whenIso = current.start;
        whenLabel = "Was booked for";
      }
      if (held.length) {
        if (evState(current, now) === "noshow") {
          status = "noshow";
          statusText = "Marked as no-show";
        } else if (since >= quietDays) {
          status = "quiet";
          statusText = "No news for " + since + " days (likely not cleared)";
        } else {
          status = "waiting";
          statusText =
            "Interview was " +
            (since < 1 ? "today" : since + (since === 1 ? " day" : " days") + " ago") +
            (rank === 90 ? ". Waiting for a result." : ". Waiting to hear back.");
        }
      } else {
        statusText = (status = evState(current, now)) === "rescheduled" ? "Rescheduled, new time not booked" : "Not rebooked";
      }
    }
    var cleared = [];
    var seenRounds = {};
    held
      .filter((event) => Date.parse(event.end) <= now && !event.noShow)
      .forEach((event) => {
        var later = held.some((other) => {
          if (other === event) {
            return false;
          }
          var otherRank = roundRank(other.round);
          var eventRank = roundRank(event.round);
          if (otherRank !== null && eventRank !== null) {
            return otherRank > eventRank;
          } else {
            return Date.parse(other.start) > Date.parse(event.start) && roundKey(other.round) !== roundKey(event.round);
          }
        });
        var roundId = roundKey(event.round) || "(none)";
        if (later && !seenRounds[roundId]) {
          seenRounds[roundId] = 1;
          cleared.push(event);
        }
      });
    cleared.sort((first, second) => {
      var firstRank = roundRank(first.round);
      var secondRank = roundRank(second.round);
      if (firstRank !== null && secondRank !== null && firstRank !== secondRank) {
        return firstRank - secondRank;
      } else {
        return Date.parse(first.start) - Date.parse(second.start);
      }
    });
    var name = bestName ? niceName(bestName) : "Company not given";
    var override = results[key] || "";
    if (!override) {
      Object.keys(group.names).forEach((name) => {
        var lower = name.toLowerCase();
        if (!override && results[lower]) {
          override = results[lower];
        }
      });
    }
    if (override && !OV_BADGE[override]) {
      override = "";
    }
    var badge = override ? OV_BADGE[override] : BADGE[status];
    if (override && status !== "booked") {
      statusText = "Marked by you: " + OV_BADGE[override][0];
    }
    var aliases = Object.keys(group.names).filter((name) => name && name.toLowerCase() !== (bestName || "").toLowerCase());
    for (
      var times = held.map((event) => Date.parse(event.start)).sort((first, second) => first - second), gapList = [], i = 1;
      i < times.length;
      i++
    ) {
      var gap = (times[i] - times[i - 1]) / DAY;
      if (gap >= 1) {
        gapList.push(gap);
      }
    }
    var buckets = [];
    held.forEach((event) => {
      var rank = roundRank(event.round);
      if (rank !== null) {
        var bucket = bucketOf(rank);
        if (buckets.indexOf(bucket) < 0) {
          buckets.push(bucket);
        }
      }
    });
    return {
      key: key,
      name: name,
      aliases: aliases,
      cleared: cleared.map((event) => event.round || "Interview"),
      badge: badge[0],
      badgeCls: badge[1],
      override: override,
      rawKeys: Object.keys(group.names)
        .map((name) => name.toLowerCase())
        .concat([key]),
      stage: current.round || "Interview",
      state: evState(current, now),
      whenIso: whenIso,
      whenLabel: whenLabel,
      curStart: current.start,
      count: held.length,
      note: note,
      last: Math.max.apply(null, starts),
      events: group.evs,
      status: status,
      statusText: statusText,
      nextStart: nextStart,
      since: since,
      rank: rank,
      gapAvg: gapList.length ? gapList.reduce((sum, value) => sum + value, 0) / gapList.length : null,
      attended: buckets,
      maxB: buckets.length ? Math.max.apply(null, buckets) : -1,
    };
  });
  rows.sort((first, second) => {
    var firstBooked = first.status === "booked";
    var secondBooked = second.status === "booked";
    if (firstBooked !== secondBooked) {
      if (firstBooked) {
        return -1;
      } else {
        return 1;
      }
    } else if (firstBooked && secondBooked) {
      return first.nextStart - second.nextStart;
    } else {
      return second.last - first.last;
    }
  });
  return {
    rows: rows,
    gaps: gaps,
    T: quietDays,
    personal: personal,
  };
}
plinkOn = false;
var data = null;
var loadSeq = 0;
var renderedTz = "";
var companyRows = [];
var renderedAt = 0;
var insightArgs = null;
var resultsInfo = {
  persistent: true,
  locked: false,
  failed: false,
};
var savedKey = "";
var panelMode = "";
var resultsCompany = "";
var ROUND_LABELS = ["1st round", "2nd round", "3rd round", "4th round or later", "Final round"];
function onPick(person) {
  loadAnalytics(person.event);
}
function sectionHead(id, title, subtitle) {
  var box = byId(id);
  box.textContent = "";
  var head = div("chead");
  head.appendChild(el("b", null, title));
  if (subtitle) {
    head.appendChild(span("sub", subtitle));
  }
  box.appendChild(head);
  return box;
}
function clearSections() {
  ["sumline", "attn", "cgrid", "cleg", "csub", "cIns"].forEach((id) => {
    byId(id).textContent = "";
  });
  byId("attn").style.display = "none";
}
function showSkeleton() {
  var sub = byId("asub");
  sub.textContent = "";
  sub.appendChild(span("spin"));
  sub.appendChild(document.createTextNode("Loading analytics…"));
  var i;
  var j;
  var summary = byId("sumline");
  for (i = 0; i < 3; i++) {
    summary.appendChild(div("skel sk-pill"));
  }
  var grid = div("pgrid");
  for (i = 0; i < 4; i++) {
    var row = div("grow");
    for (j = 0; j < 4; j++) {
      row.appendChild(div("skel sk-line sk-w" + (((i + j) % 3) + 1)));
    }
    grid.appendChild(row);
  }
  byId("cgrid").appendChild(grid);
  var insights = byId("cIns");
  for (i = 0; i < 3; i++) {
    insights.appendChild(div("skel sk-line sk-w" + ((i % 3) + 1)));
  }
}
function loadAnalytics(eventId) {
  var requestId = ++loadSeq;
  data = null;
  results = {};
  insightArgs = null;
  byId("empty").hidden = true;
  byId("an").hidden = false;
  clearSections();
  byId("hist").hidden = true;
  byId("reslink").hidden = true;
  byId<HTMLInputElement>("cs").value = "";
  byId("aname").textContent = chosenName();
  byId("av").textContent = avOf(chosenName());
  showSkeleton();
  Promise.all([
    api("/api/analytics?event=" + encodeURIComponent(eventId) + mergeQuery()).then((response) =>
      response.json().then((json) => ({
        ok: response.ok,
        j: json,
      })),
    ),
    fetchResults(eventId),
  ])
    .then((replies) => {
      var reply = replies[0];
      if (requestId === loadSeq) {
        if (!reply.ok) {
          clearSections();
          byId("asub").textContent = (reply.j && reply.j.error) || "Couldn't load analytics.";
          return;
        }
        data = reply.j;
        results = replies[1].results || {};
        savedJoins = replies[1].joins || {};
        resultsInfo = replies[1];
        if (chosen) {
          chosen.name ||= data.name;
        } else {
          chosen = {
            name: data.name,
            event: eventId,
          };
        }
        if (document.activeElement !== byId<HTMLInputElement>("pq")) {
          byId<HTMLInputElement>("pq").value = chosenName();
        }
        restoreLocalResults();
        renderAnalysis();
      }
    })
    .catch(() => {
      if (requestId === loadSeq) {
        clearSections();
        byId("asub").textContent = "Couldn't load analytics. Check your connection and try again.";
      }
    });
}
function legacyNameKey(name) {
  return String(name || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .sort()
    .join(" ");
}
function shortDay(time) {
  return fmt(
    {
      weekday: "short",
      day: "numeric",
      month: "short",
    },
    new Date(time),
  );
}
function restoreLocalResults() {
  if (!resultsInfo.locked && !resultsInfo.failed && !Object.keys(results).length) {
    var saved = "";
    try {
      saved = localStorage.getItem("lv_r:" + legacyNameKey(data.name)) || "";
    } catch (error) {}
    if (saved) {
      var found = {};
      saved.split(",").forEach((entry) => {
        var colon = entry.lastIndexOf(":");
        if (!(colon < 1)) {
          var company;
          var value = entry.slice(colon + 1);
          try {
            company = decodeURIComponent(entry.slice(0, colon));
          } catch (error) {
            return;
          }
          if (OV_BADGE[value]) {
            found[company] = value;
          }
        }
      });
      if (Object.keys(found).length) {
        results = found;
        saveResults(
          {
            set: found,
            remove: [],
          },
          null,
          false,
          () => {
            try {
              localStorage.removeItem("lv_r:" + legacyNameKey(data.name));
            } catch (error) {}
          },
        );
      }
    }
  }
}
function openResults() {
  if (data) {
    reqId++;
    panelMode = "res";
    resultsCompany = "";
    byId("ptitle").textContent = "Update results";
    byId("psub").textContent = niceName(data.name) + " · saved on the server";
    byId<HTMLAnchorElement>("plink").hidden = true;
    var list = byId("plist");
    list.textContent = "";
    var note = div("banner");
    note.id = "rnote";
    note.hidden = true;
    list.appendChild(note);
    list.appendChild(div("sub", "Company"));
    var input = el("input");
    input.type = "search";
    input.id = "rq";
    input.placeholder = "Type a company name";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "Company");
    input.addEventListener("input", () => {
      resultsCompany = "";
      renderSuggestions();
      renderResultEditor();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && this.value) {
        event.stopPropagation();
        this.value = "";
        resultsCompany = "";
        renderSuggestions();
        renderResultEditor();
      }
      if (event.key === "Enter") {
        var matches = companyMatches();
        if (matches.length === 1) {
          pickCompany(matches[0]);
        }
      }
    });
    list.appendChild(input);
    var suggestions = div("results");
    suggestions.id = "rsug";
    suggestions.hidden = true;
    list.appendChild(suggestions);
    var editor = el("div");
    editor.id = "redit";
    list.appendChild(editor);
    renderResultsPanel();
    showPanel(true);
    input.focus();
  }
}
function companyMatches() {
  var query = byId<HTMLInputElement>("rq").value.trim().toLowerCase();
  if (query) {
    return companyRows.filter((row) => (row.name + " " + row.aliases.join(" ")).toLowerCase().indexOf(query) >= 0);
  } else {
    return [];
  }
}
function pickCompany(row) {
  resultsCompany = row.key;
  byId<HTMLInputElement>("rq").value = row.name;
  renderSuggestions();
  renderResultEditor();
}
function renderSuggestions() {
  var box = byId("rsug");
  box.textContent = "";
  if (byId<HTMLInputElement>("rq").value.trim() && !resultsCompany) {
    var matches = companyMatches();
    box.hidden = false;
    if (matches.length) {
      matches.slice(0, 8).forEach((row) => {
        var item = div("rrow");
        var main = div("rmain");
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        main.appendChild(el("b", null, row.name));
        main.appendChild(div("sub", row.stage + " · " + row.badge));
        item.appendChild(main);
        item.addEventListener("click", () => {
          pickCompany(row);
        });
        item.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pickCompany(row);
          }
        });
        box.appendChild(item);
      });
    } else {
      box.appendChild(div("rempty", "No company matches."));
    }
  } else {
    box.hidden = true;
  }
}
function renderResultEditor() {
  var box = byId("redit");
  box.textContent = "";
  var row = null;
  companyRows.forEach((candidate) => {
    if (candidate.key === resultsCompany) {
      row = candidate;
    }
  });
  if (row) {
    var resultCard = div("rcard");
    var top = div("rtop");
    top.appendChild(el("b", null, row.name));
    top.appendChild(span("sub", row.stage + " · " + row.badge + " · " + row.whenLabel.toLowerCase() + " " + shortDay(row.whenIso)));
    resultCard.appendChild(top);
    if (row.aliases.length) {
      resultCard.appendChild(div("sub", "Also entered as: " + row.aliases.join(", ")));
    }
    resultCard.appendChild(div("sub", "Result"));
    var select = el("select", "rsel2");
    select.setAttribute("aria-label", "Result for " + row.name);
    OV_CHOICES.forEach((choice) => {
      var option = el("option", null, choice[1]);
      option.value = choice[0];
      if (choice[0] === (row.override || "")) {
        option.selected = true;
      }
      select.appendChild(option);
    });
    var msg = div("rmsg", row.key === savedKey ? "Saved" : "");
    var previous = row.override || "";
    select.addEventListener("change", function () {
      saveCompanyResult(row, this.value, msg, () => {
        select.value = previous;
      });
    });
    resultCard.appendChild(select);
    resultCard.appendChild(msg);
    box.appendChild(resultCard);
  } else if (!byId<HTMLInputElement>("rq").value.trim()) {
    box.appendChild(div("sub hint", companyRows.length ? "Type a company name above, then choose its result." : "No bookings yet."));
  }
}
function renderResultsPanel() {
  if (byId<HTMLInputElement>("rq")) {
    var note = byId("rnote");
    var text = resultsInfo.failed
      ? "Couldn't load the saved results. Changes may not be kept."
      : resultsInfo.persistent
        ? ""
        : "Server storage is not attached, so results are only kept until the next restart.";
    note.textContent = text;
    note.hidden = !text;
    renderSuggestions();
    renderResultEditor();
  }
}
function saveCompanyResult(row, value, msg, onFailed) {
  var change = {
    set: {},
    remove: row.rawKeys.filter((key) => key !== row.key || !value),
  };
  if (value) {
    change.set[row.key] = value;
  }
  savedKey = row.key;
  saveResults(change, msg, false, null, onFailed);
}
function saveResults(change: unknown, msg: HTMLElement | null, retried: boolean, onSaved: (() => void) | null, onFailed?: () => void) {
  sendPut(
    "/api/results?event=" + encodeURIComponent(chosen.event) + mergeQuery(),
    change,
    msg,
    retried,
    (info) => {
      results = info.results || {};
      resultsInfo = info;
      if (onSaved) {
        onSaved();
      }
      renderAnalysis();
    },
    onFailed,
  );
}
function renderSummary(events, rows, counts, now) {
  var box = byId("sumline");
  function stat(value: number, label: string, cls?: string) {
    var item = div("st" + (cls ? " " + cls : "") + (value ? "" : " zero"));
    item.appendChild(el("b", null, String(value)));
    item.appendChild(span(null, label));
    box.appendChild(item);
  }
  box.textContent = "";
  var upcoming = events.filter((event) => event.status === "active" && Date.parse(event.end) > now).length;
  stat(counts.held.length, counts.held.length === 1 ? "interview done" : "interviews done");
  stat(upcoming, "upcoming");
  stat(rows.length, rows.length === 1 ? "company" : "companies");
  if (counts.resched) {
    stat(counts.resched, "rescheduled", "warn");
  }
  if (counts.canceled) {
    stat(counts.canceled, "canceled", "bad");
  }
  if (counts.noshow) {
    stat(counts.noshow, counts.noshow === 1 ? "no-show" : "no-shows", "bad");
  }
}
function renderAttention(rows, events, now, progressInfo) {
  var box = byId("attn");
  box.textContent = "";
  var shown = 0;
  function notice(title, lines, cls) {
    var item = div("att" + (cls ? " " + cls : ""));
    item.appendChild(div("k", title));
    lines.forEach((line) => {
      item.appendChild(div("t", line));
    });
    box.appendChild(item);
    shown++;
    return item;
  }
  var needLook = rows.filter(
    (row) => !row.override && (row.status === "canceled" || row.status === "rescheduled" || row.status === "noshow"),
  );
  if (needLook.length) {
    var lines = needLook
      .slice(0, 4)
      .map(
        (row) =>
          row.name +
          ": " +
          row.stage +
          (row.status === "noshow"
            ? " no-show"
            : row.status === "rescheduled"
              ? " was rescheduled, new time not booked"
              : " was canceled and not rebooked"),
      );
    if (needLook.length > 4) {
      lines.push("and " + (needLook.length - 4) + " more");
    }
    notice("Needs a look", lines, "warn");
  }
  dupes(rows)
    .slice(0, 3)
    .forEach((pair) => {
      var dupCard = notice("Possible duplicate company", [pair.an + " and " + pair.bn + " look like the same company."], "warn");
      var button = el("button", null, "Combine");
      button.title = "Saved: " + pair.bn + " will count as " + pair.an + " for every candidate.";
      button.addEventListener("click", () => {
        button.disabled = true;
        saveJoin(pair.b, pair.a, dupCard, () => {
          button.disabled = false;
        });
      });
      dupCard.appendChild(button);
    });
  box.style.display = shown ? "" : "none";
}
// Saves "company from is the same as company to" (to "" separates it again) for every candidate, then redraws.
function saveJoin(from: string, to: string, msgBox: HTMLElement, onFailed?: () => void) {
  var msg = msgBox.querySelector<HTMLElement>(".jmsg") || div("sub jmsg", "");
  msg.setAttribute("role", "status");
  msgBox.appendChild(msg);
  sendPut(
    "/api/joins",
    { from: from, to: to },
    msg,
    false,
    (info) => {
      savedJoins = info.joins || {};
      if (!byId("panel").hidden) {
        closePanel();
      }
      renderAnalysis();
    },
    onFailed,
  );
}
// "Same company as…" under a company's name: combine it with another row, or separate a name combined into it earlier.
function sameCompanyMenu(row, rows) {
  var others = rows.filter((other) => other.key !== row.key);
  var joinedHere = row.rawKeys.filter((name, index, all) => savedJoins[name] && all.indexOf(name) === index);
  if (!others.length && !joinedHere.length) {
    return null;
  }
  var select = el("select", "samesel");
  select.setAttribute("aria-label", "Same company as another row");
  select.title = "Same company as…";
  function option(value, text) {
    var item = el("option", null, text);
    item.value = value;
    select.appendChild(item);
  }
  option("", "Same company as…");
  others.forEach((other) => {
    option("j:" + other.key, other.name);
  });
  joinedHere.forEach((name) => {
    var typed = row.aliases.concat([row.name]).find((alias) => alias.toLowerCase() === name) || niceName(name);
    option("s:" + name, "Separate “" + typed + "” again");
  });
  var box = div("samebox");
  select.addEventListener("change", () => {
    var value = select.value;
    select.disabled = true;
    var reset = () => {
      select.disabled = false;
      select.value = "";
    };
    if (value.slice(0, 2) === "j:") {
      saveJoin(row.key, value.slice(2), box, reset);
    } else if (value.slice(0, 2) === "s:") {
      saveJoin(value.slice(2), "", box, reset);
    } else {
      reset();
    }
  });
  box.appendChild(select);
  return box;
}
// ---- Phones: one short row per company (name, round steps, status, next/last date); tap for the details sheet.
// Active companies first; ones that ended (canceled, no-show, not cleared, withdrew) fold under "Show N closed".
var showClosed = false;
function isClosed(row) {
  return row.override ? row.override === "notcleared" || row.override === "withdrew" : row.status === "canceled" || row.status === "noshow";
}
function whenShort(row) {
  var when = new Date(row.whenIso);
  return (
    row.whenLabel +
    " · " +
    fmt(
      {
        weekday: "short",
        day: "numeric",
        month: "short",
      },
      when,
    ) +
    ", " +
    t12(when)
  );
}
function phoneList(shown, rows, now) {
  var box = div("mco");
  var open = shown.filter((row) => !isClosed(row));
  var closed = shown.filter((row) => isClosed(row));
  // a grouped-list row: coloured initial, name, "3rd round · Next Sun, Sep 27", status, chevron
  function item(row) {
    var button = el("button", "mrow tone-" + (row.badgeCls || "wait"));
    button.type = "button";
    button.appendChild(span("mic", (row.name.trim().charAt(0) || "?").toUpperCase()));
    var text = div("mtx");
    text.appendChild(el("b", null, row.name));
    var when = new Date(row.whenIso);
    text.appendChild(
      span(
        "msub",
        row.stage +
          " · " +
          (row.status === "booked" ? "Next " : "") +
          fmt(
            {
              weekday: "short",
              day: "numeric",
              month: "short",
            },
            when,
          ),
      ),
    );
    button.appendChild(text);
    button.appendChild(span("mst", row.badge));
    button.addEventListener("click", () => {
      openCompany(row, rows, now);
    });
    return button;
  }
  var group = div("mgroup");
  (open.length ? open : closed).forEach((row) => {
    group.appendChild(item(row));
  });
  box.appendChild(group);
  if (open.length && closed.length) {
    var closedHead = div("mhead", "Closed");
    var closedGroup = div("mgroup");
    closed.forEach((row) => {
      closedGroup.appendChild(item(row));
    });
    closedHead.hidden = closedGroup.hidden = !showClosed;
    var toggle = el("button", "mmore");
    toggle.type = "button";
    var label = () => {
      toggle.textContent = showClosed ? "Hide closed companies" : "Show " + closed.length + " closed " + (closed.length === 1 ? "company" : "companies");
      toggle.setAttribute("aria-expanded", String(showClosed));
    };
    label();
    toggle.addEventListener("click", () => {
      showClosed = !showClosed;
      closedHead.hidden = closedGroup.hidden = !showClosed;
      label();
    });
    group.appendChild(toggle);
    box.appendChild(closedHead);
    box.appendChild(closedGroup);
  }
  return box;
}
// The details for one company in the side/bottom sheet: status, dates, every round, and "Same company as…".
function openCompany(row, rows, now) {
  reqId++;
  takeEv = null;
  byId("ptitle").textContent = row.name;
  byId("psub").textContent =
    row.count + (row.count === 1 ? " interview" : " interviews") + (row.aliases.length ? " · also entered as " + row.aliases.join(", ") : "");
  var list = byId("plist");
  list.textContent = "";
  var head = div("mc-head");
  var stageLine = div("mc-stage");
  stageLine.appendChild(el("b", null, row.stage));
  stageLine.appendChild(span("badge " + row.badgeCls, row.badge));
  head.appendChild(stageLine);
  head.appendChild(div("sub", row.statusText));
  if (row.cleared.length) {
    head.appendChild(div("sub cleared", "Cleared: " + row.cleared.join(", ")));
  }
  if (row.note) {
    head.appendChild(div("sub", row.note));
  }
  head.appendChild(div("mc-when", whenShort(row)));
  list.appendChild(head);
  var rounds = div("mc-rounds");
  rounds.appendChild(div("ksec", "Rounds"));
  row.events
    .slice()
    .sort((first, second) => Date.parse(first.start) - Date.parse(second.start))
    .forEach((event) => {
      var kind = evState(event, now);
      var line = div("mc-r " + kind);
      line.appendChild(span("mstep " + kind, roundShort(event.round)));
      var text = div("mc-rt");
      text.appendChild(el("b", null, event.round || "Interview"));
      text.appendChild(
        span(
          "sub",
          fmt(
            {
              weekday: "short",
              day: "numeric",
              month: "short",
            },
            new Date(event.start),
          ) +
            ", " +
            t12(new Date(event.start)),
        ),
      );
      line.appendChild(text);
      line.appendChild(span("mc-rs", STATE_LABEL[kind]));
      rounds.appendChild(line);
    });
  list.appendChild(rounds);
  var menu = sameCompanyMenu(row, rows);
  if (menu) {
    var same = div("mc-same");
    same.appendChild(span("sub", "Same company as another row?"));
    same.appendChild(menu);
    list.appendChild(same);
  }
  showPanel(true);
}
function renderCompanies(rows, now) {
  var gridBox = byId("cgrid");
  var legend = byId("cleg");
  var sub = byId("csub");
  var oldGrid = gridBox.querySelector(".pgrid");
  var scrollTop = oldGrid ? oldGrid.scrollTop : 0;
  gridBox.textContent = "";
  legend.textContent = "";
  if (!rows.length) {
    sub.textContent = "";
    gridBox.appendChild(div("cempty", "No bookings yet."));
    return;
  }
  var query = byId<HTMLInputElement>("cs").value.trim().toLowerCase();
  // phones only show the company search when there are enough companies to need it
  byId("cProg").classList.toggle("few", rows.length <= 8 && !query);
  var shown = query ? rows.filter((row) => (row.name + " " + row.aliases.join(" ")).toLowerCase().indexOf(query) >= 0) : rows;
  sub.textContent = query ? shown.length + " of " + rows.length + " match" : rows.length + (rows.length === 1 ? " company" : " companies");
  if (shown.length) {
    var starts = [];
    rows.forEach((row) => {
      row.events.forEach((event) => {
        starts.push(Date.parse(event.start));
      });
    });
    var firstDay = dayNum(ymd(new Date(Math.min.apply(null, starts))));
    var dayCount = Math.max(dayNum(ymd(new Date(Math.max.apply(null, starts)))), dayNum(ymd(new Date(now)))) - firstDay + 1;
    var table = div("pgrid");
    var header = div("grow ghead");
    ["Company", "Current stage", "Next / last"].forEach((title) => {
      header.appendChild(div(null, title));
    });
    var i;
    var axisCell = el("div");
    var axis = div("tl-track axis");
    var ticks = Math.min(dayCount, 6);
    for (i = 0; i < ticks; i++) {
      var day = ticks === 1 ? 0 : Math.round((i * (dayCount - 1)) / (ticks - 1));
      var tick = span("tl-tick", dayLabel(day));
      tick.style.left = ((day + 0.5) / dayCount) * 100 + "%";
      axis.appendChild(tick);
    }
    axisCell.appendChild(axis);
    header.appendChild(axisCell);
    table.appendChild(header);
    shown.forEach((row) => {
      // the row's accent follows its status: green cleared/offer, blue upcoming, amber waiting on something, red ended
      var line = div("grow tone-" + (row.badgeCls || "wait"));
      var companyCell = el("div");
      companyCell.setAttribute("data-l", "Company");
      var nameLine = div("cname");
      nameLine.appendChild(el("b", null, row.name));
      companyCell.appendChild(nameLine);
      companyCell.appendChild(div("sub", row.count + (row.count === 1 ? " interview" : " interviews")));
      if (row.aliases.length) {
        companyCell.appendChild(div("sub", "Also entered as: " + row.aliases.join(", ")));
      }
      var menu = sameCompanyMenu(row, rows);
      if (menu) {
        nameLine.appendChild(menu);
      }
      var stageCell = el("div");
      stageCell.setAttribute("data-l", "Current stage");
      stageCell.appendChild(div("stage", row.stage));
      var badgeLine = div("stline");
      badgeLine.appendChild(span("badge " + row.badgeCls, row.badge));
      stageCell.appendChild(badgeLine);
      stageCell.appendChild(div("sub", row.statusText));
      if (row.cleared.length) {
        stageCell.appendChild(div("sub cleared", "Cleared: " + row.cleared.join(", ")));
      }
      if (row.note) {
        stageCell.appendChild(div("sub", row.note));
      }
      var whenCell = el("div");
      whenCell.setAttribute("data-l", "Next / last");
      var when = new Date(row.whenIso);
      whenCell.appendChild(div("sub", row.whenLabel));
      whenCell.appendChild(
        div(
          "nwhen",
          fmt(
            {
              weekday: "short",
              day: "numeric",
              month: "short",
            },
            when,
          ) +
            " · " +
            t12(when),
        ),
      );
      var journey = el("div");
      journey.setAttribute("data-l", "Journey");
      var dots = row.events
        .slice()
        .sort((first, second) => Date.parse(first.start) - Date.parse(second.start))
        .map((event) => ({
          e: event,
          p: percentOf(Date.parse(event.start)),
        }));
      var laneEnds = [-1000000000, -1000000000, -1000000000];
      var lanes = 1;
      dots.forEach((dot) => {
        var lane;
        var chosen = -1;
        var oldest = 0;
        for (lane = 0; lane < 3; lane++) {
          if (dot.p - laneEnds[lane] >= 12) {
            chosen = lane;
            break;
          }
          if (laneEnds[lane] < laneEnds[oldest]) {
            oldest = lane;
          }
        }
        if (chosen < 0) {
          chosen = oldest;
        }
        dot.lane = chosen;
        laneEnds[chosen] = dot.p;
        if (chosen + 1 > lanes) {
          lanes = chosen + 1;
        }
      });
      var track = div("tl-track");
      track.style.height = (lanes === 1 ? 36 : lanes === 2 ? 58 : 80) + "px";
      track.appendChild(div("tl-line"));
      var todayLine = div("tl-today");
      todayLine.style.left = percentOf(now) + "%";
      track.appendChild(todayLine);
      dots.forEach((dot) => {
        var event = dot.e;
        var kind = evState(event, now);
        var start = new Date(event.start);
        var marker = span("tdot " + kind + (event.start === row.curStart ? " now" : ""), roundShort(event.round));
        marker.style.left = dot.p + "%";
        marker.style.top = ((dot.lane + 0.5) / lanes) * 100 + "%";
        marker.title =
          row.name +
          " · " +
          (event.round || "Interview") +
          " · " +
          fmt(
            {
              weekday: "short",
              day: "numeric",
              month: "short",
              year: "numeric",
            },
            start,
          ) +
          " · " +
          t12(start) +
          " · " +
          STATE_LABEL[kind];
        track.appendChild(marker);
      });
      journey.appendChild(track);
      var ends = div("tl-ends");
      ends.appendChild(span(null, dayLabel(0)));
      ends.appendChild(span(null, dayLabel(dayCount - 1)));
      journey.appendChild(ends);
      line.appendChild(companyCell);
      line.appendChild(stageCell);
      line.appendChild(whenCell);
      line.appendChild(journey);
      table.appendChild(line);
    });
    gridBox.appendChild(table);
    gridBox.appendChild(phoneList(shown, rows, now));
    legend.textContent = "";
    [
      ["done", "Completed"],
      ["upcoming", "Upcoming"],
      ["rescheduled", "Rescheduled"],
      ["canceled", "Canceled or no-show"],
      ["today", "Today"],
    ].forEach(function (entry) {
      legend.appendChild(span("lg2 " + entry[0], entry[1]));
    });
    table.scrollTop = scrollTop;
  } else {
    gridBox.appendChild(div("cempty", "No company matches your search."));
  }
  function percentOf(time) {
    var date = new Date(time);
    return ((dayNum(ymd(date)) - firstDay + mod(date) / 1440) / dayCount) * 100;
  }
  function dayLabel(offset) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(new Date((firstDay + offset) * DAY + 43200000));
  }
}
function roundFunnel(rows) {
  var box = el("div");
  box.appendChild(div("ksec", "How far each company got"));
  var rounds = [0, 1, 2, 3, 4]
    .map((bucket) => {
      var round = {
        label: ROUND_LABELS[bucket],
        n: 0,
        moved: 0,
        failed: 0,
        other: 0,
        wait: 0,
      };
      rows.forEach((company) => {
        if (!(company.attended.indexOf(bucket) < 0)) {
          round.n++;
          var override = company.override;
          if (company.maxB > bucket || (company.maxB === bucket && (override === "cleared" || override === "offer"))) {
            round.moved++;
          } else if (override === "notcleared") {
            round.failed++;
          } else if (override === "withdrew" || override === "hold") {
            round.other++;
          } else {
            round.wait++;
          }
        }
      });
      return round;
    })
    .filter((round) => round.n > 0);
  if (!rounds.length) {
    box.appendChild(div("why", "No numbered rounds yet."));
    return box;
  }
  var table = div("ptab");
  var head = div("pr h");
  ["Round", "Total", "Moved on", "Not cleared", "Hold / withdrew", "Waiting"].forEach((title) => {
    head.appendChild(div(null, title));
  });
  table.appendChild(head);
  rounds.forEach((round) => {
    var line = div("pr");
    line.appendChild(div(null, round.label));
    line.appendChild(div(null, String(round.n)));
    line.appendChild(div("g", round.moved + " (" + Math.round((round.moved / round.n) * 100) + "%)"));
    line.appendChild(div(round.failed ? "bd" : "", String(round.failed)));
    line.appendChild(div(null, String(round.other)));
    line.appendChild(div(null, String(round.wait)));
    table.appendChild(line);
  });
  box.appendChild(table);
  // phones: a plain funnel instead of the six-column table
  var funnel = div("mfun");
  var most = Math.max.apply(
    null,
    rounds.map((round) => round.n),
  );
  rounds.forEach((round) => {
    var line = div("mfr");
    line.appendChild(span("mfl", round.label));
    var track = div("mft");
    var fill = div("mff");
    fill.style.width = Math.max(6, Math.round((round.n / most) * 100)) + "%";
    track.appendChild(fill);
    line.appendChild(track);
    line.appendChild(el("b", null, String(round.n)));
    funnel.appendChild(line);
  });
  box.appendChild(funnel);
  var offers = rows.filter((row) => row.override === "offer").length;
  if (offers) {
    kvRow(box, "Offers", String(offers));
  }
  var unnumbered = rows.filter((row) => row.count > 0 && row.attended.length === 0).length;
  box.appendChild(
    div(
      "why",
      "Moved on means the company booked a later round, or you marked it Cleared or Offer. Not cleared, hold and withdrew come from Update results." +
        (unnumbered
          ? " " +
            unnumbered +
            (unnumbered === 1 ? " company has" : " companies have") +
            " round names without a number and " +
            (unnumbered === 1 ? "isn't" : "aren't") +
            " counted."
          : ""),
    ),
  );
  return box;
}
function weekStartOf(day) {
  var weekday = new Date(day + "T12:00:00Z").getUTCDay();
  return addDays(day, -(weekday + 6) % 7);
}
function weeklyChart(events, now) {
  var box = el("div");
  box.appendChild(div("ksec", "Interviews per week"));
  var i;
  var thisWeek = weekStartOf(ymd(new Date(now)));
  var weeks = [];
  for (i = -5; i <= 2; i++) {
    weeks.push(addDays(thisWeek, i * 7));
  }
  var counts = weeks.map(() => 0);
  events.forEach((event) => {
    if (event.status === "active") {
      var day = ymd(new Date(event.start));
      for (var j = 0; j < weeks.length; j++) {
        if (day >= weeks[j] && day <= addDays(weeks[j], 6)) {
          counts[j]++;
          break;
        }
      }
    }
  });
  var max = Math.max.apply(null, counts);
  if (!counts.reduce((sum, count) => sum + count, 0)) {
    box.appendChild(div("why", "No interviews in the last 6 weeks or the next 2."));
    return box;
  }
  function weekLabel(day) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
    }).format(new Date(day + "T12:00:00Z"));
  }
  var bars = div("vbars");
  weeks.forEach((week, index) => {
    var column = div("vcol" + (index === 5 ? " cur" : index > 5 ? " fut" : ""));
    column.title = "Week of " + weekLabel(week) + ": " + counts[index] + (counts[index] === 1 ? " interview" : " interviews");
    column.appendChild(div("vval", counts[index] ? String(counts[index]) : ""));
    var wrap = div("vwrap");
    var bar = div("vbar");
    bar.style.height = counts[index] ? Math.max(4, Math.round((counts[index] / max) * 70)) + "px" : "0px";
    wrap.appendChild(bar);
    column.appendChild(wrap);
    column.appendChild(div("vlab", weekLabel(week)));
    bars.appendChild(column);
  });
  box.appendChild(bars);
  kvRow(box, "This week", counts[5] + (counts[5] === 1 ? " interview" : " interviews"));
  kvRow(box, "Next 2 weeks", counts[6] + counts[7] + " booked");
  if (max >= 2) {
    var busiest = counts.indexOf(max);
    kvRow(box, "Busiest week", max + " interviews (week of " + weekLabel(weeks[busiest]) + ")");
  }
  return box;
}
function cancellations(events, counts) {
  if (!counts.resched && !counts.canceled && !counts.noshow) {
    return null;
  }
  var box = el("div");
  box.appendChild(div("ksec", "Cancellations and no-shows"));
  var canceled = events.filter((event) => event.status === "canceled");
  if (counts.resched) {
    kvRow(box, "Rescheduled", String(counts.resched));
  }
  if (counts.canceled) {
    kvRow(box, "Canceled", String(counts.canceled));
  }
  if (counts.noshow) {
    kvRow(box, "No-shows", String(counts.noshow));
  }
  var byCandidate = canceled.filter((event) => event.canceledBy === "invitee").length;
  var byYou = canceled.filter((event) => event.canceledBy === "host").length;
  if (byCandidate + byYou > 0) {
    kvRow(box, "Canceled by", "Candidate " + byCandidate + " · You " + byYou);
  }
  var reasons = canceled
    .filter((event) => event.cancelReason)
    .sort((first, second) => Date.parse(second.start) - Date.parse(first.start))
    .slice(0, 4);
  reasons.forEach((event) => {
    box.appendChild(
      div(
        "why",
        fmt(
          {
            day: "numeric",
            month: "short",
          },
          new Date(event.start),
        ) +
          " · " +
          (event.company || "Company not given") +
          " · " +
          (event.rescheduled ? "rescheduled" : "canceled") +
          ": " +
          event.cancelReason,
      ),
    );
  });
  if (canceled.length && !reasons.length) {
    box.appendChild(div("why", "No cancellation reasons were given."));
  }
  return box;
}
function whoInterviewed(events, now) {
  var byName = {};
  var recorded = 0;
  var missing = 0;
  events.forEach((event) => {
    if (event.status === "active" && !event.noShow && !(Date.parse(event.end) > now)) {
      var interviewer = ivMap[event.id];
      if (interviewer) {
        byName[interviewer] = (byName[interviewer] || 0) + 1;
        recorded++;
      } else {
        missing++;
      }
    }
  });
  if (!recorded) {
    return null;
  }
  var box = el("div");
  box.appendChild(div("ksec", "Who interviewed"));
  var most = Math.max.apply(
    null,
    Object.keys(byName).map((name) => byName[name]),
  );
  Object.keys(byName)
    .sort((first, second) => byName[second] - byName[first] || (first < second ? -1 : 1))
    .forEach((name) => {
      kvRow(box, name, byName[name] + (byName[name] === 1 ? " interview" : " interviews"), ivCls(name) + " hasbar");
      var track = div("ivtrack " + ivCls(name));
      var fill = div("ivfill");
      fill.style.width = Math.max(4, Math.round((byName[name] / most) * 100)) + "%";
      track.appendChild(fill);
      box.appendChild(track);
    });
  if (missing) {
    kvRow(box, "Not recorded", String(missing));
  }
  return box;
}
function onIv() {
  if (data && insightArgs) {
    renderInsights.apply(null, insightArgs);
  }
}
function renderInsights(events, rows, counts, progressInfo, now) {
  var section = sectionHead("cIns", "Insights", "");
  var cols = div("icols");
  cols.appendChild(roundFunnel(rows));
  var who = whoInterviewed(events, now);
  if (who) {
    cols.appendChild(who);
  }
  var cancels = cancellations(events, counts);
  if (cancels) {
    cols.appendChild(cancels);
  }
  // phones: each block is a row that opens on tap
  Array.prototype.forEach.call(cols.children, (block: HTMLElement) => {
    var title = block.querySelector<HTMLElement>(".ksec");
    if (title) {
      block.classList.add("iblock");
      title.setAttribute("role", "button");
      title.setAttribute("tabindex", "0");
      title.setAttribute("aria-expanded", "false");
      var toggle = () => {
        var open = !block.classList.contains("open");
        block.classList.toggle("open", open);
        title.setAttribute("aria-expanded", String(open));
      };
      title.addEventListener("click", toggle);
      title.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
  });
  section.appendChild(cols);
}
function renderAnalysis() {
  if (data) {
    var events = data.events;
    var now = Date.now();
    var counts = stats(events, now);
    var progressInfo = progress(events);
    var rows = progressInfo.rows;
    companyRows = rows;
    renderedAt = now;
    byId("aname").textContent = niceName(data.name);
    byId("av").textContent = avOf(data.name);
    var sub = byId("asub");
    sub.textContent = "";
    if (data.emails > 1) {
      sub.appendChild(span("long", "Combined from " + data.emails + " email addresses"));
      sub.appendChild(span("short", data.emails + " emails"));
      sub.appendChild(document.createTextNode(" · "));
      addLink("Show separately", () => {
        setMerge(false);
      });
    } else if (!merge) {
      sub.appendChild(document.createTextNode("Showing one email address only · "));
      addLink("Combine again", () => {
        setMerge(true);
      });
    }
    byId("hist").hidden = false;
    byId("reslink").hidden = false;
    renderSummary(events, rows, counts, now);
    renderAttention(rows, events, now, progressInfo);
    renderCompanies(rows, now);
    insightArgs = [events, rows, counts, progressInfo, now];
    renderInsights(events, rows, counts, progressInfo, now);
    ["sumline", "attn", "cgrid", "cIns"].forEach((id) => {
      var node = byId(id);
      node.classList.remove("enter");
      node.offsetWidth;
      node.classList.add("enter");
    });
    if (panelMode === "res" && !byId("panel").hidden) {
      renderResultsPanel();
    }
    renderedTz = state.tz;
  }
  function addLink(text, onClick) {
    var button = el("button", "linkbtn", text);
    button.addEventListener("click", onClick);
    sub.appendChild(button);
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
byId("hist").onclick = () => {
  if (chosen) {
    panelMode = "";
    openPerson({
      id: chosen.event,
      invitee: data ? data.name : chosen.name,
    });
  }
};
byId("reslink").onclick = openResults;
byId<HTMLInputElement>("cs").addEventListener("input", () => {
  renderCompanies(companyRows, renderedAt);
});
var eventParam = new URLSearchParams(location.search).get("event");
if (eventParam && /^[0-9a-f-]{36}$/i.test(eventParam)) {
  chosen = {
    name: "",
    event: eventParam,
  };
  pickerOpen = false;
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
