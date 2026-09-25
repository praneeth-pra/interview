import { el, initial } from "./dom";
import { ICONS } from "./icons";
import { formatIst, formatRange, formatTime, middayOf, todayKey } from "./time";
import { companies, loadCompanies, suggestCompanies } from "./companies";

// The booking page: pick a length, day and time, enter details, confirm. The same page handles the
// candidate's manage link (/b/<id>?t=...): reschedule or cancel an existing booking.
type Step = "pick" | "details" | "confirm" | "done" | "manage" | "cancel" | "msg";
type Day = { key: string; open: boolean };
type Booking = {
  id: string;
  name: string;
  email: string;
  start: string;
  end: string;
  duration: number;
  manage?: string;
  emailed?: boolean;
};
// Set when the page is opened from a manage link; `error` when the link is invalid.
type Manage = {
  id: string;
  t: string;
  name: string;
  email: string;
  start: string;
  end: string;
  duration: number;
  cancelled: boolean;
  past: boolean;
  error?: string;
};
type Message = { title: string; body: string; check?: boolean; again?: boolean; manage?: boolean };
type FieldOptions = { req?: boolean; ac?: string; max?: number; list?: string; ph?: string };
type State = {
  dur: number; // meeting length in minutes
  days: Day[];
  openSet: Record<string, 1>; // days with free times
  viewY: number; // month shown in the calendar
  viewM: number;
  date: string | null; // chosen day, "YYYY-MM-DD"
  slots: number[] | null; // free start times on that day (ms); null while loading
  slot: number | null; // chosen start time
  step: Step;
  booking: Booking | null; // the booking just made
  err: string;
  fieldErr: Record<string, string>;
  form: { name: string; email: string; company: string; round: string };
  busy: boolean;
  anim?: boolean; // slide the times list in on the next render
  nameAuto?: boolean; // the name was filled in from an earlier booking
  reason?: string; // cancellation reason being typed
  msg?: Message | null;
};

