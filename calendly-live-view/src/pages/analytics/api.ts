// The analytics page was written against an older dashboard's API (/api/state, /api/people, /api/analytics, /api/person,
// /api/results, /api/interviewers). api() answers those URLs in the browser from /admin/api/bookings, /state and /results.
// With merge=1, bookings under different emails whose names look alike count as one person.
var TIME_ZONE = "Asia/Kolkata";
// Everything the answers are built from, fetched together and kept for 15 seconds.
type Data = {
  bookings: any[]; // all bookings, as /admin/api/bookings sends them
  iv: { names: string[]; assign: Record<string, string> };
  results: Record<string, { results: Record<string, string>; updated?: string }>; // saved results, by person key
  joins: Record<string, string>; // company names combined by "Same company as…": lower-cased name → the name it joins
  persistent: boolean;
  resFailed: boolean;
};
var dataCache: Data | null = null;
var dataCachedAt = 0;
var dataLoading: Promise<Data> | null = null;
function loadData(force?: boolean): Promise<Data> {
  if (!force && dataCache && Date.now() - dataCachedAt < 15000) {
    return Promise.resolve(dataCache);
  }
  if (dataLoading) {
    return dataLoading;
  }
  dataLoading = Promise.all([window.fetch("/admin/api/bookings"), window.fetch("/admin/api/state"), window.fetch("/admin/api/results")])
    .then(function (responses) {
      if (
        responses.some(function (response) {
          return response.status === 401;
        })
      ) {
        (parent || window).location.reload();
        throw new Error("auth");
      }
      return Promise.all(
        responses.map(function (response) {
          if (response.ok) {
            return response.json();
          } else {
            return {};
          }
        }),
      );
    })
    .then(
      function (json: any[]) {
        dataCache = {
          bookings: json[0].bookings || [],
          iv: (json[1] && json[1].iv) || {
            names: [],
            assign: {},
          },
          results: (json[2] && json[2].people) || {},
          joins: (json[2] && json[2].joins) || {},
          persistent: !json[2] || json[2].persistent !== false,
          resFailed: !json[2] || !json[2].people,
        };
        dataCachedAt = Date.now();
        dataLoading = null;
        return dataCache;
      },
      function (error) {
        dataLoading = null;
        throw error;
      },
    );
  return dataLoading;
}
function normalizeName(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function nameDistance(first, second) {
  var rows = first.length;
  var cols = second.length;
  var table = [];
  var i;
  var j;
  for (i = 0; i <= rows; i++) {
    table[i] = [i];
    for (j = 1; j <= cols; j++) {
      table[i][j] = i ? 0 : j;
    }
  }
  for (i = 1; i <= rows; i++) {
    for (j = 1; j <= cols; j++) {
      table[i][j] = Math.min(table[i - 1][j] + 1, table[i][j - 1] + 1, table[i - 1][j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && first[i - 1] === second[j - 2] && first[i - 2] === second[j - 1]) {
        table[i][j] = Math.min(table[i][j], table[i - 2][j - 2] + 1);
      }
    }
  }
  return table[rows][cols];
}
function sameName(first, second) {
  var firstKey = normalizeName(first);
  var secondKey = normalizeName(second);
  if (!firstKey || !secondKey || firstKey === "guest" || secondKey === "guest") {
    return false;
  }
  if (firstKey === secondKey) {
    return true;
  }
  var firstWords = firstKey.split(" ");
  var secondWords = secondKey.split(" ");
  if (firstWords.length < 2 || secondWords.length < 2) {
    return false;
  }
  if (firstWords.slice().sort().join(" ") === secondWords.slice().sort().join(" ")) {
    return true;
  }
  return (
    firstKey.length >= 8 &&
    secondKey.length >= 8 &&
    Math.abs(firstKey.length - secondKey.length) <= 1 &&
    nameDistance(firstKey, secondKey) <= 1
  );
}
function nameKey(name) {
  return normalizeName(name).split(" ").filter(Boolean).sort().join(" ");
}
function lower(text) {
  return String(text || "")
    .trim()
    .toLowerCase();
}
function findBooking(data: Data, id) {
  return data.bookings.filter(function (booking) {
    return booking.id === id;
  })[0];
}
function personGroup(data: Data, booking, merge) {
  var emails = {};
  var names = [booking.name];
  emails[lower(booking.email)] = 1;
  if (merge) {
    var changed = true;
    while (changed) {
      changed = false;
      data.bookings.forEach(function (other) {
        var email = lower(other.email);
        if (
          email &&
          !emails[email] &&
          names.some(function (name) {
            return sameName(name, other.name);
          })
        ) {
          emails[email] = 1;
          names.push(other.name);
          changed = true;
        }
      });
    }
  }
  return {
    emails: Object.keys(emails),
    names: names,
  };
}
function dashboardState(data: Data) {
  return {
    ready: true,
    tz: TIME_ZONE,
    host: "",
    error: "",
    lastChecked: Date.now(),
    events: data.bookings
      .filter(function (booking) {
        return !booking.cancelled;
      })
      .map(function (booking) {
        return {
          id: booking.id,
          name: "Interview",
          start: booking.start,
          end: booking.end,
          invitee: booking.name,
          company: booking.company || "",
          round: booking.round || "",
        };
      })
      .sort(function (a, b) {
        return Date.parse(a.start) - Date.parse(b.start);
      }),
  };
}
function peopleList(data: Data, merge) {
  var act = data.bookings.filter(function (booking) {
    return !booking.cancelled && booking.email;
  });
  var byKey = {};
  var root = {};
  if (merge) {
    var names = [];
    act.forEach(function (booking) {
      if (names.indexOf(booking.name) < 0) {
        names.push(booking.name);
      }
    });
    var par = {};
    names.forEach(function (name) {
      par[name] = name;
    });
    function rootOf(name) {
      while (par[name] !== name) {
        name = par[name];
      }
      return name;
    }
    for (var i = 0; i < names.length; i++) {
      for (var j = i + 1; j < names.length; j++) {
        if (sameName(names[i], names[j])) {
          var rootA = rootOf(names[i]);
          var rootB = rootOf(names[j]);
          if (rootA !== rootB) {
            par[rootB] = rootA;
          }
        }
      }
    }
    names.forEach(function (name) {
      root[name] = rootOf(name);
    });
  }
  act.forEach(function (booking) {
    var normalized = normalizeName(booking.name);
    var key =
      merge && normalized && normalized !== "guest"
        ? "n:" + normalizeName(root[booking.name] || booking.name)
        : "e:" + lower(booking.email);
    var start = Date.parse(booking.start);
    var person = byKey[key];
    if (!person) {
      person = byKey[key] = {
        name: booking.name,
        count: 0,
        last: start,
        event: booking.id,
        emails: {},
        companies: {},
        activity: 0,
        next: 0,
        past: 0,
      };
    }
    person.count++;
    // for the Contacts list: the latest booking or reschedule, and the next and the last meeting
    var now = Date.now();
    person.activity = Math.max(
      person.activity,
      Date.parse(booking.createdAt) || 0,
      Date.parse(booking.rescheduledAt) || 0,
      start <= now ? start : 0,
    );
    if (Date.parse(booking.end) > now) {
      person.next = person.next ? Math.min(person.next, start) : start;
    } else {
      person.past = Math.max(person.past, start);
    }
    person.emails[lower(booking.email)] = 1;
    if (start >= person.last) {
      person.last = start;
      person.event = booking.id;
      person.name = booking.name;
    }
    var company = String(booking.company || "").trim();
    var companyKey = company.toLowerCase();
    if (companyKey) {
      var seen = person.companies[companyKey];
      if (!seen || start > seen.t) {
        person.companies[companyKey] = {
          c: company,
          t: start,
        };
      }
    }
  });
  return Object.keys(byKey)
    .map(function (key) {
      return byKey[key];
    })
    .sort(function (a, b) {
      return a.name.localeCompare(b.name);
    })
    .map(function (person) {
      return {
        name: person.name,
        count: person.count,
        event: person.event,
        company: "",
        companies_: Object.keys(person.companies)
          .map(function (key) {
            return person.companies[key];
          })
          .sort(function (a, b) {
            return b.t - a.t;
          })
          .slice(0, 3)
          .map(function (company) {
            return company.c;
          })
          .join(", "),
        last: new Date(person.last).toISOString(),
        emails: Object.keys(person.emails).length,
        activity: person.activity ? new Date(Math.min(person.activity, Date.now())).toISOString() : "",
        next: person.next ? new Date(person.next).toISOString() : "",
        past: person.past ? new Date(person.past).toISOString() : "",
      };
    });
}
function analyticsFor(data: Data, id, merge) {
  var booking = findBooking(data, id);
  if (!booking) {
    return [
      404,
      {
        error: "This booking wasn't found.",
      },
    ];
  }
  if (!booking.email) {
    return [
      404,
      {
        error: "This booking has no email, so analytics can't be built.",
      },
    ];
  }
  var group = personGroup(data, booking, merge);
  var set = {};
  var events = [];
  group.emails.forEach(function (email) {
    set[email] = 1;
  });
  data.bookings.forEach(function (other) {
    if (!set[lower(other.email)]) {
      return;
    }
    var base = {
      name: "Interview",
      created: other.createdAt || other.start,
      noShow: false,
      company: other.company || "",
      round: other.round || "",
    };
    events.push(
      Object.assign(
        {
          id: other.id,
          start: other.start,
          end: other.end,
          status: other.cancelled ? "canceled" : "active",
          rescheduled: false,
          cancelReason: other.cancelled ? other.cancelReason || "" : "",
          canceledBy: other.cancelled ? (other.cancelledBy === "candidate" ? "invitee" : other.cancelledBy === "host" ? "host" : "") : "",
        },
        base,
      ),
    );
    if (other.prevStart && other.rescheduledAt) {
      events.push(
        Object.assign(
          {
            id: other.id + "-moved",
            start: other.prevStart,
            end: new Date(Date.parse(other.prevStart) + (Date.parse(other.end) - Date.parse(other.start))).toISOString(),
            status: "canceled",
            rescheduled: true,
            cancelReason: "",
            canceledBy: other.rescheduledBy === "candidate" ? "invitee" : other.rescheduledBy === "host" ? "host" : "",
          },
          base,
        ),
      );
    }
  });
  events.sort(function (a, c) {
    return Date.parse(a.start) - Date.parse(c.start);
  });
  return [
    200,
    {
      name: booking.name,
      emails: group.emails.length,
      emailList: group.emails,
      events: events,
    },
  ];
}
function interviewsFor(data: Data, id, merge) {
  var booking = findBooking(data, id);
  if (!booking) {
    return [
      404,
      {
        error: "This booking wasn't found.",
      },
    ];
  }
  if (!booking.email) {
    return [
      404,
      {
        error: "This booking has no email, so other interviews can't be looked up.",
      },
    ];
  }
  var group = personGroup(data, booking, merge);
  var set = {};
  var now = Date.now();
  group.emails.forEach(function (email) {
    set[email] = 1;
  });
  var events = data.bookings
    .filter(function (other) {
      return !other.cancelled && set[lower(other.email)];
    })
    .map(function (other) {
      return {
        id: other.id,
        name: "Interview",
        start: other.start,
        end: other.end,
        status: Date.parse(other.end) < now ? "completed" : "upcoming",
        company: other.company || "",
        round: other.round || "",
        location: "",
      };
    })
    .sort(function (a, c) {
      return Date.parse(c.start) - Date.parse(a.start);
    });
  return [
    200,
    {
      name: booking.name,
      emails: group.emails.length,
      events: events,
    },
  ];
}
var RESULT_VALUES = {
  cleared: 1,
  notcleared: 1,
  hold: 1,
  offer: 1,
  withdrew: 1,
};
function mergedResults(people, keys, ownKey) {
  var merged = {};
  keys
    .filter(function (key) {
      return key !== ownKey;
    })
    .map(function (key) {
      return people[key];
    })
    .filter(Boolean)
    .sort(function (a, b) {
      return Date.parse(a.updated) - Date.parse(b.updated);
    })
    .forEach(function (entry) {
      Object.assign(merged, entry.results);
    });
  if (people[ownKey]) {
    Object.assign(merged, people[ownKey].results);
  }
  return merged;
}
function resultsFor(data: Data, id, merge, put) {
  var booking = findBooking(data, id);
  if (!booking) {
    return [
      404,
      {
        error: "This booking wasn't found.",
      },
    ];
  }
  var ownKey = nameKey(booking.name);
  var group = personGroup(data, booking, merge);
  var keys = [ownKey];
  group.names.forEach(function (name) {
    var key = nameKey(name);
    if (key && keys.indexOf(key) < 0) {
      keys.push(key);
    }
  });
  function view() {
    return [
      200,
      {
        results: mergedResults(data.results, keys, ownKey),
        joins: data.joins,
        persistent: data.persistent,
        locked: false,
        failed: data.resFailed,
      },
    ];
  }
  if (!put) {
    return view();
  }
  var set = {};
  Object.keys(put.set || {}).forEach(function (company) {
    if (RESULT_VALUES[put.set[company]] && company.length <= 120) {
      set[company] = put.set[company];
    }
  });
  var rem = (Array.isArray(put.remove) ? put.remove : []).filter(function (item) {
    return typeof item === "string" && item;
  });
  var entries = {};
  keys.slice(0, 20).forEach(function (key) {
    var merged = {};
    Object.assign(merged, (data.results[key] && data.results[key].results) || {});
    rem.forEach(function (company) {
      delete merged[company];
    });
    Object.assign(merged, set);
    entries[key] = Object.keys(merged).length
      ? {
          results: merged,
        }
      : null;
  });
  return window
    .fetch("/admin/api/results", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entries: entries,
      }),
    })
    .then(function (response) {
      if (response.status === 401) {
        (parent || window).location.reload();
        throw new Error("auth");
      }
      return response.json().then(function (json) {
        return {
          ok: response.ok,
          j: json,
        };
      });
    })
    .then(
      function (reply) {
        if (!reply.ok) {
          return [
            reply.j && reply.j.error ? 500 : 500,
            {
              error: (reply.j && reply.j.error) || "Couldn't save. Try again.",
            },
          ];
        }
        data.results = reply.j.people || {};
        data.persistent = reply.j.persistent !== false;
        data.resFailed = false;
        return view();
      },
      function () {
        return [
          500,
          {
            error: "Couldn't save. Check your connection and try again.",
          },
        ];
      },
    );
}
// PUT /api/joins {from, to}: says company "from" is the same as "to" for every candidate (to "" separates it again).
function saveJoin(data: Data, put) {
  return window
    .fetch("/admin/api/company-joins", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: String(put.from || ""), to: String(put.to || "") }),
    })
    .then(function (response) {
      if (response.status === 401) {
        (parent || window).location.reload();
        throw new Error("auth");
      }
      return response.json().then(function (json) {
        if (!response.ok) {
          return [500, { error: (json && json.error) || "Couldn't save. Try again." }];
        }
        data.joins = json.joins || {};
        return [200, { joins: data.joins }];
      });
    })
    .catch(function () {
      return [500, { error: "Couldn't save. Check your connection and try again." }];
    });
}
// Known company names and their other names ("TCS" and "Tata Consultancy Services"), as the booking form suggests them.
var knownLoading: Promise<string[][]> | null = null;
function knownCompanies(): Promise<string[][]> {
  if (!knownLoading) {
    knownLoading = window
      .fetch("/api/companies")
      .then(function (response) {
        return response.ok ? response.json() : { companies: [] };
      })
      .then(function (json) {
        return (json.companies || [])
          .filter(function (company) {
            return company && company.a && company.a.length;
          })
          .map(function (company) {
            return [company.n].concat(company.a);
          });
      })
      .catch(function () {
        knownLoading = null;
        return [];
      });
  }
  return knownLoading;
}
function api(url: string, opt?: RequestInit): Promise<Response> {
  var parsed = new URL(String(url), "http://local.invalid");
  var path = parsed.pathname;
  var combine = parsed.searchParams.get("merge") === "1";
  var eventId = parsed.searchParams.get("event") || "";
  var put = !!opt && opt.method === "PUT";
  return loadData(put || path === "/api/state").then(function (data) {
    var answer;
    if (path === "/api/state") {
      answer = [200, dashboardState(data)];
    } else if (path === "/api/interviewers") {
      answer = [
        200,
        {
          names: data.iv.names || [],
          assign: data.iv.assign || {},
          persistent: true,
          locked: false,
          canUnlock: false,
        },
      ];
    } else if (path === "/api/people") {
      answer = [200, peopleList(data, combine)];
    } else if (path === "/api/analytics") {
      answer = analyticsFor(data, eventId, combine);
    } else if (path === "/api/person") {
      answer = interviewsFor(data, eventId, combine);
    } else if (path === "/api/joins" && put) {
      answer = saveJoin(data, JSON.parse((opt.body as string) || "{}"));
    } else if (path === "/api/results") {
      answer = resultsFor(data, eventId, combine, put ? JSON.parse((opt.body as string) || "{}") : null);
    } else {
      answer = [
        404,
        {
          error: "Not found.",
        },
      ];
    }
    return Promise.resolve(answer).then(function (answer) {
      return new Response(JSON.stringify(answer[1]), {
        status: answer[0],
        headers: {
          "Content-Type": "application/json",
        },
      });
    });
  });
}

export { api, knownCompanies };
