(function () {
  var TZ = "Asia/Kolkata",
    LA_CACHE = null,
    LA_AT = 0,
    LA_P = null;
  function laLoad(force) {
    if (!force && LA_CACHE && Date.now() - LA_AT < 15000) return Promise.resolve(LA_CACHE);
    if (LA_P) return LA_P;
    LA_P = Promise.all([
      window.fetch("/admin/api/bookings"),
      window.fetch("/admin/api/state"),
      window.fetch("/admin/api/results"),
    ])
      .then(function (rs) {
        if (
          rs.some(function (r) {
            return r.status === 401;
          })
        ) {
          (parent || window).location.reload();
          throw new Error("auth");
        }
        return Promise.all(
          rs.map(function (r) {
            return r.ok ? r.json() : {};
          }),
        );
      })
      .then(
        function (j) {
          LA_CACHE = {
            b: j[0].bookings || [],
            iv: (j[1] && j[1].iv) || { names: [], assign: {} },
            res: (j[2] && j[2].people) || {},
            persistent: !(j[2] && j[2].persistent === false),
            resFailed: !(j[2] && j[2].people),
          };
          LA_AT = Date.now();
          LA_P = null;
          return LA_CACHE;
        },
        function (e) {
          LA_P = null;
          throw e;
        },
      );
    return LA_P;
  }
  function laR(e) {
    return String(e || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }
  function laEd(e, o) {
    var r = e.length,
      t = o.length,
      i = [],
      n,
      a;
    for (n = 0; n <= r; n++) {
      i[n] = [n];
      for (a = 1; a <= t; a++) i[n][a] = n ? 0 : a;
    }
    for (n = 1; n <= r; n++)
      for (a = 1; a <= t; a++) {
        i[n][a] = Math.min(i[n - 1][a] + 1, i[n][a - 1] + 1, i[n - 1][a - 1] + (e[n - 1] === o[a - 1] ? 0 : 1));
        if (n > 1 && a > 1 && e[n - 1] === o[a - 2] && e[n - 2] === o[a - 1])
          i[n][a] = Math.min(i[n][a], i[n - 2][a - 2] + 1);
      }
    return i[r][t];
  }
  function laSim(e, o) {
    var r = laR(e),
      t = laR(o);
    if (!r || !t || r === "guest" || t === "guest") return false;
    if (r === t) return true;
    var i = r.split(" "),
      n = t.split(" ");
    if (i.length < 2 || n.length < 2) return false;
    if (i.slice().sort().join(" ") === n.slice().sort().join(" ")) return true;
    return r.length >= 8 && t.length >= 8 && Math.abs(r.length - t.length) <= 1 && laEd(r, t) <= 1;
  }
  function laKey(e) {
    return laR(e).split(" ").filter(Boolean).sort().join(" ");
  }
  function laLow(e) {
    return String(e || "")
      .trim()
      .toLowerCase();
  }
  function laFind(D, id) {
    return D.b.filter(function (x) {
      return x.id === id;
    })[0];
  }
  function laGroup(D, b, merge) {
    var em = {},
      names = [b.name];
    em[laLow(b.email)] = 1;
    if (merge) {
      var ch = true;
      while (ch) {
        ch = false;
        D.b.forEach(function (x) {
          var k = laLow(x.email);
          if (
            k &&
            !em[k] &&
            names.some(function (s) {
              return laSim(s, x.name);
            })
          ) {
            em[k] = 1;
            names.push(x.name);
            ch = true;
          }
        });
      }
    }
    return { emails: Object.keys(em), names: names };
  }
  function laState(D) {
    return {
      ready: true,
      tz: TZ,
      host: "",
      error: "",
      lastChecked: Date.now(),
      events: D.b
        .filter(function (x) {
          return !x.cancelled;
        })
        .map(function (x) {
          return {
            id: x.id,
            name: "Interview",
            start: x.start,
            end: x.end,
            invitee: x.name,
            company: x.company || "",
            round: x.round || "",
          };
        })
        .sort(function (a, b) {
          return Date.parse(a.start) - Date.parse(b.start);
        }),
    };
  }
  function laPeople(D, merge) {
    var act = D.b.filter(function (x) {
        return !x.cancelled && x.email;
      }),
      o = {},
      root = {};
    if (merge) {
      var names = [];
      act.forEach(function (x) {
        if (names.indexOf(x.name) < 0) names.push(x.name);
      });
      var par = {};
      names.forEach(function (n) {
        par[n] = n;
      });
      var f = function (n) {
        while (par[n] !== n) n = par[n];
        return n;
      };
      for (var i = 0; i < names.length; i++)
        for (var j = i + 1; j < names.length; j++)
          if (laSim(names[i], names[j])) {
            var a = f(names[i]),
              c = f(names[j]);
            if (a !== c) par[c] = a;
          }
      names.forEach(function (n) {
        root[n] = f(n);
      });
    }
    act.forEach(function (x) {
      var n = laR(x.name),
        k = merge && n && n !== "guest" ? "n:" + laR(root[x.name] || x.name) : "e:" + laLow(x.email),
        s = Date.parse(x.start),
        d = o[k];
      if (!d) d = o[k] = { name: x.name, count: 0, last: s, event: x.id, emails: {}, companies: {} };
      d.count++;
      d.emails[laLow(x.email)] = 1;
      if (s >= d.last) {
        d.last = s;
        d.event = x.id;
        d.name = x.name;
      }
      var p = String(x.company || "").trim(),
        pl = p.toLowerCase();
      if (pl) {
        var u = d.companies[pl];
        if (!u || s > u.t) d.companies[pl] = { c: p, t: s };
      }
    });
    return Object.keys(o)
      .map(function (k) {
        return o[k];
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name);
      })
      .map(function (t) {
        return {
          name: t.name,
          count: t.count,
          event: t.event,
          company: "",
          companies_: Object.keys(t.companies)
            .map(function (k) {
              return t.companies[k];
            })
            .sort(function (a, b) {
              return b.t - a.t;
            })
            .slice(0, 3)
            .map(function (x) {
              return x.c;
            })
            .join(", "),
          last: new Date(t.last).toISOString(),
          emails: Object.keys(t.emails).length,
        };
      });
  }
  function laAnalytics(D, id, merge) {
    var b = laFind(D, id);
    if (!b) return [404, { error: "This booking wasn't found." }];
    if (!b.email) return [404, { error: "This booking has no email, so analytics can't be built." }];
    var g = laGroup(D, b, merge),
      set = {},
      ev = [];
    g.emails.forEach(function (e) {
      set[e] = 1;
    });
    D.b.forEach(function (x) {
      if (!set[laLow(x.email)]) return;
      var base = {
        name: "Interview",
        created: x.createdAt || x.start,
        noShow: false,
        company: x.company || "",
        round: x.round || "",
      };
      ev.push(
        Object.assign(
          {
            id: x.id,
            start: x.start,
            end: x.end,
            status: x.cancelled ? "canceled" : "active",
            rescheduled: false,
            cancelReason: x.cancelled ? x.cancelReason || "" : "",
            canceledBy: x.cancelled
              ? x.cancelledBy === "candidate"
                ? "invitee"
                : x.cancelledBy === "host"
                  ? "host"
                  : ""
              : "",
          },
          base,
        ),
      );
      if (x.prevStart && x.rescheduledAt)
        ev.push(
          Object.assign(
            {
              id: x.id + "-moved",
              start: x.prevStart,
              end: new Date(Date.parse(x.prevStart) + (Date.parse(x.end) - Date.parse(x.start))).toISOString(),
              status: "canceled",
              rescheduled: true,
              cancelReason: "",
              canceledBy: x.rescheduledBy === "candidate" ? "invitee" : x.rescheduledBy === "host" ? "host" : "",
            },
            base,
          ),
        );
    });
    ev.sort(function (a, c) {
      return Date.parse(a.start) - Date.parse(c.start);
    });
    return [200, { name: b.name, emails: g.emails.length, events: ev }];
  }
  function laPerson(D, id, merge) {
    var b = laFind(D, id);
    if (!b) return [404, { error: "This booking wasn't found." }];
    if (!b.email) return [404, { error: "This booking has no email, so other interviews can't be looked up." }];
    var g = laGroup(D, b, merge),
      set = {},
      now = Date.now();
    g.emails.forEach(function (e) {
      set[e] = 1;
    });
    var ev = D.b
      .filter(function (x) {
        return !x.cancelled && set[laLow(x.email)];
      })
      .map(function (x) {
        return {
          id: x.id,
          name: "Interview",
          start: x.start,
          end: x.end,
          status: Date.parse(x.end) < now ? "completed" : "upcoming",
          company: x.company || "",
          round: x.round || "",
          location: "",
        };
      })
      .sort(function (a, c) {
        return Date.parse(c.start) - Date.parse(a.start);
      });
    return [200, { name: b.name, emails: g.emails.length, events: ev }];
  }
  var LA_OK = { cleared: 1, notcleared: 1, hold: 1, offer: 1, withdrew: 1 };
  function laGe(P, d, s) {
    var r = {};
    d.filter(function (i) {
      return i !== s;
    })
      .map(function (i) {
        return P[i];
      })
      .filter(Boolean)
      .sort(function (a, b) {
        return Date.parse(a.updated) - Date.parse(b.updated);
      })
      .forEach(function (i) {
        Object.assign(r, i.results);
      });
    if (P[s]) Object.assign(r, P[s].results);
    return r;
  }
  function laResults(D, id, merge, put) {
    var b = laFind(D, id);
    if (!b) return [404, { error: "This booking wasn't found." }];
    var s = laKey(b.name),
      g = laGroup(D, b, merge),
      d = [s];
    g.names.forEach(function (n) {
      var k = laKey(n);
      if (k && d.indexOf(k) < 0) d.push(k);
    });
    var view = function () {
      return [200, { results: laGe(D.res, d, s), persistent: D.persistent, locked: false, failed: D.resFailed }];
    };
    if (!put) return view();
    var set = {};
    Object.keys(put.set || {}).forEach(function (c) {
      if (LA_OK[put.set[c]] && c.length <= 120) set[c] = put.set[c];
    });
    var rem = (Array.isArray(put.remove) ? put.remove : []).filter(function (x) {
        return typeof x === "string" && x;
      }),
      entries = {};
    d.slice(0, 20).forEach(function (i) {
      var n = {};
      Object.assign(n, (D.res[i] && D.res[i].results) || {});
      rem.forEach(function (a) {
        delete n[a];
      });
      Object.assign(n, set);
      entries[i] = Object.keys(n).length ? { results: n } : null;
    });
    return window
      .fetch("/admin/api/results", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: entries }),
      })
      .then(function (r) {
        if (r.status === 401) {
          (parent || window).location.reload();
          throw new Error("auth");
        }
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(
        function (x) {
          if (!x.ok)
            return [x.j && x.j.error ? 500 : 500, { error: (x.j && x.j.error) || "Couldn't save. Try again." }];
          D.res = x.j.people || {};
          D.persistent = x.j.persistent !== false;
          D.resFailed = false;
          return view();
        },
        function () {
          return [500, { error: "Couldn't save. Check your connection and try again." }];
        },
      );
  }
  function laFetch(url, opt) {
    var u = new URL(String(url), "http://local.invalid"),
      p = u.pathname,
      m = u.searchParams.get("merge") === "1",
      ev = u.searchParams.get("event") || "",
      put = !!(opt && opt.method === "PUT");
    return laLoad(put || p === "/api/state").then(function (D) {
      var r;
      if (p === "/api/state") r = [200, laState(D)];
      else if (p === "/api/interviewers")
        r = [
          200,
          { names: D.iv.names || [], assign: D.iv.assign || {}, persistent: true, locked: false, canUnlock: false },
        ];
      else if (p === "/api/people") r = [200, laPeople(D, m)];
      else if (p === "/api/analytics") r = laAnalytics(D, ev, m);
      else if (p === "/api/person") r = laPerson(D, ev, m);
      else if (p === "/api/results") r = laResults(D, ev, m, put ? JSON.parse(opt.body || "{}") : null);
      else r = [404, { error: "Not found." }];
      return Promise.resolve(r).then(function (r) {
        return new Response(JSON.stringify(r[1]), { status: r[0], headers: { "Content-Type": "application/json" } });
      });
    });
  }

  Node.prototype.a = Node.prototype.appendChild;
  EventTarget.prototype.o = EventTarget.prototype.addEventListener;
  var _dp = Date.parse;
  function _dv(c, t) {
    return el("div", c, t);
  }
  function _sp(c, t) {
    return el("span", c, t);
  }
  var state = { ready: !1, events: [], tz: "Asia/Kolkata", host: "", error: "", lastChecked: 0 },
    live = !1,
    es = null,
    lastSeen = 0,
    reqId = 0,
    plinkOn = !0,
    merge = !0,
    takeEv = null,
    takeSaved = "",
    takeGo = !1,
    takeTimer = 0;
  function mq() {
    return merge ? "&merge=1" : "";
  }
  var ivMap = {},
    ivNames = [],
    ivInfo = { persistent: !0, locked: !1 },
    ivSig = "";
  function ivSigOf(e) {
    return JSON.stringify(e.assign || {}) + "|" + JSON.stringify(e.names || []) + "|" + (!1 !== e.persistent);
  }
  function loadIv() {
    laFetch("/api/interviewers")
      .then((e) => e.json())
      .then((e) => {
        var t = ivSigOf(e);
        ((ivInfo = e),
          (ivMap = e.assign || {}),
          (ivNames = e.names || []),
          t !== ivSig && ((ivSig = t), "function" == typeof onIv && onIv()));
      })
      .catch(() => {});
  }
  function ivCls(e) {
    var t = ivNames.indexOf(e);
    if (t < 0) {
      t = 0;
      for (var n = 0; n < e.length; n++) t += e.charCodeAt(n);
    }
    return "ivc" + (t % 6);
  }
  function avOf(e) {
    return String(e || "?")
      .trim()
      .charAt(0)
      .toUpperCase();
  }
  function getKey() {
    try {
      return localStorage.getItem("lv_edit") || "";
    } catch (e) {
      return "";
    }
  }
  function setKey(e) {
    try {
      localStorage.setItem("lv_edit", e);
    } catch (e) {}
  }
  function $(e) {
    return document.getElementById(e);
  }
  function el(e, t, n) {
    var a = document.createElement(e);
    return (t && (a.className = t), null != n && (a.textContent = n), a);
  }
  function fmt(e, t) {
    return new Intl.DateTimeFormat(
      "en-US",
      Object.assign(
        {
          timeZone: state.tz,
        },
        e,
      ),
    ).format(t);
  }
  function ymd(e) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: state.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(e);
  }
  function mod(e) {
    var t = 0,
      n = 0;
    return (
      new Intl.DateTimeFormat("en-GB", { timeZone: state.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(e)
        .forEach((e) => {
          ("hour" === e.type && (t = +e.value), "minute" === e.type && (n = +e.value));
        }),
      60 * t + n
    );
  }
  function t12(e) {
    return fmt({ hour: "numeric", minute: "2-digit", hour12: !0 }, e);
  }
  function addDays(e, t) {
    var n = new Date(e + "T12:00:00Z");
    return (n.setUTCDate(n.getUTCDate() + t), n.toISOString().slice(0, 10));
  }
  function niceName(e) {
    return e === e.toLowerCase() && e !== e.toUpperCase()
      ? e.replace(/(^|[\s\-'])(\p{L})/gu, (e, t, n) => t + n.toUpperCase())
      : e;
  }
  function whenText(e, t) {
    return (
      fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" }, e) +
      " \u00B7 " +
      t12(e) +
      " \u2013 " +
      t12(t)
    );
  }
  function sendPut(e, t, n, a, i, o, r) {
    (n && (n.textContent = "Saving\u2026"),
      laFetch(e, {
        method: "PUT",
        headers: Object.assign(
          {
            "Content-Type": "application/json",
            "x-edit-key": getKey(),
          },
          r || {},
        ),
        body: JSON.stringify(t),
      })
        .then((e) =>
          e
            .json()
            .then((t) => ({ s: e.status, j: t }))
            .catch(() => ({ s: e.status, j: {} })),
        )
        .then((s) => {
          if (401 === s.s && s.j && "locked" === s.j.error && !a) {
            var d = window.prompt("This dashboard is locked for changes. Enter the edit password:");
            return d
              ? (setKey(d), sendPut(e, t, n, !0, i, o, r))
              : (n && (n.textContent = "Not saved: the edit password is needed."), void (o && o()));
          }
          if (200 !== s.s)
            return (
              n &&
                (n.textContent =
                  409 === s.s
                    ? s.j && "not started" === s.j.error
                      ? "This interview hasn't started yet."
                      : "Already recorded. It can't be changed here."
                    : 401 === s.s
                      ? s.j && "wrong unlock password" === s.j.error
                        ? "Wrong unlock password."
                        : "Not saved: wrong edit password."
                      : "Couldn't save. Try again."),
              void (o && o())
            );
          i(s.j);
        })
        .catch(() => {
          (n && (n.textContent = "Couldn't save. Check your connection and try again."), o && o());
        }));
  }
  function kvRow(e, t, n, a) {
    var i = _dv("kv" + (a ? " " + a : ""));
    (i.a(_sp(null, t)), i.a(el("b", null, n)), e.a(i));
  }
  function card(e, t) {
    var n = _dv("card");
    return (n.a(_dv("k", e)), n.a(_dv("v", t)), n);
  }
  function ivDesc(e) {
    return [e.company, e.round].filter(Boolean).join(" \u00B7 ") || "Interview";
  }
  function ivOverlap(e, t) {
    if (!t) return "";
    for (var n = _dp(e.start), a = _dp(e.end), i = state.events || [], o = 0; o < i.length; o++) {
      var r = i[o];
      if (r.id !== e.id && ivMap[r.id] === t && _dp(r.start) < a && _dp(r.end) > n)
        return niceName(r.invitee) + " at " + t12(new Date(r.start));
    }
    return "";
  }
  function openTake(e) {
    (reqId++, (takeEv = e), (takeSaved = ""), ($("ptitle").textContent = niceName(e.invitee)));
    var t = $("plink");
    ((t.href = "/analytics?event=" + encodeURIComponent(e.id)), (t.hidden = !1), showPanel(!0), paintTake());
  }
  function ivApply(e) {
    ((ivInfo = e), (ivMap = e.assign || {}), (ivNames = e.names || []), (ivSig = ivSigOf(e)));
  }
  function takeTick() {
    takeEv && !takeGo && !$("panel").hidden && _dp(takeEv.start) <= Date.now() && paintTake();
  }
  function paintTake() {
    var e = takeEv,
      t = $("plist");
    t.textContent = "";
    var n = ivMap[e.id] || "",
      a = new Date(e.start),
      i = _dp(e.end) <= Date.now(),
      o = _dp(e.start) <= Date.now();
    if (
      ((takeGo = o),
      ($("psub").textContent =
        ivDesc(e) +
        " \u00B7 " +
        fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" }, a) +
        " \u00B7 " +
        t12(a) +
        " \u00B7 " +
        (i ? "Completed" : o ? "In progress" : "Upcoming")),
      !o && !n)
    ) {
      var r = _dv("rcard");
      return (
        r.a(_dv("tkq", "Who took this interview?")),
        r.a(_dv("sub", "You can choose once the interview starts, at " + t12(a) + ".")),
        t.a(r),
        clearTimeout(takeTimer),
        void (takeTimer = setTimeout(takeTick, Math.min(_dp(e.start) - Date.now() + 400, 2147e6)))
      );
    }
    var s = _dv("rcard" + (n ? " locked" : i ? " need" : "")),
      d = _dv("rmsg");
    if (n) {
      if (
        (s.a(_dv("tkq", "Interview taken by")),
        s.a(_dv("tkby " + ivCls(n), n)),
        (d.textContent = takeSaved === e.id ? "Saved and locked." : "Locked. This can't be changed."),
        s.a(d),
        ivInfo.canUnlock)
      ) {
        var l = el("button", "linkbtn", "Unlock to change");
        (l.o("click", () => {
          var t = window.prompt("Enter the unlock password to change this interviewer:");
          if (t) {
            var n = {};
            ((n[e.id] = ""),
              sendPut(
                "/api/interviewers",
                { set: n, unlock: !0 },
                d,
                !1,
                (t) => {
                  (ivApply(t), (takeSaved = ""), takeEv === e && paintTake(), "function" == typeof onIv && onIv());
                },
                null,
                { "x-unlock-key": t },
              ));
          }
        }),
          s.a(l));
      }
    } else {
      s.a(_dv("tkq", "Who took this interview?"));
      var v = _dv("pick");
      (ivNames.forEach((t) => {
        var n = el("button", ivCls(t), t);
        (n.o("click", () => {
          var n = {};
          ((n[e.id] = t),
            sendPut(
              "/api/interviewers",
              { set: n },
              d,
              !1,
              (t) => {
                (ivApply(t), (takeSaved = e.id), takeEv === e && paintTake(), "function" == typeof onIv && onIv());
              },
              () => {
                loadIv();
              },
            ));
        }),
          v.a(n));
      }),
        s.a(v),
        s.a(d));
    }
    var c = ivOverlap(e, n);
    (c && s.a(_dv("iwarn", "Overlaps with " + c)),
      ivInfo.persistent ||
        s.a(_dv("iwarn", "Server storage is not attached, so this is only kept until the next restart.")),
      t.a(s));
  }
  function showPanel(e) {
    (($("panel").hidden = !e), ($("pback").hidden = !e), e || ($("plink").hidden = !0), e && $("pclose").focus());
  }
  function closePanel() {
    (reqId++, (takeEv = null), showPanel(!1));
  }
  function renderPerson(e) {
    var t = $("plist");
    t.textContent = "";
    var n = 0,
      a = 0,
      i = 0;
    (e.events.forEach((e) => {
      var o = new Date(e.start),
        r = new Date(e.end),
        s = _dv("pitem"),
        d = _dv("when", whenText(o, r)),
        l = "upcoming" === e.status ? "Upcoming" : "noshow" === e.status ? "No-show" : "Completed";
      (d.a(_sp("badge" + ("upcoming" === e.status ? " up" : "noshow" === e.status ? " ns" : ""), l)), s.a(d));
      var v = [e.company, e.round].filter(Boolean).join(" \u00B7 ");
      v && s.a(_dv("what", v));
      var c = [e.name, e.location, ivMap[e.id] ? "Interviewer: " + ivMap[e.id] : ""].filter(Boolean).join(" \u00B7 ");
      (c && s.a(_dv("meta", c)), t.a(s), "upcoming" === e.status ? a++ : "noshow" === e.status ? i++ : n++);
    }),
      ($("ptitle").textContent = niceName(e.name)));
    var o = e.events.length;
    (($("psub").textContent =
      o +
      (1 === o ? " interview" : " interviews") +
      " \u00B7 " +
      n +
      " completed \u00B7 " +
      a +
      " upcoming" +
      (i ? " \u00B7 " + i + " no-show" : "") +
      (e.emails > 1 ? " \u00B7 " + e.emails + " email addresses combined" : "")),
      o || t.a(_dv("sub", "No interviews found for this person.")));
  }
  function openPerson(e) {
    var t = ++reqId;
    ((takeEv = null),
      ($("ptitle").textContent = niceName(e.invitee)),
      ($("psub").textContent = "Loading interviews\u2026"),
      ($("plist").textContent = ""),
      showPanel(!0));
    var n = $("plink");
    (plinkOn ? ((n.href = "/analytics?event=" + encodeURIComponent(e.id)), (n.hidden = !1)) : (n.hidden = !0),
      laFetch("/api/person?event=" + encodeURIComponent(e.id) + mq())
        .then((e) => e.json().then((t) => ({ ok: e.ok, j: t })))
        .then((e) => {
          t === reqId &&
            (e.ok ? renderPerson(e.j) : ($("psub").textContent = (e.j && e.j.error) || "Couldn't load interviews."));
        })
        .catch(() => {
          t === reqId && ($("psub").textContent = "Couldn't load interviews. Check your connection and try again.");
        }));
  }
  function paintStatus() {
    var e = $("status"),
      t = $("statusText");
    if (((e.className = "status" + (live && !state.error ? " live" : "")), live))
      if (lastSeen) {
        var n = Math.max(0, Math.round((Date.now() - lastSeen) / 1e3));
        t.textContent = "Live \u00B7 checked " + (n < 60 ? n + "s" : Math.round(n / 60) + "m") + " ago";
      } else t.textContent = "Live";
    else t.textContent = "Reconnecting\u2026";
  }
  function paintBanner() {
    var e = state.error || (state.ready ? "" : "Loading bookings\u2026"),
      t = $("banner");
    ((t.textContent = e), (t.hidden = !e));
  }
  function connect() {
    (es && es.close(),
      ((es = new EventSource("/stream")).onopen = () => {
        ((live = !0), paintStatus());
      }),
      es.addEventListener("state", (e) => {
        try {
          state = JSON.parse(e.data);
        } catch (e) {
          return;
        }
        ((live = !0), (lastSeen = Date.now()), render());
      }),
      es.addEventListener("tick", () => {
        ((live = !0), (lastSeen = Date.now()), paintStatus());
      }),
      (es.onerror = () => {
        ((live = !1), paintStatus(), 2 === es.readyState && setTimeout(connect, 3e3));
      }));
  }
  ((() => {
    var e = 0,
      t = 0,
      n = $("panel"),
      a = n.querySelector(".phead");
    (a.o(
      "touchstart",
      (n) => {
        ((e = n.touches[0].clientY), (t = 0));
      },
      { passive: !0 },
    ),
      a.o(
        "touchmove",
        (a) => {
          (t = a.touches[0].clientY - e) > 0 && (n.style.transform = "translateY(" + t + "px)");
        },
        { passive: !0 },
      ),
      a.o("touchend", () => {
        ((n.style.transform = ""), t > 90 && closePanel(), (t = 0));
      }));
  })(),
    ($("pclose").onclick = closePanel),
    ($("pback").onclick = closePanel),
    document.o("keydown", (e) => {
      "Escape" !== e.key || $("panel").hidden || closePanel();
    }),
    document.o("visibilitychange", () => {
      "visible" === document.visibilityState &&
        (loadIv(),
        takeTick(),
        laFetch("/api/state")
          .then((e) => e.json())
          .then((e) => {
            ((state = e), (lastSeen = Date.now()), render());
          })
          .catch(() => {}),
        (es && 2 !== es.readyState) || connect());
    }),
    setInterval(paintStatus, 5e3),
    setInterval(() => {
      (loadIv(), takeTick(), state.ready && render());
    }, 6e4),
    loadIv());

  var people = [],
    chosen = null,
    pickerOpen = !0,
    peopleLoaded = !1,
    peopleKey = "";
  function words(e) {
    return e.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function chosenName() {
    return chosen && chosen.name ? niceName(chosen.name) : "";
  }
  function loadPeople() {
    laFetch("/api/people" + (merge ? "?merge=1" : ""))
      .then((e) => e.json())
      .then((e) => {
        ((people = Array.isArray(e) ? e : []), (peopleLoaded = !0), renderPeople(), renderRecent());
      })
      .catch(() => {
        ((peopleLoaded = !0), renderPeople());
      });
  }
  function syncPeople() {
    var e = state.events.length + ":" + state.events.map((e) => e.invitee).join("|");
    state.ready && e !== peopleKey && ((peopleKey = e), loadPeople());
  }
  function skelRows(e, n) {
    var o = el("div"),
      p = _dv("rempty");
    (p.a(_sp("spin")), p.a(document.createTextNode(n)), o.a(p));
    for (var r = 0; r < e; r++) {
      var t = _dv("rrow skel-rrow");
      (t.a(_dv("skel sk-line sk-w" + ((r % 3) + 1))), o.a(t));
    }
    return o;
  }
  function renderPeople() {
    var e = $("plistbox");
    e.textContent = "";
    var n = $("pq").value.trim(),
      o = words(n === chosenName() ? "" : n);
    if (pickerOpen && o.length) {
      if (!peopleLoaded) return ((e.hidden = !1), void e.a(skelRows(3, "Loading people\u2026")));
      var p = people.filter((e) => {
        for (
          var n = (e.name + " " + niceName(e.name) + " " + (e.company || "")).toLowerCase(), p = 0;
          p < o.length;
          p++
        )
          if (n.indexOf(o[p]) < 0) return !1;
        return !0;
      });
      ((e.hidden = !1),
        p.length
          ? p.slice(0, 60).forEach((n) => {
              var o = _dv("rrow");
              ((o.tabIndex = 0), o.setAttribute("role", "button"));
              var p = _dv("rmain");
              (p.a(el("b", null, niceName(n.name))), n.company && p.a(_dv("sub", n.company)), o.a(p));
              var r = n.last ? fmt({ day: "numeric", month: "short", year: "numeric" }, new Date(n.last)) : "";
              function t() {
                choose(n);
              }
              (o.a(
                _sp(
                  "sub",
                  n.count +
                    (1 === n.count ? " booking" : " bookings") +
                    (r ? " \u00B7 last " + r : "") +
                    (n.emails > 1 ? " \u00B7 " + n.emails + " emails" : ""),
                ),
              ),
                o.o("mousedown", (e) => {
                  e.preventDefault();
                }),
                o.o("click", t),
                o.o("keydown", (e) => {
                  ("Enter" !== e.key && " " !== e.key) || (e.preventDefault(), t());
                }),
                e.a(o));
            })
          : e.a(
              _dv(
                "rempty",
                people.length ? "No one matches." : "No people yet. They appear once their bookings have loaded.",
              ),
            ));
    } else e.hidden = !0;
  } // Before anyone is picked, the eight people with the most recent bookings are one click away.
  function renderRecent() {
    var b = $("recent");
    b.textContent = "";
    var list = people
      .slice()
      .sort((x, y) => (Date.parse(y.last) || 0) - (Date.parse(x.last) || 0))
      .slice(0, 8);
    $("recentH").hidden = b.hidden = !list.length;
    list.forEach((n) => {
      var o = _dv("rrow");
      ((o.tabIndex = 0), o.setAttribute("role", "button"));
      var p = _dv("rmain");
      (p.a(el("b", null, niceName(n.name))), n.company && p.a(_dv("sub", n.company)), o.a(p));
      var r = n.last ? fmt({ day: "numeric", month: "short", year: "numeric" }, new Date(n.last)) : "";
      (o.a(_sp("sub", n.count + (1 === n.count ? " booking" : " bookings") + (r ? " \u00B7 last " + r : ""))),
        o.o("click", () => choose(n)),
        o.o("keydown", (e) => {
          ("Enter" !== e.key && " " !== e.key) || (e.preventDefault(), choose(n));
        }),
        b.a(o));
    });
  }
  function choose(e) {
    ((chosen = e), (pickerOpen = !1), ($("pq").value = chosenName()), $("pq").blur(), renderPeople(), onPick(e));
  }
  ($("pq").o("focus", function () {
    ((pickerOpen = !0), this.select(), renderPeople());
  }),
    $("pq").o("input", () => {
      ((pickerOpen = !0), renderPeople());
    }),
    $("pq").o("blur", () => {
      setTimeout(() => {
        ((pickerOpen = !1), renderPeople());
      }, 200);
    }),
    $("pq").o("keydown", (e) => {
      "Escape" === e.key && ((pickerOpen = !1), renderPeople());
    }));

  var DAY = 864e5,
    QUIET = 10,
    WORDS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 },
    STATE_LABEL = {
      upcoming: "Upcoming",
      done: "Completed",
      noshow: "No-show",
      canceled: "Canceled",
      rescheduled: "Rescheduled",
    },
    BADGE = {
      booked: ["Upcoming", "up"],
      waiting: ["Awaiting result", ""],
      quiet: ["No update", "warn"],
      noshow: ["No-show", "ns"],
      canceled: ["Canceled", "ns"],
      rescheduled: ["Rescheduled", "warn"],
    },
    OV_BADGE = {
      cleared: ["Cleared", "ok"],
      notcleared: ["Not cleared", "ns"],
      hold: ["On hold", "warn"],
      offer: ["Offer", "ok"],
      withdrew: ["Withdrew", "ns"],
    },
    OV_CHOICES = [
      ["", "Automatic"],
      ["cleared", "Cleared"],
      ["notcleared", "Not cleared"],
      ["hold", "On hold"],
      ["offer", "Offer"],
      ["withdrew", "Candidate withdrew"],
    ],
    SUFFIX = {
      pvt: 1,
      ltd: 1,
      private: 1,
      limited: 1,
      inc: 1,
      llp: 1,
      corp: 1,
      corporation: 1,
      co: 1,
      company: 1,
      technologies: 1,
      technology: 1,
      solutions: 1,
      services: 1,
      india: 1,
      global: 1,
      group: 1,
      systems: 1,
      software: 1,
      labs: 1,
    },
    results = {},
    joined = {},
    auto = {};
  function dayNum(e) {
    return _dp(e + "T00:00:00Z") / DAY;
  }
  function fetchResults(e) {
    var r = { results: {}, persistent: !0, locked: !1, failed: !0 };
    return laFetch("/api/results?event=" + encodeURIComponent(e) + mq())
      .then((e) => e.json().then((t) => (e.ok ? t : r)))
      .catch(() => r);
  }
  function stats(e, r) {
    var t = { held: [], noshow: 0, resched: 0, canceled: 0 };
    return (
      e.forEach((e) => {
        "canceled" !== e.status
          ? _dp(e.end) <= r && (e.noShow ? t.noshow++ : t.held.push(e))
          : e.rescheduled
            ? t.resched++
            : t.canceled++;
      }),
      t
    );
  }
  function roundKey(e) {
    return String(e || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }
  function roundRank(e) {
    var r = roundKey(e);
    if (!r) return null;
    if (/final|last|offer/.test(r)) return 90;
    var t = r.match(/\d+/);
    if (t) return +t[0];
    for (var a in WORDS) if (r.indexOf(a) >= 0) return WORDS[a];
    return /screen|phone|intro/.test(r) ? 0 : null;
  }
  function bucketOf(e) {
    return e <= 1 ? 0 : 2 === e ? 1 : 3 === e ? 2 : e < 90 ? 3 : 4;
  }
  function ordinal(e) {
    var r = e % 100;
    return e + (r >= 11 && r <= 13 ? "th" : e % 10 == 1 ? "st" : e % 10 == 2 ? "nd" : e % 10 == 3 ? "rd" : "th");
  }
  function roundShort(e) {
    var r = roundRank(e);
    return 90 === r
      ? "Final"
      : 0 === r
        ? "Screen"
        : null !== r
          ? ordinal(r)
          : String(e || "")
              .trim()
              .slice(0, 10) || "Interview";
  }
  function evState(e, r) {
    return "canceled" === e.status
      ? e.rescheduled
        ? "rescheduled"
        : "canceled"
      : _dp(e.end) > r
        ? "upcoming"
        : e.noShow
          ? "noshow"
          : "done";
  }
  function relDay(e, r) {
    var t = dayNum(ymd(new Date(e))) - dayNum(ymd(new Date(r)));
    return t <= 0 ? "Today" : 1 === t ? "Tomorrow" : "In " + t + " days";
  }
  function canon(e) {
    e = auto[e] || e;
    for (var r = 0; joined[e] && r++ < 10;) e = joined[e];
    return e;
  }
  function digits(e) {
    return e.replace(/\D/g, "");
  }
  function sameCompany(e, r) {
    var t = simKey(e),
      a = simKey(r);
    if (!t || !a) return !1;
    var n = t.replace(/ /g, ""),
      o = a.replace(/ /g, "");
    if (digits(n) !== digits(o)) return !1;
    if (n === o) return !0;
    var s = Math.min(n.length, o.length),
      u = Math.max(n.length, o.length);
    return s >= 5 && osa(n, o) <= (u <= 9 ? 1 : 2);
  }
  function buildAuto(e) {
    var r,
      t,
      a = {},
      n = {},
      o = [],
      s = {};
    function u(e) {
      for (; s[e] !== e;) e = s[e];
      return e;
    }
    for (
      e.forEach((e) => {
        var r = String(e.company || "")
          .trim()
          .toLowerCase();
        r && (void 0 === a[r] && ((a[r] = 0), (n[r] = 0), o.push(r)), a[r]++, (n[r] = Math.max(n[r], _dp(e.start))));
      }),
        o.forEach((e) => {
          s[e] = e;
        }),
        r = 0;
      r < o.length;
      r++
    )
      for (t = r + 1; t < o.length; t++)
        if (sameCompany(o[r], o[t])) {
          var l = u(o[r]),
            i = u(o[t]);
          l !== i && (s[i] = l);
        }
    var d = {};
    (o.forEach((e) => {
      var r = u(e);
      (d[r] = d[r] || []).push(e);
    }),
      (auto = {}),
      Object.keys(d).forEach((e) => {
        var r = d[e];
        if (!(r.length < 2)) {
          var t = r[0];
          (r.forEach((e) => {
            (a[e] !== a[t]
              ? a[e] > a[t]
              : simKey(e) === simKey(t) && e.length !== t.length
                ? e.length < t.length
                : n[e] > n[t]) && (t = e);
          }),
            r.forEach((e) => {
              e !== t && (auto[e] = t);
            }));
        }
      }));
  }
  function osa(e, r) {
    var t,
      a,
      n = e.length,
      o = r.length,
      s = [];
    for (t = 0; t <= n; t++) s[t] = [t];
    for (a = 1; a <= o; a++) s[0][a] = a;
    for (t = 1; t <= n; t++)
      for (a = 1; a <= o; a++) {
        var u = e[t - 1] === r[a - 1] ? 0 : 1;
        ((s[t][a] = Math.min(s[t - 1][a] + 1, s[t][a - 1] + 1, s[t - 1][a - 1] + u)),
          t > 1 &&
            a > 1 &&
            e[t - 1] === r[a - 2] &&
            e[t - 2] === r[a - 1] &&
            (s[t][a] = Math.min(s[t][a], s[t - 2][a - 2] + 1)));
      }
    return s[n][o];
  }
  function simKey(e) {
    return e
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((e) => e && !SUFFIX[e])
      .join(" ");
  }
  function similar(e, r) {
    var t = simKey(e),
      a = simKey(r);
    if (!t || !a) return !1;
    if (digits(t) !== digits(a)) return !1;
    if (t === a) return !0;
    var n = t.replace(/ /g, ""),
      o = a.replace(/ /g, "");
    if (n === o) return !0;
    var s = Math.min(n.length, o.length),
      u = Math.max(n.length, o.length);
    if (s >= 4 && osa(n, o) <= (u <= 7 ? 1 : 2)) return !0;
    var l = t.split(" "),
      i = a.split(" "),
      d = l.length <= i.length ? l : i,
      h = d === l ? i : l;
    if (d.join("").length >= 4 && d.length < h.length) {
      for (var c = 0; c < d.length; c++) if (h[c] !== d[c]) return !1;
      return !0;
    }
    return !1;
  }
  function dupes(e) {
    for (var r = [], t = 0; t < e.length; t++)
      for (var a = t + 1; a < e.length; a++)
        e[t].key &&
          e[a].key &&
          similar(e[t].key, e[a].key) &&
          r.push({ a: e[t].key, b: e[a].key, an: e[t].name, bn: e[a].name });
    return r;
  }
  function progress(e) {
    var r = Date.now(),
      t = {},
      a = [];
    (buildAuto(e),
      e.forEach((e) => {
        var r = String(e.company || "").trim(),
          n = canon(r.toLowerCase());
        t[n] || ((t[n] = { names: {}, evs: [] }), a.push(n));
        var o = t[n];
        (o.evs.push(e), (o.names[r] = (o.names[r] || 0) + 1));
      }));
    var n = [];
    a.forEach((e) => {
      for (
        var r = t[e].evs
            .filter((e) => "canceled" !== e.status)
            .map((e) => _dp(e.start))
            .sort((e, r) => e - r),
          a = 1;
        a < r.length;
        a++
      ) {
        var o = (r[a] - r[a - 1]) / DAY;
        o >= 1 && n.push(o);
      }
    });
    var o = QUIET,
      s = !1;
    if (n.length >= 3) {
      var u = n.slice().sort((e, r) => e - r),
        l = u.length,
        i = l % 2 ? u[(l - 1) / 2] : (u[l / 2 - 1] + u[l / 2]) / 2;
      ((o = Math.min(21, Math.max(5, Math.ceil(1.5 * i)))), (s = !0));
    }
    var d = a.map((e) => {
      var a = t[e],
        n = [],
        s = [],
        u = [];
      a.evs.forEach((e) => {
        "canceled" !== e.status ? n.push(e) : e.rescheduled ? u.push(e) : s.push(e);
      });
      var l = n.length ? n : s.length ? s : u,
        i = l.every((e) => null !== roundRank(e.round)),
        d = l.slice().sort((e, r) => {
          if (i) {
            var t = roundRank(e.round) - roundRank(r.round);
            if (t) return t;
          }
          return _dp(e.start) - _dp(r.start);
        }),
        h = d[d.length - 1],
        c = "";
      if (n.length) {
        var f = s
          .filter((e) => {
            var r = roundRank(e.round),
              t = roundRank(h.round);
            return _dp(e.start) > _dp(h.start) || (i && null !== r && null !== t && r > t);
          })
          .sort((e, r) => _dp(r.start) - _dp(e.start));
        f.length && (c = (f[0].round || "An interview") + " was canceled");
      }
      var p = (n.length ? n : a.evs).map((e) => _dp(e.start)),
        v = "",
        g = 0;
      Object.keys(a.names).forEach((r) => {
        (a.names[r] > g || (a.names[r] === g && r.toLowerCase() === e)) && ((g = a.names[r]), (v = r));
      });
      var m,
        w,
        y,
        D,
        k = n.filter((e) => _dp(e.end) > r).sort((e, r) => _dp(e.start) - _dp(r.start)),
        b = n.filter((e) => _dp(e.end) <= r).sort((e, r) => _dp(r.end) - _dp(e.end)),
        E = b.length ? _dp(b[0].end) : 0,
        S = E ? Math.floor((r - E) / DAY) : 0,
        C = roundRank(h.round),
        O = null;
      k.length
        ? ((m = "booked"), (w = relDay((O = _dp(k[0].start)), r)), (y = k[0].start), (D = "Next"))
        : (b.length ? ((y = b[0].start), (D = "Last")) : ((y = h.start), (D = "Was booked for")),
          n.length
            ? "noshow" === evState(h, r)
              ? ((m = "noshow"), (w = "Marked as no-show"))
              : S >= o
                ? ((m = "quiet"), (w = "No news for " + S + " days (likely not cleared)"))
                : ((m = "waiting"),
                  (w =
                    "Interview was " +
                    (S < 1 ? "today" : S + (1 === S ? " day" : " days") + " ago") +
                    (90 === C ? ". Waiting for a result." : ". Waiting to hear back.")))
            : (w = "rescheduled" === (m = evState(h, r)) ? "Rescheduled, new time not booked" : "Not rebooked"));
      var R = [],
        A = {};
      (n
        .filter((e) => _dp(e.end) <= r && !e.noShow)
        .forEach((e) => {
          var r = n.some((r) => {
              if (r === e) return !1;
              var t = roundRank(r.round),
                a = roundRank(e.round);
              return null !== t && null !== a
                ? t > a
                : _dp(r.start) > _dp(e.start) && roundKey(r.round) !== roundKey(e.round);
            }),
            t = roundKey(e.round) || "(none)";
          r && !A[t] && ((A[t] = 1), R.push(e));
        }),
        R.sort((e, r) => {
          var t = roundRank(e.round),
            a = roundRank(r.round);
          return null !== t && null !== a && t !== a ? t - a : _dp(e.start) - _dp(r.start);
        }));
      var x = v ? niceName(v) : "Company not given",
        M = results[e] || "";
      (M ||
        Object.keys(a.names).forEach((e) => {
          var r = e.toLowerCase();
          !M && results[r] && (M = results[r]);
        }),
        M && !OV_BADGE[M] && (M = ""));
      var K = M ? OV_BADGE[M] : BADGE[m];
      M && "booked" !== m && (w = "Marked by you: " + OV_BADGE[M][0]);
      for (
        var L = Object.keys(a.names).filter((e) => e && e.toLowerCase() !== (v || "").toLowerCase()),
          I = n.map((e) => _dp(e.start)).sort((e, r) => e - r),
          N = [],
          j = 1;
        j < I.length;
        j++
      ) {
        var T = (I[j] - I[j - 1]) / DAY;
        T >= 1 && N.push(T);
      }
      var B = [];
      return (
        n.forEach((e) => {
          var r = roundRank(e.round);
          if (null !== r) {
            var t = bucketOf(r);
            B.indexOf(t) < 0 && B.push(t);
          }
        }),
        {
          key: e,
          name: x,
          aliases: L,
          cleared: R.map((e) => e.round || "Interview"),
          badge: K[0],
          badgeCls: K[1],
          override: M,
          rawKeys: Object.keys(a.names)
            .map((e) => e.toLowerCase())
            .concat([e]),
          stage: h.round || "Interview",
          state: evState(h, r),
          whenIso: y,
          whenLabel: D,
          curStart: h.start,
          count: n.length,
          note: c,
          last: Math.max.apply(null, p),
          events: a.evs,
          status: m,
          statusText: w,
          nextStart: O,
          since: S,
          rank: C,
          gapAvg: N.length ? N.reduce((e, r) => e + r, 0) / N.length : null,
          attended: B,
          maxB: B.length ? Math.max.apply(null, B) : -1,
        }
      );
    });
    return (
      d.sort((e, r) => {
        var t = "booked" === e.status,
          a = "booked" === r.status;
        return t !== a ? (t ? -1 : 1) : t && a ? e.nextStart - r.nextStart : r.last - e.last;
      }),
      { rows: d, gaps: n, T: o, personal: s }
    );
  }

  plinkOn = !1;
  var data = null,
    e = 0,
    n = "",
    t = [],
    a = 0,
    d = null,
    l = { persistent: !0, locked: !1, failed: !1 },
    i = "",
    r = "",
    o = "",
    s = ["1st round", "2nd round", "3rd round", "4th round or later", "Final round"];
  function onPick(e) {
    u(e.event);
  }
  function p(e, n, t) {
    var a = $(e);
    a.textContent = "";
    var d = _dv("chead");
    return (d.a(el("b", null, n)), t && d.a(_sp("sub", t)), a.a(d), a);
  }
  function h() {
    (["sumline", "attn", "cgrid", "cleg", "csub", "cIns"].forEach((e) => {
      $(e).textContent = "";
    }),
      ($("attn").style.display = "none"));
  }
  function c() {
    var e = $("asub");
    ((e.textContent = ""), e.a(_sp("spin")), e.a(document.createTextNode("Loading analytics\u2026")));
    var n,
      t,
      a = $("sumline");
    for (n = 0; n < 3; n++) a.a(_dv("skel sk-pill"));
    var d = _dv("pgrid");
    for (n = 0; n < 4; n++) {
      var l = _dv("grow");
      for (t = 0; t < 4; t++) l.a(_dv("skel sk-line sk-w" + (((n + t) % 3) + 1)));
      d.a(l);
    }
    $("cgrid").a(d);
    var i = $("cIns");
    for (n = 0; n < 3; n++) i.a(_dv("skel sk-line sk-w" + ((n % 3) + 1)));
  }
  function v() {
    if (chosen)
      try {
        0;
      } catch (e) {}
  }
  function u(n) {
    var t = ++e;
    ((data = null),
      (joined = {}),
      (results = {}),
      (d = null),
      ($("empty").hidden = !0),
      ($("an").hidden = !1),
      h(),
      ($("hist").hidden = !0),
      ($("reslink").hidden = !0),
      ($("cs").value = ""),
      ($("aname").textContent = chosenName()),
      ($("av").textContent = avOf(chosenName())),
      c(),
      Promise.all([
        laFetch("/api/analytics?event=" + encodeURIComponent(n) + mq()).then((e) =>
          e.json().then((n) => ({
            ok: e.ok,
            j: n,
          })),
        ),
        fetchResults(n),
      ])
        .then((a) => {
          var d = a[0];
          if (t === e) {
            if (!d.ok) return (h(), void ($("asub").textContent = (d.j && d.j.error) || "Couldn't load analytics."));
            ((data = d.j),
              (results = a[1].results || {}),
              (l = a[1]),
              chosen ? chosen.name || (chosen.name = data.name) : (chosen = { name: data.name, event: n }),
              document.activeElement !== $("pq") && ($("pq").value = chosenName()),
              f(),
              A());
          }
        })
        .catch(() => {
          t === e && (h(), ($("asub").textContent = "Couldn't load analytics. Check your connection and try again."));
        }));
  }
  function m(e) {
    return String(e || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .sort()
      .join(" ");
  }
  function C(e) {
    return fmt({ weekday: "short", day: "numeric", month: "short" }, new Date(e));
  }
  function f() {
    if (!(l.locked || l.failed || Object.keys(results).length)) {
      var e = "";
      try {
        e = localStorage.getItem("lv_r:" + m(data.name)) || "";
      } catch (e) {}
      if (e) {
        var n = {};
        (e.split(",").forEach((e) => {
          var t = e.lastIndexOf(":");
          if (!(t < 1)) {
            var a,
              d = e.slice(t + 1);
            try {
              a = decodeURIComponent(e.slice(0, t));
            } catch (e) {
              return;
            }
            OV_BADGE[d] && (n[a] = d);
          }
        }),
          Object.keys(n).length &&
            ((results = n),
            D({ set: n, remove: [] }, null, !1, () => {
              try {
                localStorage.removeItem("lv_r:" + m(data.name));
              } catch (e) {}
            })));
      }
    }
  }
  function w() {
    if (data) {
      (reqId++,
        (r = "res"),
        (o = ""),
        ($("ptitle").textContent = "Update results"),
        ($("psub").textContent = niceName(data.name) + " \u00B7 saved on the server"),
        ($("plink").hidden = !0));
      var e = $("plist");
      e.textContent = "";
      var n = _dv("banner");
      ((n.id = "rnote"), (n.hidden = !0), e.a(n), e.a(_dv("sub", "Company")));
      var t = el("input");
      ((t.type = "search"),
        (t.id = "rq"),
        (t.placeholder = "Type a company name"),
        (t.autocomplete = "off"),
        t.setAttribute("aria-label", "Company"),
        t.o("input", () => {
          ((o = ""), k(), b());
        }),
        t.o("keydown", function (e) {
          if (
            ("Escape" === e.key && this.value && (e.stopPropagation(), (this.value = ""), (o = ""), k(), b()),
            "Enter" === e.key)
          ) {
            var n = y();
            1 === n.length && g(n[0]);
          }
        }),
        e.a(t));
      var a = _dv("results");
      ((a.id = "rsug"), (a.hidden = !0), e.a(a));
      var d = el("div");
      ((d.id = "redit"), e.a(d), x(), showPanel(!0), t.focus());
    }
  }
  function y() {
    var e = $("rq").value.trim().toLowerCase();
    return e ? t.filter((n) => (n.name + " " + n.aliases.join(" ")).toLowerCase().indexOf(e) >= 0) : [];
  }
  function g(e) {
    ((o = e.key), ($("rq").value = e.name), k(), b());
  }
  function k() {
    var e = $("rsug");
    if (((e.textContent = ""), $("rq").value.trim() && !o)) {
      var n = y();
      ((e.hidden = !1),
        n.length
          ? n.slice(0, 8).forEach((n) => {
              var t = _dv("rrow"),
                a = _dv("rmain");
              ((t.tabIndex = 0),
                t.setAttribute("role", "button"),
                a.a(el("b", null, n.name)),
                a.a(_dv("sub", n.stage + " \u00B7 " + n.badge)),
                t.a(a),
                t.o("click", () => {
                  g(n);
                }),
                t.o("keydown", (e) => {
                  ("Enter" !== e.key && " " !== e.key) || (e.preventDefault(), g(n));
                }),
                e.a(t));
            })
          : e.a(_dv("rempty", "No company matches.")));
    } else e.hidden = !0;
  }
  function b() {
    var e = $("redit");
    e.textContent = "";
    var n = null;
    if (
      (t.forEach((e) => {
        e.key === o && (n = e);
      }),
      n)
    ) {
      var a = _dv("rcard"),
        d = _dv("rtop");
      (d.a(el("b", null, n.name)),
        d.a(_sp("sub", n.stage + " \u00B7 " + n.badge + " \u00B7 " + n.whenLabel.toLowerCase() + " " + C(n.whenIso))),
        a.a(d),
        n.aliases.length && a.a(_dv("sub", "Also entered as: " + n.aliases.join(", "))),
        a.a(_dv("sub", "Result")));
      var l = el("select", "rsel2");
      (l.setAttribute("aria-label", "Result for " + n.name),
        OV_CHOICES.forEach((e) => {
          var t = el("option", null, e[1]);
          ((t.value = e[0]), e[0] === (n.override || "") && (t.selected = !0), l.a(t));
        }));
      var r = _dv("rmsg", n.key === i ? "Saved" : ""),
        s = n.override || "";
      (l.o("change", function () {
        E(n, this.value, r, () => {
          l.value = s;
        });
      }),
        a.a(l),
        a.a(r),
        e.a(a));
    } else
      $("rq").value.trim() ||
        e.a(_dv("sub hint", t.length ? "Type a company name above, then choose its result." : "No bookings yet."));
  }
  function x() {
    if ($("rq")) {
      var e = $("rnote"),
        n = l.failed
          ? "Couldn't load the saved results. Changes may not be kept."
          : l.persistent
            ? ""
            : "Server storage is not attached, so results are only kept until the next restart.";
      ((e.textContent = n), (e.hidden = !n), k(), b());
    }
  }
  function E(e, n, t, a) {
    var d = { set: {}, remove: e.rawKeys.filter((t) => t !== e.key || !n) };
    (n && (d.set[e.key] = n), (i = e.key), D(d, t, !1, null, a));
  }
  function D(e, n, t, a, d) {
    sendPut(
      "/api/results?event=" + encodeURIComponent(chosen.event) + mq(),
      e,
      n,
      t,
      (e) => {
        ((results = e.results || {}), (l = e), a && a(), A());
      },
      d,
    );
  }
  function S(e, n, t, a) {
    var d = $("sumline");
    function l(e, n, t) {
      var a = _dv("st" + (t ? " " + t : ""));
      (a.a(el("b", null, String(e))), a.a(_sp(null, n)), d.a(a));
    }
    d.textContent = "";
    var i = e.filter((e) => "active" === e.status && _dp(e.end) > a).length;
    (l(t.held.length, 1 === t.held.length ? "interview done" : "interviews done"),
      l(i, "upcoming"),
      l(n.length, 1 === n.length ? "company" : "companies"),
      t.resched && l(t.resched, "rescheduled", "warn"),
      t.canceled && l(t.canceled, "canceled", "bad"),
      t.noshow && l(t.noshow, 1 === t.noshow ? "no-show" : "no-shows", "bad"));
  }
  function N(e, n, t, a) {
    var d = $("attn");
    d.textContent = "";
    var l = 0;
    function i(e, n, t) {
      var a = _dv("att" + (t ? " " + t : ""));
      return (
        a.a(_dv("k", e)),
        n.forEach((e) => {
          a.a(_dv("t", e));
        }),
        d.a(a),
        l++,
        a
      );
    }
    var r = e.filter(
      (e) => !e.override && ("canceled" === e.status || "rescheduled" === e.status || "noshow" === e.status),
    );
    if (r.length) {
      var o = r
        .slice(0, 4)
        .map(
          (e) =>
            e.name +
            ": " +
            e.stage +
            ("noshow" === e.status
              ? " no-show"
              : "rescheduled" === e.status
                ? " was rescheduled, new time not booked"
                : " was canceled and not rebooked"),
        );
      (r.length > 4 && o.push("and " + (r.length - 4) + " more"), i("Needs a look", o, "warn"));
    }
    (dupes(e)
      .slice(0, 3)
      .forEach((e) => {
        var n = i("Possible duplicate company", [e.an + " and " + e.bn + " look like the same company."], "warn"),
          t = el("button", null, "Combine in this view");
        ((t.title = "Only for this page view. It is not saved."),
          t.o("click", () => {
            ((joined[e.b] = e.a), A());
          }),
          n.a(t));
      }),
      (d.style.display = l ? "" : "none"));
  }
  function L(e, n) {
    var t = $("cgrid"),
      a = $("cleg"),
      d = $("csub"),
      l = t.querySelector(".pgrid"),
      i = l ? l.scrollTop : 0;
    if (((t.textContent = ""), (a.textContent = ""), !e.length))
      return ((d.textContent = ""), void t.a(_dv("cempty", "No bookings yet.")));
    var r = $("cs").value.trim().toLowerCase(),
      o = r ? e.filter((e) => (e.name + " " + e.aliases.join(" ")).toLowerCase().indexOf(r) >= 0) : e;
    if (
      ((d.textContent = r
        ? o.length + " of " + e.length + " match"
        : e.length + (1 === e.length ? " company" : " companies")),
      o.length)
    ) {
      var s = [];
      e.forEach((e) => {
        e.events.forEach((e) => {
          s.push(_dp(e.start));
        });
      });
      var p = dayNum(ymd(new Date(Math.min.apply(null, s)))),
        h = Math.max(dayNum(ymd(new Date(Math.max.apply(null, s)))), dayNum(ymd(new Date(n)))) - p + 1,
        c = _dv("pgrid"),
        v = _dv("grow ghead");
      ["Company", "Current stage", "Next / last"].forEach((e) => {
        v.a(_dv(null, e));
      });
      var u,
        m = el("div"),
        C = _dv("tl-track axis"),
        f = Math.min(h, 6);
      for (u = 0; u < f; u++) {
        var w = 1 === f ? 0 : Math.round((u * (h - 1)) / (f - 1)),
          y = _sp("tl-tick", k(w));
        ((y.style.left = ((w + 0.5) / h) * 100 + "%"), C.a(y));
      }
      (m.a(C),
        v.a(m),
        c.a(v),
        o.forEach((e) => {
          var t = _dv("grow"),
            a = el("div");
          (a.setAttribute("data-l", "Company"),
            a.a(el("b", null, e.name)),
            a.a(_dv("sub", e.count + (1 === e.count ? " interview" : " interviews"))),
            e.aliases.length && a.a(_dv("sub", "Also entered as: " + e.aliases.join(", "))));
          var d = el("div");
          (d.setAttribute("data-l", "Current stage"), d.a(_dv("stage", e.stage)));
          var l = _dv("stline");
          (l.a(_sp("badge " + e.badgeCls, e.badge)),
            d.a(l),
            d.a(_dv("sub", e.statusText)),
            e.cleared.length && d.a(_dv("sub cleared", "Cleared: " + e.cleared.join(", "))),
            e.note && d.a(_dv("sub", e.note)));
          var i = el("div");
          i.setAttribute("data-l", "Next / last");
          var r = new Date(e.whenIso);
          (i.a(_dv("sub", e.whenLabel)),
            i.a(_dv("nwhen", fmt({ weekday: "short", day: "numeric", month: "short" }, r) + " · " + t12(r))));
          var o = el("div");
          o.setAttribute("data-l", "Journey");
          var s = e.events
              .slice()
              .sort((e, n) => _dp(e.start) - _dp(n.start))
              .map((e) => ({ e, p: g(_dp(e.start)) })),
            p = [-1e9, -1e9, -1e9],
            v = 1;
          s.forEach((e) => {
            var n,
              t = -1,
              a = 0;
            for (n = 0; n < 3; n++) {
              if (e.p - p[n] >= 12) {
                t = n;
                break;
              }
              p[n] < p[a] && (a = n);
            }
            (t < 0 && (t = a), (e.lane = t), (p[t] = e.p), t + 1 > v && (v = t + 1));
          });
          var u = _dv("tl-track");
          ((u.style.height = (1 === v ? 36 : 2 === v ? 58 : 80) + "px"), u.a(_dv("tl-line")));
          var m = _dv("tl-today");
          ((m.style.left = g(n) + "%"),
            u.a(m),
            s.forEach((t) => {
              var a = t.e,
                d = evState(a, n),
                l = new Date(a.start),
                i = _sp("tdot " + d + (a.start === e.curStart ? " now" : ""), roundShort(a.round));
              ((i.style.left = t.p + "%"),
                (i.style.top = ((t.lane + 0.5) / v) * 100 + "%"),
                (i.title =
                  e.name +
                  " \u00B7 " +
                  (a.round || "Interview") +
                  " \u00B7 " +
                  fmt({ weekday: "short", day: "numeric", month: "short", year: "numeric" }, l) +
                  " \u00B7 " +
                  t12(l) +
                  " \u00B7 " +
                  STATE_LABEL[d]),
                u.a(i));
            }),
            o.a(u));
          var C = _dv("tl-ends");
          (C.a(_sp(null, k(0))), C.a(_sp(null, k(h - 1))), o.a(C), t.a(a), t.a(d), t.a(i), t.a(o), c.a(t));
        }),
        t.a(c),
        ((a.textContent = ""),
        [
          ["done", "Completed"],
          ["upcoming", "Upcoming"],
          ["rescheduled", "Rescheduled"],
          ["canceled", "Canceled or no-show"],
          ["today", "Today"],
        ].forEach(function (x) {
          a.a(_sp("lg2 " + x[0], x[1]));
        })),
        (c.scrollTop = i),
        c.scrollHeight > c.clientHeight && (d.textContent += " \u00B7 scroll to see all"));
    } else t.a(_dv("cempty", "No company matches your search."));
    function g(e) {
      var n = new Date(e);
      return ((dayNum(ymd(n)) - p + mod(n) / 1440) / h) * 100;
    }
    function k(e) {
      return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
        new Date((p + e) * DAY + 432e5),
      );
    }
  }
  function I(e) {
    var n = el("div");
    n.a(_dv("ksec", "How far each company got"));
    var t = [0, 1, 2, 3, 4]
      .map((n) => {
        var t = { label: s[n], n: 0, moved: 0, failed: 0, other: 0, wait: 0 };
        return (
          e.forEach((e) => {
            if (!(e.attended.indexOf(n) < 0)) {
              t.n++;
              var a = e.override;
              e.maxB > n || (e.maxB === n && ("cleared" === a || "offer" === a))
                ? t.moved++
                : "notcleared" === a
                  ? t.failed++
                  : "withdrew" === a || "hold" === a
                    ? t.other++
                    : t.wait++;
            }
          }),
          t
        );
      })
      .filter((e) => e.n > 0);
    if (!t.length) return (n.a(_dv("why", "No numbered rounds yet.")), n);
    var a = _dv("ptab"),
      d = _dv("pr h");
    (["Round", "Total", "Moved on", "Not cleared", "Hold / withdrew", "Waiting"].forEach((e) => {
      d.a(_dv(null, e));
    }),
      a.a(d),
      t.forEach((e) => {
        var n = _dv("pr");
        (n.a(_dv(null, e.label)),
          n.a(_dv(null, String(e.n))),
          n.a(_dv("g", e.moved + " (" + Math.round((e.moved / e.n) * 100) + "%)")),
          n.a(_dv(e.failed ? "bd" : "", String(e.failed))),
          n.a(_dv(null, String(e.other))),
          n.a(_dv(null, String(e.wait))),
          a.a(n));
      }),
      n.a(a));
    var l = e.filter((e) => "offer" === e.override).length;
    l && kvRow(n, "Offers", String(l));
    var i = e.filter((e) => e.count > 0 && 0 === e.attended.length).length;
    return (
      n.a(
        _dv(
          "why",
          "Moved on means the company booked a later round, or you marked it Cleared or Offer. Not cleared, hold and withdrew come from Update results." +
            (i
              ? " " +
                i +
                (1 === i ? " company has" : " companies have") +
                " round names without a number and " +
                (1 === i ? "isn't" : "aren't") +
                " counted."
              : ""),
        ),
      ),
      n
    );
  }
  function R(e) {
    var n = new Date(e + "T12:00:00Z").getUTCDay();
    return addDays(e, -(n + 6) % 7);
  }
  function T(e, n) {
    var t = el("div");
    t.a(_dv("ksec", "Interviews per week"));
    var a,
      d = R(ymd(new Date(n))),
      l = [];
    for (a = -5; a <= 2; a++) l.push(addDays(d, 7 * a));
    var i = l.map(() => 0);
    e.forEach((e) => {
      if ("active" === e.status)
        for (var n = ymd(new Date(e.start)), t = 0; t < l.length; t++)
          if (n >= l[t] && n <= addDays(l[t], 6)) {
            i[t]++;
            break;
          }
    });
    var r = Math.max.apply(null, i);
    if (!i.reduce((e, n) => e + n, 0)) return (t.a(_dv("why", "No interviews in the last 6 weeks or the next 2.")), t);
    function o(e) {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "short",
        day: "numeric",
      }).format(new Date(e + "T12:00:00Z"));
    }
    var s = _dv("vbars");
    if (
      (l.forEach((e, n) => {
        var t = _dv("vcol" + (5 === n ? " cur" : n > 5 ? " fut" : ""));
        ((t.title = "Week of " + o(e) + ": " + i[n] + (1 === i[n] ? " interview" : " interviews")),
          t.a(_dv("vval", i[n] ? String(i[n]) : "")));
        var a = _dv("vwrap"),
          d = _dv("vbar");
        ((d.style.height = i[n] ? Math.max(4, Math.round((i[n] / r) * 70)) + "px" : "0px"),
          a.a(d),
          t.a(a),
          t.a(_dv("vlab", o(e))),
          s.a(t));
      }),
      t.a(s),
      kvRow(t, "This week", i[5] + (1 === i[5] ? " interview" : " interviews")),
      kvRow(t, "Next 2 weeks", i[6] + i[7] + " booked"),
      r >= 2)
    ) {
      var p = i.indexOf(r);
      kvRow(t, "Busiest week", r + " interviews (week of " + o(l[p]) + ")");
    }
    return t;
  }
  function O(e, n) {
    if (!(n.resched || n.canceled || n.noshow)) return null;
    var t = el("div");
    t.a(_dv("ksec", "Cancellations and no-shows"));
    var a = e.filter((e) => "canceled" === e.status);
    (n.resched && kvRow(t, "Rescheduled", String(n.resched)),
      n.canceled && kvRow(t, "Canceled", String(n.canceled)),
      n.noshow && kvRow(t, "No-shows", String(n.noshow)));
    var d = a.filter((e) => "invitee" === e.canceledBy).length,
      l = a.filter((e) => "host" === e.canceledBy).length;
    d + l > 0 && kvRow(t, "Canceled by", "Candidate " + d + " \u00B7 You " + l);
    var i = a
      .filter((e) => e.cancelReason)
      .sort((e, n) => _dp(n.start) - _dp(e.start))
      .slice(0, 4);
    return (
      i.forEach((e) => {
        t.a(
          _dv(
            "why",
            fmt({ day: "numeric", month: "short" }, new Date(e.start)) +
              " \u00B7 " +
              (e.company || "Company not given") +
              " \u00B7 " +
              (e.rescheduled ? "rescheduled" : "canceled") +
              ": " +
              e.cancelReason,
          ),
        );
      }),
      a.length && !i.length && t.a(_dv("why", "No cancellation reasons were given.")),
      t
    );
  }
  function j(e, n) {
    var t = {},
      a = 0,
      d = 0;
    if (
      (e.forEach((e) => {
        if (!("active" !== e.status || e.noShow || _dp(e.end) > n)) {
          var l = ivMap[e.id];
          l ? ((t[l] = (t[l] || 0) + 1), a++) : d++;
        }
      }),
      !a)
    )
      return null;
    var l = el("div");
    return (
      l.a(_dv("ksec", "Who interviewed")),
      Object.keys(t)
        .sort((e, n) => t[n] - t[e] || (e < n ? -1 : 1))
        .forEach((e) => {
          kvRow(l, e, t[e] + (1 === t[e] ? " interview" : " interviews"), ivCls(e));
        }),
      d && kvRow(l, "Not recorded", String(d)),
      l
    );
  }
  function onIv() {
    data && d && U.apply(null, d);
  }
  function U(e, n, t, a, d) {
    var l = p("cIns", "Insights", ""),
      i = _dv("icols");
    i.a(I(n));
    var r = j(e, d);
    r && i.a(r);
    var o = O(e, t);
    (o && i.a(o), l.a(i));
  }
  function A() {
    if (data) {
      var e = data.events,
        l = Date.now(),
        i = stats(e, l),
        o = progress(e),
        s = o.rows;
      ((t = s), (a = l), ($("aname").textContent = niceName(data.name)), ($("av").textContent = avOf(data.name)));
      var p = $("asub");
      ((p.textContent = ""),
        data.emails > 1
          ? (p.a(document.createTextNode("Combined from " + data.emails + " email addresses \u00B7 ")),
            h("Show separately", () => {
              q(!1);
            }))
          : merge ||
            (p.a(document.createTextNode("Showing one email address only \u00B7 ")),
            h("Combine again", () => {
              q(!0);
            })),
        ($("hist").hidden = !1),
        ($("reslink").hidden = !1),
        S(e, s, i, l),
        N(s, e, l, o),
        L(s, l),
        (d = [e, s, i, o, l]),
        U(e, s, i, o, l),
        ["sumline", "attn", "cgrid", "cIns"].forEach((e) => {
          var n = $(e);
          (n.classList.remove("enter"), n.offsetWidth, n.classList.add("enter"));
        }),
        "res" !== r || $("panel").hidden || x(),
        v(),
        (n = state.tz));
    }
    function h(e, n) {
      var t = el("button", "linkbtn", e);
      (t.o("click", n), p.a(t));
    }
  }
  function render() {
    (paintBanner(), paintStatus(), data && n !== state.tz && A(), renderPeople(), syncPeople());
  }
  function q(e) {
    ((merge = e), loadPeople(), chosen && u(chosen.event));
  }
  (($("hist").onclick = () => {
    chosen &&
      ((r = ""),
      openPerson({
        id: chosen.event,
        invitee: data ? data.name : chosen.name,
      }));
  }),
    ($("reslink").onclick = w),
    $("cs").o("input", () => {
      L(t, a);
    }));
  var M = new URLSearchParams(location.search).get("event");
  (M && /^[0-9a-f-]{36}$/i.test(M) && ((chosen = { name: "", event: M }), (pickerOpen = !1), u(M)),
    loadPeople(),
    connect());

  function connect() {
    laFetch("/api/state")
      .then(function (r) {
        return r.json();
      })
      .then(function (s) {
        state = s;
        live = !0;
        lastSeen = Date.now();
        render();
      })
      .catch(function () {
        live = !1;
        paintStatus();
      });
  }
  setInterval(function () {
    if (document.visibilityState === "visible") connect();
  }, 60000);
})();