var boot = JSON.parse(document.getElementById("boot").textContent);
var hostName = boot.host;
var eventName = boot.event;
var manage: Manage | null = boot.manage;
var info = boot.info;
var DURATIONS = [30, 60, 90];
var state: State = {
  dur: 30,
  days: [],
  openSet: {},
  viewY: 0,
  viewM: 0,
  date: null,
  slots: null,
  slot: null,
  step: "pick",
  booking: null,
  err: "",
  fieldErr: {},
  form: {
    name: "",
    email: "",
    company: "",
    round: "",
  },
  busy: false,
};
var card = document.getElementById("card");
var ignoreQuery = manage && manage.id ? "&ignore=" + manage.id + "&t=" + manage.t : "";
function loadDays(keepView?: boolean) {
  return fetch("/api/days?duration=" + state.dur + ignoreQuery)
    .then(function (res) {
      return res.json();
    })
    .then(function (data) {
      state.days = data.days;
      state.openSet = {};
      data.days.forEach(function (day) {
        if (day.open) {
          state.openSet[day.key] = 1;
        }
      });
      if (!keepView || !state.viewY) {
        var first =
          data.days.filter(function (day) {
            return day.open;
          })[0] || data.days[0];
        if (first) {
          state.viewY = +first.key.slice(0, 4);
          state.viewM = +first.key.slice(5, 7);
        }
      }
      if (state.date && !state.openSet[state.date]) {
        state.date = null;
        state.slots = null;
        state.slot = null;
      }
      render();
    })
    .catch(function () {
      state.err = "Couldn't load available dates. Refresh the page to try again.";
      render();
    });
}
var slotCache = {};
var slotRequests = {};
function fetchSlots(date: string, duration: number, refresh?: boolean): Promise<number[] | null> {
  var key = date + ":" + duration;
  if (refresh || !slotRequests[key]) {
    slotRequests[key] = fetch("/api/slots?date=" + date + "&duration=" + duration + ignoreQuery)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        slotCache[key] = data.slots || [];
        return slotCache[key];
      })
      .catch(function () {
        delete slotRequests[key];
        return null;
      });
  }
  return slotRequests[key];
}
function scrollToTimes() {
  if (window.innerWidth <= 900) {
    var heading = document.getElementById("timesh");
    if (heading) {
      heading.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }
}
function showSlots(scroll?: boolean) {
  var key = state.date + ":" + state.dur;
  var cached = !!slotCache[key];
  state.slot = null;
  state.slots = slotCache[key] || null;
  render();
  if (cached && scroll) {
    scrollToTimes();
  }
  fetchSlots(state.date, state.dur, cached).then(function (slots) {
    if (key === state.date + ":" + state.dur) {
      if (!slots) {
        if (!state.slots) {
          state.slots = [];
          render();
        }
        return;
      }
      if (!state.slots) {
        state.slots = slots;
        render();
        if (scroll) {
          scrollToTimes();
        }
        return;
      }
      if (slots.join() !== state.slots.join()) {
        state.slots = slots;
        if (state.slot && slots.indexOf(state.slot) < 0) {
          state.slot = null;
        }
        render();
      }
    }
  });
}
function render() {
  var focusedId = document.activeElement && document.activeElement.id;
  var list = card.querySelector(".tlist");
  var scrollTop = list && !state.anim ? list.scrollTop : 0;
  card.innerHTML = "";
  card.className =
    "card" + (state.step !== "pick" || !state.date ? " narrow" : "") + (state.step === "details" ? " details" : "");
  if (state.step === "done") {
    return renderDone();
  }
  if (state.step === "msg") {
    return renderMessage();
  }
  card.appendChild(renderInfo());
  var main = el("div", {
    class: "main",
  });
  if (state.step === "pick") {
    main.appendChild(renderCalendar());
    if (state.date) {
      main.appendChild(renderTimes());
    }
  } else if (state.step === "manage") {
    main.appendChild(renderManage());
  } else if (state.step === "cancel") {
    main.appendChild(renderCancel());
  } else if (state.step === "confirm") {
    main.appendChild(renderConfirm());
  } else {
    main.appendChild(renderDetails());
  }
  card.appendChild(main);
  state.anim = false;
  if (scrollTop && (list = card.querySelector(".tlist"))) {
    list.scrollTop = scrollTop;
  }
  if (focusedId && document.getElementById(focusedId)) {
    document.getElementById(focusedId).focus({
      preventScroll: true,
    });
  }
}
function renderInfo() {
  var backTo: Step | null =
    state.step === "details" || state.step === "confirm"
      ? "pick"
      : manage && (state.step === "pick" || state.step === "cancel")
        ? "manage"
        : null;
  var section = el("section", {
    class: "info" + (backTo ? " has-back" : ""),
  });
  if (backTo) {
    card.appendChild(
      el("button", {
        class: "back",
        id: "back",
        "aria-label": backTo === "pick" ? "Back to times" : "Back to your interview",
        html: ICONS.left,
        onclick: function () {
          state.step = backTo;
          state.err = "";
          render();
          if (backTo === "pick" && !state.days.length) {
            loadDays();
          }
        },
      }),
    );
  }
  section.appendChild(
    el(
      "p",
      {
        class: "host",
      },
      [
        el(
          "span",
          {
            class: "mark",
            "aria-hidden": "true",
          },
          [(hostName || "?").trim().charAt(0).toUpperCase()],
        ),
        hostName,
      ],
    ),
  );
  section.appendChild(
    el(
      "h1",
      {
        class: "ev",
      },
      [eventName],
    ),
  );
  var onDetails = state.step === "details";
  if (state.step === "pick") {
    var lengths = el("div", {
      class: "dur-opts",
      role: "group",
      "aria-label": "Meeting length",
    });
    DURATIONS.forEach(function (minutes) {
      lengths.appendChild(
        el(
          "button",
          {
            type: "button",
            id: "dur" + minutes,
            "aria-pressed": String(state.dur === minutes),
            onclick: function () {
              if (state.dur !== minutes) {
                state.dur = minutes;
                state.slot = null;
                loadDays(true).then(function () {
                  if (state.date) {
                    showSlots();
                  }
                });
              }
            },
          },
          [minutes + " min"],
        ),
      );
    });
    section.appendChild(
      el(
        "div",
        {
          class: "dur",
        },
        [
          el("div", {
            class: "dur-l",
            html: ICONS.clock + "<span>Meeting length</span>",
          }),
          lengths,
        ],
      ),
    );
  }
  var meta = el("ul", {
    class: "meta",
  });
  if (onDetails) {
    meta.appendChild(
      el("li", {
        html: ICONS.clock + "<span>" + state.dur + " min</span>",
      }),
    );
    meta.appendChild(
      el("li", {
        class: "hl",
        html: ICONS.cal + "<span></span>",
      }),
    );
    meta.lastChild.lastChild.textContent = formatRange(state.slot, state.dur);
    meta.appendChild(
      el("li", {
        html: ICONS.globe + "<span>India Standard Time</span>",
      }),
    );
  } else if (manage && (state.step === "manage" || state.step === "cancel")) {
    meta.appendChild(
      el("li", {
        html: ICONS.clock + "<span>" + manage.duration + " min</span>",
      }),
    );
    meta.appendChild(
      el("li", {
        class: "hl",
        html: ICONS.cal + "<span></span>",
      }),
    );
    meta.lastChild.lastChild.textContent = formatRange(Date.parse(manage.start), manage.duration);
    meta.appendChild(
      el("li", {
        html: ICONS.globe + "<span>India Standard Time</span>",
      }),
    );
  }
  if (info.loc) {
    meta.appendChild(
      el("li", {
        html: ICONS.pin + "<span></span>",
      }),
    );
    meta.lastChild.lastChild.textContent = info.loc;
  }
  section.appendChild(meta);
  if (info.desc) {
    var desc = el("p", {
      class: "desc",
      html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 9v4.6M10 6.4v.1" stroke-linecap="round"/></svg><span></span>',
    });
    desc.lastChild.textContent = info.desc;
    section.appendChild(desc);
  }
  return section;
}
function renderCalendar() {
  var section = el("section", {
    class: "pick",
    "aria-labelledby": "pickh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "pickh",
      },
      [manage ? "Pick a New Date & Time" : "Select a Date & Time"],
    ),
  );
  if (manage) {
    section.appendChild(
      el(
        "p",
        {
          class: "was",
        },
        ["Currently " + formatRange(Date.parse(manage.start), manage.duration)],
      ),
    );
  }
  if (state.err) {
    section.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  var year = state.viewY;
  var month = state.viewM;
  if (!year) {
    section.appendChild(
      el("div", {
        class: "spin",
        "aria-label": "Loading",
      }),
    );
    return section;
  }
  var firstKey = state.days.length ? state.days[0].key : "";
  var lastKey = state.days.length ? state.days[state.days.length - 1].key : "";
  function monthKey(y, m) {
    return y + "-" + String(m).padStart(2, "0");
  }
  var canPrev = firstKey && firstKey.slice(0, 7) < monthKey(year, month);
  var canNext = lastKey && lastKey.slice(0, 7) > monthKey(year, month);
  var monthLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
  section.appendChild(
    el(
      "div",
      {
        class: "mhead",
      },
      [
        el("button", {
          class: "nav",
          id: "prevm",
          type: "button",
          "aria-label": "Previous month",
          disabled: !canPrev,
          html: ICONS.left,
          onclick: function () {
            state.viewM--;
            if (state.viewM < 1) {
              state.viewM = 12;
              state.viewY--;
            }
            render();
          },
        }),
        el(
          "div",
          {
            class: "m",
            "aria-live": "polite",
          },
          [monthLabel],
        ),
        el("button", {
          class: "nav",
          id: "nextm",
          type: "button",
          "aria-label": "Next month",
          disabled: !canNext,
          html: ICONS.right,
          onclick: function () {
            state.viewM++;
            if (state.viewM > 12) {
              state.viewM = 1;
              state.viewY++;
            }
            render();
          },
        }),
      ],
    ),
  );
  var grid = el("div", {
    class: "grid",
    role: "grid",
    "aria-label": monthLabel,
  });
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach(function (weekday) {
    grid.appendChild(
      el(
        "div",
        {
          class: "wd",
          "aria-hidden": "true",
        },
        [weekday],
      ),
    );
  });
  for (
    var leadingBlanks = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7,
      daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(),
      today = todayKey(),
      blank = 0;
    blank < leadingBlanks;
    blank++
  ) {
    grid.appendChild(el("div"));
  }
  for (var dayOfMonth = 1; dayOfMonth <= daysInMonth; dayOfMonth++) {
    (function (day) {
      var key = monthKey(year, month) + "-" + String(day).padStart(2, "0");
      var isOpen = !!state.openSet[key];
      var className = "day" + (isOpen ? " open" : "") + (key === today ? " today" : "");
      var label = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date(Date.UTC(year, month - 1, day)));
      if (isOpen) {
        grid.appendChild(
          el(
            "button",
            {
              type: "button",
              class: className,
              id: "d" + key,
              "aria-pressed": String(state.date === key),
              "aria-label": label + (key === today ? ", today" : "") + ", times available",
              onpointerenter: function () {
                fetchSlots(key, state.dur);
              },
              onclick: function () {
                if (state.date !== key) {
                  state.date = key;
                  state.anim = true;
                  showSlots(true);
                }
              },
            },
            [String(day)],
          ),
        );
      } else {
        grid.appendChild(
          el(
            "div",
            {
              class: className,
              "aria-label": label + ", no times available",
            },
            [String(day)],
          ),
        );
      }
    })(dayOfMonth);
  }
  section.appendChild(grid);
  var tz = el("span", {
    html: ICONS.globe + "<span></span>",
  });
  tz.lastChild.textContent = "India Standard Time (" + formatTime(Date.now()) + ")";
  section.appendChild(
    el(
      "div",
      {
        class: "tz",
      },
      [el("b", null, ["Time zone"]), tz],
    ),
  );
  return section;
}
function renderTimes() {
  var section = el("section", {
    class: "times" + (state.anim ? " anim" : ""),
    "aria-labelledby": "timesh",
  });
  section.appendChild(
    el(
      "h3",
      {
        id: "timesh",
      },
      [
        formatIst(middayOf(state.date), {
          weekday: "long",
          month: "long",
          day: "numeric",
        }),
      ],
    ),
  );
  var list = el("div", {
    class: "tlist",
  });
  if (state.slots === null) {
    list.appendChild(
      el("div", {
        class: "spin",
        "aria-label": "Loading times",
      }),
    );
  } else if (state.slots.length) {
    state.slots.forEach(function (ms) {
      var selected = state.slot === ms;
      var row = el("div", {
        class: "slot" + (selected ? " sel" : ""),
      });
      row.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "t",
            id: "s" + ms,
            "aria-pressed": String(selected),
            onclick: function () {
              toggleSlot(ms);
            },
          },
          [formatTime(ms)],
        ),
      );
      if (selected) {
        row.appendChild(nextButton(ms));
      }
      list.appendChild(row);
    });
  } else {
    list.appendChild(
      el(
        "p",
        {
          class: "empty",
        },
        ["No times left on this day. Pick another date."],
      ),
    );
  }
  section.appendChild(list);
  return section;
}
function nextButton(ms) {
  return el(
    "button",
    {
      type: "button",
      class: "go",
      id: "go",
      "aria-label": (manage ? "Next: confirm " : "Next: enter your details for ") + formatTime(ms),
      onclick: function () {
        state.err = "";
        if (manage) {
          state.step = "confirm";
          render();
          var confirmButton = document.getElementById("rsgo");
          if (confirmButton) {
            confirmButton.focus();
          }
          return;
        }
        state.step = "details";
        state.fieldErr = {};
        render();
        var firstField = document.getElementById(state.form.email ? "fname" : "femail");
        if (firstField) {
          firstField.focus();
        }
      },
    },
    ["Next"],
  );
}
function toggleSlot(ms) {
  var previous = card.querySelector<HTMLElement>(".slot.sel");
  if (previous) {
    previous.classList.remove("sel");
    (previous.firstChild as HTMLElement).setAttribute("aria-pressed", "false");
    if ((previous.lastChild as HTMLElement).className === "go") {
      previous.removeChild(previous.lastChild);
    }
  }
  if (state.slot === ms) {
    state.slot = null;
    return;
  }
  state.slot = ms;
  var button = document.getElementById("s" + ms);
  if (!button) {
    return render();
  }
  (button.parentNode as HTMLElement).classList.add("sel");
  button.setAttribute("aria-pressed", "true");
  var next = nextButton(ms);
  button.parentNode.appendChild(next);
  next.focus({
    preventScroll: true,
  });
}
function textField(id: string, key: keyof State["form"], label: string, type: string, opts?: FieldOptions) {
  opts = opts || {};
  var error = state.fieldErr[key];
  var input = el("input", {
    id: id,
    type: type,
    name: key,
    autocomplete: opts.ac || "off",
    required: !!opts.req,
    "aria-invalid": error ? "true" : null,
    "aria-describedby": error ? id + "e" : null,
    list: opts.list || null,
    placeholder: opts.ph || null,
    maxlength: opts.max || 120,
  });
  input.value = state.form[key];
  input.addEventListener("input", function () {
    state.form[key] = input.value;
    if (state.fieldErr[key]) {
      delete state.fieldErr[key];
      input.removeAttribute("aria-invalid");
      var errorEl = document.getElementById(id + "e");
      if (errorEl) {
        errorEl.remove();
      }
    }
  });
  var children: HTMLElement[] = [
    el(
      "label",
      {
        for: id,
      },
      [label + (opts.req ? " *" : "")],
    ),
    input,
  ];
  if (error) {
    children.push(
      el(
        "div",
        {
          class: "ferr",
          id: id + "e",
        },
        [error],
      ),
    );
  }
  return el(
    "div",
    {
      class: "f",
    },
    children,
  );
}
function roundField() {
  var field = textField("fround", "round", "Interview round", "text", {
    max: 60,
  });
  var input = field.querySelector("input");
  var chips = el("div", {
    class: "rchips",
    role: "group",
    "aria-label": "Common rounds",
  });
  var buttons = [];
  function syncPressed() {
    var current = input.value.trim().toLowerCase();
    buttons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-v").toLowerCase() === current));
    });
  }
  [
    ["1st", "1st round"],
    ["2nd", "2nd round"],
    ["3rd", "3rd round"],
    ["Manager", "Manager round"],
    ["HR", "HR round"],
    ["Final", "Final round"],
    ["Demo", "Demo"],
  ].forEach(function (preset) {
    var button = el(
      "button",
      {
        type: "button",
        class: "rchip",
        "data-v": preset[1],
        "aria-label": preset[1],
      },
      [preset[0]],
    );
    button.addEventListener("click", function () {
      input.value = button.getAttribute("aria-pressed") === "true" ? "" : preset[1];
      input.dispatchEvent(
        new Event("input", {
          bubbles: true,
        }),
      );
    });
    buttons.push(button);
    chips.appendChild(button);
  });
  input.addEventListener("input", syncPressed);
  syncPressed();
  field.insertBefore(chips, input.nextSibling);
  return field;
}
function companyField() {
  var id = "fcompany";
  var listId = "fcompany-list";
  var matches = [];
  var active = -1;
  var input = el("input", {
    id: id,
    type: "text",
    name: "company",
    autocomplete: "off",
    spellcheck: "false",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": listId,
    maxlength: 120,
  });
  input.value = state.form.company;
  var list = el("ul", {
    class: "cb-list",
    id: listId,
    role: "listbox",
    "aria-label": "Company suggestions",
    hidden: true,
  });
  function close() {
    list.hidden = true;
    list.innerHTML = "";
    matches = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function highlight(index: number, scroll?: boolean) {
    active = index;
    for (var k = 0; k < list.children.length; k++) {
      list.children[k].setAttribute("aria-selected", String(k === index));
    }
    if (index < 0) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    input.setAttribute("aria-activedescendant", listId + "-" + index);
    if (scroll) {
      list.children[index].scrollIntoView({
        block: "nearest",
      });
    }
  }
  function choose(index) {
    input.value = matches[index].name;
    state.form.company = matches[index].name;
    close();
  }
  function update() {
    if (document.activeElement === input) {
      if (!companies) {
        loadCompanies(update);
        return;
      }
      var query = input.value.trim();
      matches = suggestCompanies(query);
      if (matches.length === 1 && matches[0].name.toLowerCase() === query.toLowerCase()) {
        matches = [];
      }
      if (!matches.length) {
        return close();
      }
      list.innerHTML = "";
      var lower = query.toLowerCase();
      matches.forEach(function (match, index) {
        var label = el("span", {
          class: "cb-n",
        });
        var at = match.name.toLowerCase().indexOf(lower);
        if (at >= 0) {
          label.appendChild(document.createTextNode(match.name.slice(0, at)));
          label.appendChild(el("b", null, [match.name.slice(at, at + query.length)]));
          label.appendChild(document.createTextNode(match.name.slice(at + query.length)));
        } else {
          label.appendChild(document.createTextNode(match.name));
        }
        var option = el(
          "li",
          {
            id: listId + "-" + index,
            class: "cb-opt",
            role: "option",
            "aria-selected": "false",
          },
          [
            label,
            match.via
              ? el(
                  "span",
                  {
                    class: "cb-a",
                  },
                  [match.via],
                )
              : null,
          ],
        );
        option.addEventListener("mousedown", function (event) {
          event.preventDefault();
        });
        option.addEventListener("mousemove", function () {
          if (active !== index) {
            highlight(index, false);
          }
        });
        option.addEventListener("click", function () {
          choose(index);
        });
        list.appendChild(option);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
    }
  }
  input.addEventListener("input", function () {
    state.form.company = input.value;
    update();
  });
  input.addEventListener("focus", function () {
    loadCompanies();
  });
  input.addEventListener("blur", close);
  input.addEventListener("keydown", function (event) {
    var open = !list.hidden;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (open) {
        highlight(active < matches.length - 1 ? active + 1 : 0, true);
      } else {
        update();
      }
    } else if (event.key === "ArrowUp") {
      if (open) {
        event.preventDefault();
        highlight(active > 0 ? active - 1 : matches.length - 1, true);
      }
    } else if (event.key === "Enter") {
      if (open && active >= 0) {
        event.preventDefault();
        choose(active);
      } else if (open) {
        close();
      }
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
    } else if (event.key === "Tab" && open && active >= 0) {
      choose(active);
    }
  });
  return el(
    "div",
    {
      class: "f",
    },
    [
      el(
        "label",
        {
          for: id,
        },
        ["Company"],
      ),
      el(
        "div",
        {
          class: "cbw",
        },
        [input, list],
      ),
    ],
  );
}
var nameCache = {};
var lookupTimer = null;
var WELCOME_BACK = "Welcome back. We filled in the name from your earlier booking.";
function setNameHint(text) {
  var hint = document.getElementById("fnameh");
  if (hint) {
    hint.textContent = text;
  }
}
function lookupName(email, callback) {
  var key = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)) {
    return callback("");
  }
  if (Object.prototype.hasOwnProperty.call(nameCache, key)) {
    return callback(nameCache[key]);
  }
  fetch("/api/lookup?email=" + encodeURIComponent(key))
    .then(function (res) {
      if (res.ok) {
        return res.json();
      } else {
        return {
          name: "",
        };
      }
    })
    .then(function (data) {
      nameCache[key] = String(data.name || "");
      callback(nameCache[key]);
    })
    .catch(function () {
      callback("");
    });
}
function prefillName(email) {
  lookupName(email, function (name) {
    if (state.step === "details" && state.form.email.trim().toLowerCase() === email.trim().toLowerCase()) {
      var input = document.getElementById("fname") as HTMLInputElement;
      if (!name) {
        if (state.nameAuto) {
          state.nameAuto = false;
          state.form.name = "";
          if (input) {
            input.value = "";
          }
          setNameHint("");
        }
        return;
      }
      if (!state.form.name.trim() || !!state.nameAuto) {
        state.form.name = name;
        state.nameAuto = true;
        setNameHint(WELCOME_BACK);
        if (input) {
          input.value = name;
          input.removeAttribute("aria-invalid");
          var errorEl = document.getElementById("fnamee");
          if (errorEl) {
            errorEl.remove();
          }
        }
        delete state.fieldErr.name;
      }
    }
  });
}
function renderDetails() {
  loadCompanies();
  var form = el("form", {
    class: "form",
    novalidate: true,
    "aria-labelledby": "formh",
    onsubmit: function (event) {
      event.preventDefault();
      submitBooking();
    },
  });
  form.appendChild(
    el(
      "h2",
      {
        id: "formh",
      },
      ["Enter Details"],
    ),
  );
  if (state.err) {
    form.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  var emailField = textField("femail", "email", "Email", "email", {
    req: true,
    ac: "email",
    max: 200,
  });
  var nameField = textField("fname", "name", "Name", "text", {
    req: true,
    ac: "name",
  });
  nameField.appendChild(
    el(
      "div",
      {
        class: "hint",
        id: "fnameh",
        role: "status",
      },
      [state.nameAuto ? WELCOME_BACK : ""],
    ),
  );
  var emailInput = emailField.querySelector("input");
  var nameInput = nameField.querySelector("input");
  emailInput.addEventListener("input", function () {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(function () {
      prefillName(emailInput.value);
    }, 350);
  });
  emailInput.addEventListener("change", function () {
    clearTimeout(lookupTimer);
    prefillName(emailInput.value);
  });
  nameInput.addEventListener("input", function () {
    if (state.nameAuto) {
      state.nameAuto = false;
      setNameHint("");
    }
  });
  form.appendChild(emailField);
  form.appendChild(nameField);
  if (state.form.email && !state.form.name.trim()) {
    setTimeout(function () {
      prefillName(state.form.email);
    }, 0);
  }
  form.appendChild(
    el(
      "div",
      {
        class: "row2",
      },
      [companyField(), roundField()],
    ),
  );
  form.appendChild(
    el(
      "button",
      {
        type: "submit",
        class: "submit",
        id: "submitb",
        disabled: state.busy,
      },
      [state.busy ? "Booking…" : "Confirm interview"],
    ),
  );
  return form;
}
function submitBooking() {
  var errors: Record<string, string> = {};
  var form = state.form;
  if (!form.name.trim()) {
    errors.name = "Enter your name.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = "Enter an email address like name@example.com.";
  }
  state.fieldErr = errors;
  state.err = "";
  if (Object.keys(errors).length) {
    render();
    var firstInvalid = document.getElementById(errors.email ? "femail" : "fname");
    if (firstInvalid) {
      firstInvalid.focus();
    }
    return;
  }
  state.busy = true;
  render();
  fetch("/api/book", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: form.name.trim(),
      email: form.email.trim(),
      company: form.company.trim(),
      round: form.round.trim(),
      duration: state.dur,
      startMs: state.slot,
    }),
  })
    .then(function (res) {
      return res.json().then(function (body) {
        return {
          ok: res.ok,
          j: body,
        };
      });
    })
    .then(function (result) {
      state.busy = false;
      if (result.ok) {
        state.booking = result.j.booking;
        state.booking.emailed = !!result.j.emailed;
        state.step = "done";
        render();
        window.scrollTo(0, 0);
        return;
      }
      if (result.j.field === "email") {
        state.fieldErr = {
          email: result.j.error,
        };
        render();
        var emailInput = document.getElementById("femail");
        if (emailInput) {
          emailInput.focus();
        }
        return;
      }
      if (result.j.retry) {
        slotCache = {};
        slotRequests = {};
        state.step = "pick";
        state.err = result.j.error || "That time is no longer available. Pick another time.";
        loadDays(true).then(function () {
          if (state.date) {
            showSlots();
          } else {
            render();
          }
        });
        return;
      }
      state.err = result.j.error || "Couldn't schedule the event. Try again.";
      render();
    })
    .catch(function () {
      state.busy = false;
      state.err = "Couldn't reach the server. Check your connection and try again.";
      render();
    });
}
function icsLink(booking) {
  function icsTime(iso) {
    return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  function icsText(text) {
    return String(text)
      .replace(/[\\;,]/g, function (ch) {
        return "\\" + ch;
      })
      .replace(/\n/g, "\\n");
  }
  var ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//booking-form//EN",
    "BEGIN:VEVENT",
    "UID:" + booking.id + "@booking-form",
    "DTSTAMP:" + icsTime(new Date().toISOString()),
    "DTSTART:" + icsTime(booking.start),
    "DTEND:" + icsTime(booking.end),
    "SUMMARY:" + icsText(eventName + " with " + hostName),
    "DESCRIPTION:" + icsText([booking.company, booking.round].filter(Boolean).join(", ")),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(`\r
`);
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
}
function renderDone() {
  var booking = state.booking;
  var startMs = Date.parse(booking.start);
  var section = el("section", {
    class: "done",
  });
  var inner = el("div", {
    class: "done-in",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "logo",
        "aria-hidden": "true",
      },
      [initial(hostName)],
    ),
  );
  inner.appendChild(
    el("h1", {
      html: ICONS.check + "<span>You are scheduled</span>",
    }),
  );
  inner.appendChild(
    el("p", null, [
      "Your " +
        booking.duration +
        " minute " +
        eventName.toLowerCase() +
        " is booked. " +
        (booking.emailed
          ? "A calendar invite is on its way to " + booking.email + "."
          : "Add it to your calendar so it doesn't slip."),
    ]),
  );
  var meta = el("ul", {
    class: "meta",
  });
  function item(icon: string, text: string, highlight?: boolean) {
    var li = el("li", {
      class: highlight ? "hl" : null,
      html: icon + "<span></span>",
    });
    li.lastChild.textContent = text;
    return li;
  }
  meta.appendChild(item(ICONS.user, hostName));
  meta.appendChild(item(ICONS.cal, formatRange(startMs, booking.duration), true));
  meta.appendChild(item(ICONS.globe, "India Standard Time"));
  inner.appendChild(
    el(
      "div",
      {
        class: "box",
      },
      [
        el(
          "h2",
          {
            class: "ev",
          },
          [eventName],
        ),
        meta,
      ],
    ),
  );
  var addToCalendar = el("a", {
    class: "pill",
    href: icsLink(booking),
    download: "interview.ics",
    html: ICONS.add + "<span>Add to calendar</span>",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "acts",
      },
      [
        addToCalendar,
        booking.manage
          ? el(
              "a",
              {
                class: "pill",
                href: booking.manage,
              },
              ["Reschedule or cancel"],
            )
          : null,
        el(
          "button",
          {
            type: "button",
            class: "pill",
            onclick: function () {
              state = {
                dur: state.dur,
                days: [],
                openSet: {},
                viewY: 0,
                viewM: 0,
                date: null,
                slots: null,
                slot: null,
                step: "pick",
                booking: null,
                err: "",
                fieldErr: {},
                form: {
                  name: booking.name,
                  email: booking.email,
                  company: "",
                  round: "",
                },
                busy: false,
              };
              loadDays();
            },
          },
          ["Book another time"],
        ),
      ],
    ),
  );
  section.appendChild(inner);
  card.appendChild(section);
}
function postChange(url, payload, onSuccess) {
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })
    .then(function (res) {
      return res.json().then(function (body) {
        return {
          ok: res.ok,
          j: body,
        };
      });
    })
    .then(function (result) {
      state.busy = false;
      if (result.ok) {
        onSuccess(result.j);
        render();
        window.scrollTo(0, 0);
        return;
      }
      if (result.j.retry) {
        slotCache = {};
        slotRequests = {};
        state.step = "pick";
        state.err = result.j.error;
        loadDays(true).then(function () {
          if (state.date) {
            showSlots();
          } else {
            render();
          }
        });
        return;
      }
      state.err = result.j.error || "Something went wrong. Try again.";
      render();
    })
    .catch(function () {
      state.busy = false;
      state.err = "Couldn't reach the server. Check your connection and try again.";
      render();
    });
}
function renderManage() {
  var section = el("section", {
    class: "form",
    "aria-labelledby": "mh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "mh",
      },
      ["Your Interview"],
    ),
  );
  if (state.err) {
    section.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  section.appendChild(
    el(
      "p",
      {
        class: "lead",
      },
      ["Booked for " + manage.name + " (" + manage.email + ")."],
    ),
  );
  if (manage.past) {
    section.appendChild(
      el(
        "p",
        {
          class: "lead",
        },
        [
          "This interview has already started, so it can't be changed here. Reply to your confirmation email if you need help.",
        ],
      ),
    );
    return section;
  } else {
    section.appendChild(
      el(
        "div",
        {
          class: "acts2",
        },
        [
          el(
            "button",
            {
              type: "button",
              class: "submit",
              id: "rsb",
              onclick: function () {
                state.step = "pick";
                state.err = "";
                state.date = null;
                state.slot = null;
                state.slots = null;
                render();
                loadDays();
              },
            },
            ["Reschedule"],
          ),
          el(
            "button",
            {
              type: "button",
              class: "ghost",
              id: "cxb",
              onclick: function () {
                state.step = "cancel";
                state.err = "";
                render();
                var reasonBox = document.getElementById("reason");
                if (reasonBox) {
                  reasonBox.focus();
                }
              },
            },
            ["Cancel interview"],
          ),
        ],
      ),
    );
    return section;
  }
}
function renderCancel() {
  var form = el("form", {
    class: "form",
    novalidate: true,
    "aria-labelledby": "ch",
    onsubmit: function (event) {
      event.preventDefault();
      if (!state.busy) {
        state.busy = true;
        state.err = "";
        render();
        postChange(
          "/api/manage/cancel",
          {
            id: manage.id,
            t: manage.t,
            reason: (state.reason || "").trim(),
          },
          function (result) {
            manage.cancelled = true;
            state.step = "msg";
            state.msg = {
              title: "Interview cancelled",
              body:
                "Your " +
                eventName.toLowerCase() +
                " on " +
                formatRange(Date.parse(manage.start), manage.duration) +
                " is cancelled." +
                (result.emailed ? " We've emailed you a confirmation." : ""),
              again: true,
            };
          },
        );
      }
    },
  });
  form.appendChild(
    el(
      "h2",
      {
        id: "ch",
      },
      ["Cancel Interview"],
    ),
  );
  if (state.err) {
    form.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  form.appendChild(
    el(
      "p",
      {
        class: "lead",
      },
      ["Your time will be released and " + hostName + " will be told."],
    ),
  );
  var reasonBox = el("textarea", {
    id: "reason",
    maxlength: 500,
    rows: 4,
  });
  reasonBox.value = state.reason || "";
  reasonBox.addEventListener("input", function () {
    state.reason = reasonBox.value;
  });
  form.appendChild(
    el(
      "div",
      {
        class: "f",
      },
      [
        el(
          "label",
          {
            for: "reason",
          },
          ["Reason for cancelling (optional)"],
        ),
        reasonBox,
      ],
    ),
  );
  form.appendChild(
    el(
      "button",
      {
        type: "submit",
        class: "submit danger",
        id: "cxgo",
        disabled: state.busy,
      },
      [state.busy ? "Cancelling…" : "Cancel interview"],
    ),
  );
  return form;
}
function renderConfirm() {
  var section = el("section", {
    class: "form",
    "aria-labelledby": "rh",
  });
  section.appendChild(
    el(
      "h2",
      {
        id: "rh",
      },
      ["Confirm New Time"],
    ),
  );
  if (state.err) {
    section.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  var meta = el("ul", {
    class: "meta chg",
  });
  function timeItem(cls, label, text) {
    var li = el("li", {
      class: cls,
      html: ICONS.cal + "<span></span>",
    });
    li.lastChild.textContent = text;
    li.setAttribute("aria-label", label + ": " + text);
    return li;
  }
  meta.appendChild(timeItem("old", "Current time", formatRange(Date.parse(manage.start), manage.duration)));
  meta.appendChild(timeItem("hl", "New time", formatRange(state.slot, state.dur)));
  section.appendChild(meta);
  section.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "submit",
        id: "rsgo",
        disabled: state.busy,
        onclick: function () {
          if (!state.busy) {
            state.busy = true;
            state.err = "";
            render();
            postChange(
              "/api/manage/reschedule",
              {
                id: manage.id,
                t: manage.t,
                startMs: state.slot,
                duration: state.dur,
              },
              function (result) {
                manage.start = result.booking.start;
                manage.end = result.booking.end;
                manage.duration = result.booking.duration;
                state.dur = manage.duration;
                state.days = [];
                state.date = null;
                state.slot = null;
                slotCache = {};
                slotRequests = {};
                state.step = "msg";
                state.msg = {
                  title: "Interview rescheduled",
                  check: true,
                  body:
                    "Your " +
                    eventName.toLowerCase() +
                    " is now " +
                    formatRange(Date.parse(manage.start), manage.duration) +
                    "." +
                    (result.emailed ? " We've emailed you an updated invite." : ""),
                  manage: true,
                };
              },
            );
          }
        },
      },
      [state.busy ? "Rescheduling…" : "Reschedule"],
    ),
  );
  return section;
}
function renderMessage() {
  var msg = state.msg;
  var section = el("section", {
    class: "done",
  });
  var inner = el("div", {
    class: "done-in",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "logo",
        "aria-hidden": "true",
      },
      [initial(hostName)],
    ),
  );
  var heading = el(
    "h1",
    msg.check
      ? {
          html: ICONS.check + "<span></span>",
        }
      : null,
    msg.check ? null : [msg.title],
  );
  if (msg.check) {
    heading.lastChild.textContent = msg.title;
  }
  inner.appendChild(heading);
  inner.appendChild(el("p", null, [msg.body]));
  var actions = [];
  if (msg.manage) {
    actions.push(
      el(
        "button",
        {
          type: "button",
          class: "pill",
          onclick: function () {
            state.step = "manage";
            state.msg = null;
            render();
          },
        },
        ["Back to your interview"],
      ),
    );
  }
  if (msg.again) {
    actions.push(
      el(
        "a",
        {
          class: "pill",
          href: "/",
        },
        ["Book a new time"],
      ),
    );
  }
  if (actions.length) {
    inner.appendChild(
      el(
        "div",
        {
          class: "acts",
        },
        actions,
      ),
    );
  }
  section.appendChild(inner);
  card.appendChild(section);
}
if (manage) {
  if (manage.error) {
    state.step = "msg";
    state.msg = {
      title: "This link doesn't work",
      body: manage.error,
    };
  } else if (manage.cancelled) {
    state.step = "msg";
    state.msg = {
      title: "This interview was cancelled",
      body: "It's no longer on the calendar.",
      again: true,
    };
  } else {
    state.step = "manage";
    state.dur = DURATIONS.indexOf(manage.duration) >= 0 ? manage.duration : 30;
    var action = new URLSearchParams(location.search).get("a");
    if (action && history.replaceState) {
      history.replaceState(null, "", location.pathname + "?t=" + encodeURIComponent(manage.t));
    }
    if (!manage.past && action === "cancel") {
      state.step = "cancel";
    }
    if (!manage.past && action === "reschedule") {
      state.step = "pick";
    }
  }
  render();
  if (state.step === "pick") {
    loadDays();
  }
} else {
  render();
  loadDays();
}
setInterval(function () {
  if (state.step === "pick") {
    render();
  }
}, 60000);
