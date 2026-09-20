import { randomBytes } from "node:crypto";

const TOKEN = (Bun.env.CALENDLY_TOKEN ?? "").trim();
const NTFY_TOPIC = (Bun.env.NTFY_TOPIC ?? "").trim();
const NTFY_SERVER = (Bun.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, "");
const POLL_MS = Math.max(15, Number(Bun.env.POLL_SECONDS ?? 30) || 30) * 1000;
const PORT = Number(Bun.env.PORT ?? 3000);
const API = "https://api.calendly.com";
const DAYS_BACK = 42;
const DAYS_AHEAD = 60;
const MAX_CLIENTS = 50;

const configError = !TOKEN ? "CALENDLY_TOKEN is not set" : "";

type Detail = { invitee: string; company: string; round: string; email: string; noShow: boolean; rescheduled: boolean; canceled: boolean; cancelReason: string; canceledBy: string };
type Ev = { id: string; name: string; start: string; end: string; invitee: string; company: string; round: string };
type Hist = {
  id: string;
  name: string;
  start: string;
  end: string;
  status: "upcoming" | "completed" | "noshow";
  company: string;
  round: string;
  location: string;
};
type Person = { name: string; emails: number; events: Hist[] };
type State = { ready: boolean; events: Ev[]; tz: string; host: string; error: string; lastChecked: number };

class CalError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, message: string, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function cal(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + TOKEN },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 429) throw new CalError(429, "rate limited", Number(res.headers.get("retry-after") ?? 60));
  if (!res.ok) throw new CalError(res.status, "calendly error");
  return res.json();
}

const enc = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

function send(evt: string, data: unknown) {
  const chunk = enc.encode("event: " + evt + "\ndata: " + JSON.stringify(data) + "\n\n");
  for (const c of clients) {
    try {
      c.enqueue(chunk);
    } catch {
      clients.delete(c);
    }
  }
}

setInterval(() => {
  const ping = enc.encode(": ping\n\n");
  for (const c of clients) {
    try {
      c.enqueue(ping);
    } catch {
      clients.delete(c);
    }
  }
}, 20000);

const state: State = { ready: false, events: [], tz: "UTC", host: "", error: "", lastChecked: 0 };
let me: { uri: string; tz: string; name: string } | null = null;
const inviteeCache = new Map<string, Detail>();
const histCache = new Map<string, Detail>();
let lastSig = "";
let firstPoll = true;

function remember(id: string, d: Detail) {
  if (histCache.size >= 500) {
    const k = histCache.keys().next().value;
    if (k) histCache.delete(k);
  }
  histCache.set(id, d);
}

function parseDetail(collection: any[]): Detail {
  const live = collection.filter((i: any) => i.status !== "canceled");
  const list = live.length ? live : collection;
  const first = list[0];
  const names = list.map((i) => i.name || i.email || "Guest");
  const answers = ((first?.questions_and_answers ?? []) as any[])
    .map((q) => ({ q: String(q.question ?? ""), a: String(q.answer ?? "").trim() }))
    .filter((x) => x.a);
  const rdMatch = answers.find((x) => /round|stage/i.test(x.q));
  const coMatch = answers.find((x) => /compan|organi[sz]ation|employer|firm|client/i.test(x.q));
  const company = coMatch ?? answers.find((x) => x !== rdMatch);
  const round = rdMatch ?? answers.find((x) => x !== company);
  return {
    invitee: names.join(", ") || "Guest",
    company: company?.a ?? "",
    round: round?.a ?? "",
    email: String(first?.email ?? "").trim(),
    noShow: !!first?.no_show,
    rescheduled: !!first?.rescheduled,
    canceled: live.length === 0 && collection.length > 0,
    cancelReason: String(first?.cancellation?.reason ?? "").trim().slice(0, 200),
    canceledBy: String(first?.cancellation?.canceler_type ?? "").toLowerCase(),
  };
}

async function fetchDetail(id: string): Promise<Detail> {
  const r = await cal("/scheduled_events/" + id + "/invitees", { count: "10" });
  return parseDetail(r.collection ?? []);
}

function locText(l: any): string {
  if (!l) return "";
  if (l.location) return String(l.location);
  if (l.type) return String(l.type).replace(/_/g, " ");
  return "";
}

function whenText(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: state.tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso));
}

function describe(e: Ev): string {
  const extra = [e.company, e.round].filter(Boolean).join(" · ");
  return e.invitee + (extra ? " (" + extra + ")" : "") + " — " + whenText(e.start);
}

async function notify(title: string, body: string) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(NTFY_SERVER + "/" + encodeURIComponent(NTFY_TOPIC), {
      method: "POST",
      body,
      headers: { Title: title, Tags: title === "Booking cancelled" ? "x" : "calendar" },
      signal: AbortSignal.timeout(10000),
    });
  } catch {}
}

const idOf = (e: any): string => String(e.uri).split("/").pop() as string;

let nextDelay = POLL_MS;

async function poll() {
  nextDelay = POLL_MS;
  try {
    if (!me) {
      const u = (await cal("/users/me")).resource;
      me = { uri: u.uri, tz: u.timezone || "UTC", name: u.name || "" };
      state.tz = me.tz;
      state.host = me.name;
    }
    const now = Date.now();
    const from = new Date(now - DAYS_BACK * 864e5).toISOString();
    const to = new Date(now + DAYS_AHEAD * 864e5).toISOString();
    const raw: any[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const p: Record<string, string> = {
        user: me.uri,
        status: "active",
        min_start_time: from,
        max_start_time: to,
        count: "100",
        sort: "start_time:asc",
      };
      if (pageToken) p.page_token = pageToken;
      const r = await cal("/scheduled_events", p);
      raw.push(...(r.collection ?? []));
      pageToken = r.pagination?.next_page_token || undefined;
      if (!pageToken) break;
    }

    const upcoming = raw.filter((e) => Date.parse(e.start_time) >= now);
    const past = raw.filter((e) => Date.parse(e.start_time) < now).reverse();
    let budget = 20;
    for (const e of [...upcoming, ...past]) {
      const id = idOf(e);
      if (inviteeCache.has(id)) continue;
      if (budget-- <= 0) break;
      try {
        inviteeCache.set(id, await fetchDetail(id));
      } catch (err) {
        if (err instanceof CalError && err.status === 429) throw err;
        break;
      }
    }

    const next: Ev[] = raw.map((e) => {
      const id = idOf(e);
      const c = inviteeCache.get(id);
      return {
        id,
        name: String(e.name ?? "Meeting"),
        start: e.start_time,
        end: e.end_time,
        invitee: c?.invitee ?? "Loading…",
        company: c?.company ?? "",
        round: c?.round ?? "",
      };
    });

    const nextIds = new Set(next.map((e) => e.id));
    for (const k of [...inviteeCache.keys()]) if (!nextIds.has(k)) inviteeCache.delete(k);

    const prevIds = new Set(state.events.map((e) => e.id));
    if (!firstPoll) {
      for (const e of next) {
        if (!prevIds.has(e.id) && Date.parse(e.start) > Date.now()) notify("New booking", describe(e));
      }
      for (const e of state.events) {
        if (!nextIds.has(e.id) && Date.parse(e.start) > Date.now()) notify("Booking cancelled", describe(e));
      }
    }
    firstPoll = false;

    state.events = next;
    state.error = "";
    state.ready = true;
    const sig = JSON.stringify(next) + state.tz;
    state.lastChecked = Date.now();
    if (sig !== lastSig) {
      lastSig = sig;
      send("state", state);
    } else {
      send("tick", { lastChecked: state.lastChecked });
    }
  } catch (err) {
    let msg = "Couldn't reach Calendly, retrying";
    if (err instanceof CalError) {
      if (err.status === 401 || err.status === 403) msg = "Calendly rejected the access token. Check CALENDLY_TOKEN.";
      else if (err.status === 429) {
        msg = "Calendly rate limit reached, retrying shortly";
        nextDelay = Math.max(POLL_MS, (err.retryAfter || 60) * 1000);
      } else msg = "Calendly returned an error (" + err.status + "), retrying";
    }
    state.lastChecked = Date.now();
    state.ready = true;
    if (state.error !== msg) {
      state.error = msg;
      send("state", state);
    } else {
      send("tick", { lastChecked: state.lastChecked });
    }
  } finally {
    setTimeout(poll, nextDelay);
  }
}

if (!configError) poll();

const normName = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function emailsFor(d: Detail, merge: boolean): string[] {
  const m = new Map<string, string>();
  m.set(d.email.toLowerCase(), d.email);
  const key = normName(d.invitee);
  if (merge && key && key !== "guest") {
    for (const c of [...inviteeCache.values(), ...histCache.values()]) {
      if (c.email && normName(c.invitee) === key && !m.has(c.email.toLowerCase())) m.set(c.email.toLowerCase(), c.email);
    }
  }
  return [...m.values()];
}

const personCache = new Map<string, { at: number; data: Person }>();
const personInflight = new Map<string, Promise<Person>>();

async function loadPersonEvents(email: string, status = "active"): Promise<any[]> {
  if (!me) throw new CalError(503, "not ready");
  const raw: any[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const p: Record<string, string> = {
      user: me.uri,
      invitee_email: email,
      status,
      count: "100",
      sort: "start_time:desc",
    };
    if (pageToken) p.page_token = pageToken;
    const r = await cal("/scheduled_events", p);
    raw.push(...(r.collection ?? []));
    pageToken = r.pagination?.next_page_token || undefined;
    if (!pageToken) break;
  }
  return raw;
}

async function loadPerEmail(emails: string[], wantCanceled: boolean): Promise<{ active: any[]; canceled: any[] }> {
  const seen = new Set<string>();
  const active: any[] = [];
  const canceled: any[] = [];
  for (const em of emails) {
    let use = em;
    let a = await loadPersonEvents(use);
    if (!a.length && use !== use.toLowerCase()) {
      use = use.toLowerCase();
      a = await loadPersonEvents(use);
    }
    for (const e of a) if (!seen.has(idOf(e))) (seen.add(idOf(e)), active.push(e));
    if (wantCanceled) {
      for (const e of await loadPersonEvents(use, "canceled")) if (!seen.has(idOf(e))) (seen.add(idOf(e)), canceled.push(e));
    }
  }
  return { active, canceled };
}

async function buildHistory(emails: string[], name: string): Promise<Person> {
  const raw = (await loadPerEmail(emails, false)).active;
  const now = Date.now();
  let lookups = 30;
  const events: Hist[] = [];
  for (const e of raw) {
    const id = idOf(e);
    let d = inviteeCache.get(id) ?? histCache.get(id);
    if (!d && lookups-- > 0) {
      try {
        d = await fetchDetail(id);
        remember(id, d);
      } catch (err) {
        if (err instanceof CalError && err.status === 429) throw err;
      }
    }
    const over = Date.parse(e.end_time) < now;
    events.push({
      id,
      name: String(e.name ?? "Interview"),
      start: e.start_time,
      end: e.end_time,
      status: !over ? "upcoming" : d?.noShow ? "noshow" : "completed",
      company: d?.company ?? "",
      round: d?.round ?? "",
      location: locText(e.location),
    });
  }
  events.sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return { name, emails: emails.length, events };
}

async function personHistory(eventId: string, merge: boolean): Promise<Person> {
  let d = inviteeCache.get(eventId) ?? histCache.get(eventId);
  if (!d) {
    d = await fetchDetail(eventId);
    remember(eventId, d);
  }
  if (!d.email) throw new CalError(404, "no email");
  const emails = emailsFor(d, merge);
  const key = emails.map((e) => e.toLowerCase()).sort().join("|");
  const hit = personCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.data;
  let p = personInflight.get(key);
  if (!p) {
    const name = d.invitee;
    p = buildHistory(emails, name)
      .then((data) => {
        if (personCache.size > 200) personCache.clear();
        personCache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => personInflight.delete(key));
    personInflight.set(key, p);
  }
  return p;
}

type AEvent = {
  id: string;
  name: string;
  start: string;
  end: string;
  created: string;
  status: "active" | "canceled";
  rescheduled: boolean;
  noShow: boolean;
  company: string;
  round: string;
  cancelReason: string;
  canceledBy: string;
};
type Analytics = { name: string; emails: number; events: AEvent[] };
const analyticsCache = new Map<string, { at: number; data: Analytics }>();
const analyticsInflight = new Map<string, Promise<Analytics>>();

async function buildAnalytics(emails: string[], name: string): Promise<Analytics> {
  const { active, canceled } = await loadPerEmail(emails, true);
  let lookups = 40;
  const events: AEvent[] = [];
  const add = async (e: any, status: "active" | "canceled") => {
    const id = idOf(e);
    let d = (status === "active" ? inviteeCache.get(id) : undefined) ?? histCache.get(id);
    if (!d && lookups-- > 0) {
      try {
        d = await fetchDetail(id);
        remember(id, d);
      } catch (err) {
        if (err instanceof CalError && err.status === 429) throw err;
      }
    }
    events.push({
      id,
      name: String(e.name ?? "Interview"),
      start: e.start_time,
      end: e.end_time,
      created: String(e.created_at ?? e.start_time),
      status,
      rescheduled: status === "canceled" && !!d?.rescheduled,
      noShow: status === "active" && !!d?.noShow,
      company: d?.company ?? "",
      round: d?.round ?? "",
      cancelReason: status === "canceled" ? d?.cancelReason ?? "" : "",
      canceledBy: status === "canceled" ? d?.canceledBy ?? "" : "",
    });
  };
  for (const e of active) await add(e, "active");
  for (const e of canceled) await add(e, "canceled");
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { name, emails: emails.length, events };
}

async function analyticsFor(eventId: string, merge: boolean): Promise<Analytics> {
  let d = inviteeCache.get(eventId) ?? histCache.get(eventId);
  if (!d) {
    d = await fetchDetail(eventId);
    remember(eventId, d);
  }
  if (!d.email) throw new CalError(404, "no email");
  const emails = emailsFor(d, merge);
  const key = emails.map((e) => e.toLowerCase()).sort().join("|");
  const hit = analyticsCache.get(key);
  if (hit && Date.now() - hit.at < 45000) return hit.data;
  let p = analyticsInflight.get(key);
  if (!p) {
    const name = d.invitee;
    p = buildAnalytics(emails, name)
      .then((data) => {
        if (analyticsCache.size > 200) analyticsCache.clear();
        analyticsCache.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => analyticsInflight.delete(key));
    analyticsInflight.set(key, p);
  }
  return p;
}

function people(merge: boolean) {
  type G = { name: string; count: number; last: number; event: string; emails: Set<string>; companies: Map<string, { c: string; t: number }> };
  const m = new Map<string, G>();
  for (const e of state.events) {
    const d = inviteeCache.get(e.id);
    if (!d || !d.email) continue;
    const nk = normName(d.invitee);
    const k = merge && nk && nk !== "guest" ? "n:" + nk : "e:" + d.email.toLowerCase();
    const t = Date.parse(e.start);
    let g = m.get(k);
    if (!g) {
      g = { name: d.invitee, count: 0, last: t, event: e.id, emails: new Set(), companies: new Map() };
      m.set(k, g);
    }
    g.count++;
    g.emails.add(d.email.toLowerCase());
    if (t >= g.last) {
      g.last = t;
      g.event = e.id;
      g.name = d.invitee;
    }
    const ck = d.company.trim().toLowerCase();
    if (ck) {
      const old = g.companies.get(ck);
      if (!old || t > old.t) g.companies.set(ck, { c: d.company.trim(), t });
    }
  }
  return [...m.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      name: g.name,
      count: g.count,
      event: g.event,
      company: [...g.companies.values()].sort((x, y) => y.t - x.t).slice(0, 3).map((x) => x.c).join(", "),
      last: new Date(g.last).toISOString(),
      emails: g.emails.size,
    }));
}

const SEC: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow",
  "Strict-Transport-Security": "max-age=31536000",
  "Cache-Control": "no-store",
};

function page(build: (nonce: string) => string, status = 200): Response {
  const nonce = randomBytes(16).toString("base64");
  const csp =
    "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce +
    "'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'";
  return new Response(build(nonce), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp, ...SEC },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...SEC },
  });
}

const BASE_CSS = String.raw`
:root{--bg:#fafaf8;--card:#fff;--text:#1f1e1d;--muted:#6b6a66;--line:#e4e2dc;--acc-bg:#e6f1fb;--acc-bd:#85b7eb;--acc-tx:#0c447c;--ok:#3b6d11;--warn:#ba7517;--bad:#a32d2d}
@media (prefers-color-scheme:dark){:root{--bg:#1c1b19;--card:#262522;--text:#f1efe8;--muted:#a09e96;--line:#3a3935;--acc-bg:#0c447c;--acc-bd:#378add;--acc-tx:#b5d4f4;--ok:#97c459;--warn:#ef9f27;--bad:#f09595}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:1200px;padding:16px 16px 48px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
button,input{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px 12px;min-height:36px}
button{cursor:pointer}
button:hover{border-color:var(--muted)}
h1{font-size:22px;font-weight:500;margin:0}
`;

const APP_CSS = String.raw`
h1{font-size:20px;margin:14px 0 0}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.nav{margin:12px 0;justify-content:flex-start}
.tabs{display:flex}
.tabs a{display:flex;align-items:center;min-height:36px;padding:0 16px;border:1px solid var(--line);background:var(--card);color:var(--text);text-decoration:none;font-size:14px}
.tabs a:first-child{border-radius:8px 0 0 8px}
.tabs a:last-child{border-radius:0 8px 8px 0}
.tabs a+a{border-left:0}
.tabs a.on{background:var(--acc-bg);border-color:var(--acc-bd);color:var(--acc-tx)}
.seg{display:flex}
.seg button{border-radius:0}
.seg button:first-child{border-radius:8px 0 0 8px}
.seg button:last-child{border-radius:0 8px 8px 0}
.seg button+button{border-left:0}
.seg button.on{background:var(--acc-bg);border-color:var(--acc-bd);color:var(--acc-tx)}
.sub{color:var(--muted);font-size:13px}
.hint{margin-top:10px}
.status{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--muted)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
.live .dot{background:var(--ok)}
.banner{background:var(--card);border:1px solid var(--warn);color:var(--warn);border-radius:8px;padding:8px 12px;margin:8px 0;font-size:14px}
.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.card .k{font-size:12px;color:var(--muted)}
.card .v{font-size:17px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card.click{position:relative;cursor:pointer;padding-right:28px}
.card.click:hover{border-color:var(--acc-bd)}
.card.click:focus-visible{outline:2px solid var(--acc-tx)}
.card.click::after{content:"";position:absolute;right:14px;top:50%;width:8px;height:8px;margin-top:-5px;border-right:2px solid var(--muted);border-top:2px solid var(--muted);transform:rotate(45deg)}
.wkwrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card);margin-top:14px}
.wkgrid{display:grid;grid-template-columns:40px repeat(7,minmax(84px,1fr));min-width:628px;padding-bottom:12px}
.wkcorner{position:sticky;left:0;z-index:3;background:var(--card);border-bottom:1px solid var(--line)}
.wkaxis{position:sticky;left:0;z-index:3;background:var(--card)}
.wklab{position:absolute;right:6px;font-size:11px;color:var(--muted);transform:translateY(-50%)}
.wkhead{display:flex;flex-direction:column;align-items:center;padding:6px 2px;border-left:1px solid var(--line);border-bottom:1px solid var(--line);background:var(--card);font-size:13px;font-weight:500;line-height:1.3}
.wkhead .wkcount{font-size:11px;font-weight:400;color:var(--muted)}
.wkhead.today{background:var(--acc-bg);color:var(--acc-tx)}
.wkhead.today .wkcount{color:var(--acc-tx)}
.wkcol{position:relative;border-left:1px solid var(--line);background-image:repeating-linear-gradient(to bottom,var(--line) 0,var(--line) 1px,transparent 1px,transparent 100px)}
.wkev{position:absolute;padding:2px 5px;border-radius:5px;background:var(--acc-bg);border:1px solid var(--acc-bd);color:var(--acc-tx);overflow:hidden;font-size:11px;line-height:1.2;cursor:pointer}
.wkev:hover{border-color:var(--acc-tx)}
.wkev:focus-visible{outline:2px solid var(--acc-tx);outline-offset:1px}
.wkev b{display:block;font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wkev .wkco{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wkev.roomy .wkco{white-space:normal}
.wkev.past{opacity:.55}
.wknow{position:absolute;left:0;right:0;border-top:2px solid var(--bad);z-index:2}
#q{flex:1 1 240px;min-width:160px;max-width:420px}
.results{border:1px solid var(--line);border-radius:10px;background:var(--card);margin:10px 0;overflow:hidden}
.rrow{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer}
.rrow:last-child{border-bottom:0}
.rrow:hover,.rrow:focus-visible{background:var(--acc-bg);outline:none}
.rrow.past{opacity:.65}
.rwhen{flex:0 0 190px;font-size:13px;color:var(--muted)}
.rmain{flex:1 1 200px;min-width:0;font-size:14px;overflow-wrap:anywhere}
.rmain b{font-weight:500}
.rside{display:flex;align-items:center;gap:10px;flex-shrink:0}
.rlink{font-size:13px;color:var(--acc-tx);text-decoration:none}
.rlink:hover{text-decoration:underline}
.rempty{padding:16px 12px;color:var(--muted);font-size:14px}
.pback{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.4);z-index:10}
.panel{position:fixed;top:0;right:0;bottom:0;width:min(440px,100%);background:var(--card);border-left:1px solid var(--line);z-index:11;display:flex;flex-direction:column}
.pback[hidden],.panel[hidden]{display:none}
.phead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:16px;border-bottom:1px solid var(--line)}
.ptitle{font-size:18px;font-weight:500;overflow-wrap:anywhere}
.plist{flex:1;overflow-y:auto;padding:12px 16px 24px}
.pitem{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.pitem.click{cursor:pointer}
.pitem.click:hover,.pitem.click:focus-visible{border-color:var(--acc-bd);outline:none}
.pitem .when{font-size:14px;font-weight:500}
.pitem .what{font-size:14px;overflow-wrap:anywhere}
.pitem .meta{font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.badge{display:inline-block;font-size:11px;font-weight:400;padding:0 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin-left:6px;vertical-align:1px}
.badge.up{background:var(--acc-bg);border-color:var(--acc-bd);color:var(--acc-tx)}
.badge.ns{border-color:var(--bad);color:var(--bad)}
.plink{display:inline-block;margin-top:6px;font-size:13px;color:var(--acc-tx);text-decoration:none}
.plink:hover{text-decoration:underline}
.plink[hidden]{display:none}
#pq{flex:1 1 260px;min-width:180px;max-width:420px}
.chk{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.chk input{width:16px;height:16px;min-height:0;padding:0}
.aname{font-size:17px;font-weight:500;overflow-wrap:anywhere}
.sumline{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 26px;margin:12px 0 0;padding:10px 14px;background:var(--card);border:1px solid var(--line);border-radius:10px}
.st b{font-size:22px;font-weight:500}
.st span{margin-left:6px;font-size:13px;color:var(--muted)}
.st.warn b{color:var(--warn)}
.st.bad b{color:var(--bad)}
.chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;min-width:0}
.chead{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:10px}
.chead b{font-size:14px;font-weight:500}
.cempty{color:var(--muted);font-size:13px;padding:24px 0;text-align:center}
.attn{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px;margin:12px 0}
.att{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;min-width:0}
.att.warn{border-color:var(--warn)}
.att .k{font-size:12px;color:var(--muted);margin-bottom:2px}
.att .t{font-size:14px;overflow-wrap:anywhere}
.att .t+.t{margin-top:2px}
.att button{margin-top:8px;min-height:30px;padding:2px 10px;font-size:13px}
.pgrid{border:1px solid var(--line);border-radius:8px;max-height:min(60vh,420px);overflow:auto}
.grow{display:grid;grid-template-columns:minmax(110px,1fr) minmax(150px,1.2fr) minmax(130px,1fr) minmax(250px,2.4fr);gap:6px 16px;padding:10px 14px;border-bottom:1px solid var(--line);align-items:center}
.grow:last-child{border-bottom:0}
.ghead{position:sticky;top:0;z-index:2;padding:8px 14px;font-size:12px;color:var(--muted);background:var(--bg)}
.grow b{font-weight:500}
.stage{font-size:16px;font-weight:500;overflow-wrap:anywhere}
.stline{margin:3px 0}
.stline .badge{margin-left:0}
.badge.ok{border-color:var(--ok);color:var(--ok)}
.badge.warn{border-color:var(--warn);color:var(--warn)}
.tl-track{position:relative;height:36px;margin:0 22px}
.tl-track.axis{height:18px}
.tl-tick{position:absolute;top:2px;transform:translateX(-50%);white-space:nowrap}
.tl-line{position:absolute;left:0;right:0;top:50%;border-top:1px dashed var(--line)}
.tl-today{position:absolute;top:0;bottom:0;border-left:2px solid var(--bad);opacity:.5}
.tl-ends{display:none}
.tdot{position:absolute;top:50%;transform:translate(-50%,-50%);font-size:11px;line-height:1;padding:4px 7px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--muted);white-space:nowrap}
.tdot.done{border-color:var(--ok);color:var(--ok)}
.tdot.upcoming{background:var(--acc-bg);border-color:var(--acc-bd);color:var(--acc-tx)}
.tdot.noshow,.tdot.canceled{border-color:var(--bad);color:var(--bad);text-decoration:line-through}
.tdot.rescheduled{border-color:var(--warn);color:var(--warn);text-decoration:line-through}
.tdot.now{font-weight:600;border-width:2px}
#cPace{margin-top:12px}
.pcols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:4px 28px}
.kv{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}
.kv span{color:var(--muted)}
.kv b{font-weight:500;text-align:right;overflow-wrap:anywhere}
.ksec{font-size:12px;color:var(--muted);margin:2px 0 4px;text-transform:uppercase;letter-spacing:.04em}
.why{font-size:12px;color:var(--muted);margin-top:6px;overflow-wrap:anywhere}
@media (max-width:600px){
.attn{grid-template-columns:1fr}
.ghead{display:none}
.grow{grid-template-columns:1fr}
.grow > div::before{content:attr(data-l);display:block;font-size:11px;color:var(--muted)}
.tl-ends{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin:0 22px}
.sumline{gap:6px 18px}
input{font-size:16px}
.summary{grid-template-columns:1fr 1fr}
.summary .card:last-child{grid-column:1/-1}
.summary .card:last-child .v{white-space:normal}
.wkgrid{grid-template-columns:36px repeat(7,minmax(104px,1fr));min-width:764px}
.wklab{right:4px;font-size:10px}
.rwhen{flex-basis:100%}
.tabs a{padding:0 14px}
}
`;

const PANEL_HTML = String.raw`
<div id="pback" class="pback" hidden></div>
<aside id="panel" class="panel" role="dialog" aria-modal="true" aria-labelledby="ptitle" hidden>
<div class="phead"><div><div id="ptitle" class="ptitle"></div><div id="psub" class="sub"></div><a id="plink" class="plink" href="#" hidden>Analytics &rsaquo;</a></div><button id="pclose" aria-label="Close">&times;</button></div>
<div id="plist" class="plist"></div>
</aside>
`;

const CORE_JS = String.raw`
var state={ready:false,events:[],tz:"UTC",host:"",error:"",lastChecked:0};
var live=false,es=null,lastSeen=0,reqId=0,plinkOn=true;
var merge=true;try{merge=localStorage.getItem("lv_merge")!=="0";}catch(_){}
function mq(){return merge?"&merge=1":"";}
function $(id){return document.getElementById(id);}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e;}
function fmt(o,d){return new Intl.DateTimeFormat("en-US",Object.assign({timeZone:state.tz},o)).format(d);}
function ymd(d){return new Intl.DateTimeFormat("en-CA",{timeZone:state.tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d);}
function mod(d){var h=0,m=0;new Intl.DateTimeFormat("en-GB",{timeZone:state.tz,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d).forEach(function(p){if(p.type==="hour")h=+p.value;if(p.type==="minute")m=+p.value;});return h*60+m;}
function t12(d){return fmt({hour:"numeric",minute:"2-digit",hour12:true},d);}
function addDays(s,n){var d=new Date(s+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
function niceName(n){return n===n.toLowerCase()&&n!==n.toUpperCase()?n.replace(/(^|[\s\-'])(\p{L})/gu,function(m,a,b){return a+b.toUpperCase();}):n;}
function whenText(st,en){
  return fmt({weekday:"short",day:"numeric",month:"short",year:"numeric"},st)+" · "+t12(st)+" – "+t12(en);
}
function card(k,v){var c=el("div","card");c.appendChild(el("div","k",k));c.appendChild(el("div","v",v));return c;}
function showPanel(on){
  $("panel").hidden=!on;$("pback").hidden=!on;
  if(!on)$("plink").hidden=true;
  if(on)$("pclose").focus();
}
function closePanel(){reqId++;showPanel(false);}
function renderPerson(d){
  var list=$("plist");list.textContent="";
  var done=0,up=0,ns=0;
  d.events.forEach(function(x){
    var st=new Date(x.start),en=new Date(x.end);
    var item=el("div","pitem");
    var w=el("div","when",whenText(st,en));
    var label=x.status==="upcoming"?"Upcoming":x.status==="noshow"?"No-show":"Completed";
    w.appendChild(el("span","badge"+(x.status==="upcoming"?" up":x.status==="noshow"?" ns":""),label));
    item.appendChild(w);
    var what=[x.company,x.round].filter(Boolean).join(" · ");
    if(what)item.appendChild(el("div","what",what));
    var meta=[x.name,x.location].filter(Boolean).join(" · ");
    if(meta)item.appendChild(el("div","meta",meta));
    list.appendChild(item);
    if(x.status==="upcoming")up++;else if(x.status==="noshow")ns++;else done++;
  });
  $("ptitle").textContent=niceName(d.name);
  var n=d.events.length;
  $("psub").textContent=n+(n===1?" interview":" interviews")+" · "+done+" completed · "+up+" upcoming"+(ns?" · "+ns+" no-show":"")+(d.emails>1?" · "+d.emails+" email addresses combined":"");
  if(!n)list.appendChild(el("div","sub","No interviews found for this person."));
}
function openPerson(e){
  var my=++reqId;
  $("ptitle").textContent=niceName(e.invitee);
  $("psub").textContent="Loading interviews…";
  $("plist").textContent="";
  showPanel(true);
  var pl=$("plink");if(plinkOn){pl.href="/analytics?event="+encodeURIComponent(e.id);pl.hidden=false;}else pl.hidden=true;
  fetch("/api/person?event="+encodeURIComponent(e.id)+mq())
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(x){
      if(my!==reqId)return;
      if(!x.ok){$("psub").textContent=(x.j&&x.j.error)||"Couldn't load interviews.";return;}
      renderPerson(x.j);
    })
    .catch(function(){if(my===reqId)$("psub").textContent="Couldn't load interviews. Check your connection and try again.";});
}
function paintStatus(){
  var st=$("status"),tx=$("statusText");
  st.className="status"+(live&&!state.error?" live":"");
  if(!live){tx.textContent="Reconnecting…";return;}
  if(!lastSeen){tx.textContent="Live";return;}
  var s=Math.max(0,Math.round((Date.now()-lastSeen)/1000));
  tx.textContent="Live · checked "+(s<60?s+"s":Math.round(s/60)+"m")+" ago";
}
function paintBanner(){
  var msg=state.error||(!state.ready?"Loading bookings…":"");
  var b=$("banner");b.textContent=msg;b.hidden=!msg;
}
function connect(){
  if(es)es.close();
  es=new EventSource("/stream");
  es.onopen=function(){live=true;paintStatus();};
  es.addEventListener("state",function(e){try{state=JSON.parse(e.data);}catch(_){return;}live=true;lastSeen=Date.now();render();});
  es.addEventListener("tick",function(){live=true;lastSeen=Date.now();paintStatus();});
  es.onerror=function(){live=false;paintStatus();if(es.readyState===2)setTimeout(connect,3000);};
}
$("pclose").onclick=closePanel;
$("pback").onclick=closePanel;
document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&!$("panel").hidden)closePanel();});
document.addEventListener("visibilitychange",function(){
  if(document.visibilityState!=="visible")return;
  fetch("/api/state").then(function(r){return r.json();}).then(function(s){state=s;lastSeen=Date.now();render();}).catch(function(){});
  if(!es||es.readyState===2)connect();
});
setInterval(paintStatus,5000);
setInterval(function(){if(state.ready)render();},60000);
`;

const CALENDAR_JS = String.raw`
var qd=new URLSearchParams(location.search).get("date");
var sel=/^\d{4}-\d{2}-\d{2}$/.test(qd||"")?qd:null;
function weekStart(s){var dow=new Date(s+"T12:00:00Z").getUTCDay();return addDays(s,-((dow+6)%7));}
function dayLabel(s){return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"short",day:"numeric",month:"short"}).format(new Date(s+"T12:00:00Z"));}
function shortDay(s){return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"short"}).format(new Date(s+"T12:00:00Z"))+" "+(+s.slice(8));}
function hourLabel(h){h=h%24;return h===0?"12 AM":h<12?h+" AM":h===12?"12 PM":(h-12)+" PM";}
function dur(m){var h=Math.floor(m/60),r=m%60;return h?(r?h+"h "+r+"m":h+"h"):r+"m";}
function dayEvents(s){
  var out=[];
  state.events.forEach(function(e){
    var st=new Date(e.start),en=new Date(e.end);
    if(ymd(st)!==s)return;
    var a=mod(st),d=Math.max(15,Math.round((en-st)/60000));
    out.push({e:e,a:a,b:Math.min(1440,a+d),dur:Math.min(d,1440-a),st:st,en:en});
  });
  out.sort(function(x,y){return x.a-y.a||x.b-y.b;});
  return out;
}
function cluster(list){
  var cur=null;
  list.forEach(function(x){
    if(!cur||x.a>=cur.end){cur={end:x.b,cols:[]};}
    var c=0;while(cur.cols[c]!==undefined&&cur.cols[c]>x.a)c++;
    cur.cols[c]=x.b;x.col=c;x.grp=cur;cur.end=Math.max(cur.end,x.b);
  });
}
function blockedMinutes(list){var b=0,end=-1;list.forEach(function(x){var s=Math.max(x.a,end);if(x.b>s)b+=x.b-s;end=Math.max(end,x.b);});return b;}
function nextUp(){var nowD=new Date();for(var i=0;i<state.events.length;i++){if(new Date(state.events[i].end)>nowD)return state.events[i];}return null;}
function upcomingList(){var nowD=new Date();return state.events.filter(function(e){return new Date(e.end)>nowD;});}
function renderSummary(upCount,blockedText,nextText){
  var box=$("summary");box.textContent="";
  var c=card("Upcoming bookings",String(upCount));
  c.classList.add("click");c.tabIndex=0;c.setAttribute("role","button");c.title="Show all upcoming bookings";
  c.addEventListener("click",openUpcoming);
  c.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();openUpcoming();}});
  box.appendChild(c);
  var b=card("Time booked this week",blockedText);
  b.title="Total length of all interviews in the week shown, past and upcoming. Overlapping meetings count once.";
  box.appendChild(b);
  box.appendChild(card("Next up",nextText));
}
function jumpTo(iso){
  sel=ymd(new Date(iso));render();
  var w=$("weekview");if(w.scrollIntoView)w.scrollIntoView({block:"nearest",behavior:"smooth"});
}
function openUpcoming(){
  reqId++;
  var up=upcomingList(),list=$("plist");
  list.textContent="";
  $("ptitle").textContent="Upcoming bookings";
  $("psub").textContent=up.length+(up.length===1?" booking":" bookings")+" from now on. Click one to see it in the week.";
  up.forEach(function(e){
    var st=new Date(e.start),en=new Date(e.end);
    var item=el("div","pitem click");item.tabIndex=0;item.setAttribute("role","button");
    item.appendChild(el("div","when",whenText(st,en)));
    item.appendChild(el("div","what",niceName(e.invitee)));
    var d=[e.company,e.round].filter(Boolean).join(" · ");if(d)item.appendChild(el("div","meta",d));
    function go(){closePanel();jumpTo(e.start);}
    item.addEventListener("click",go);
    item.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();go();}});
    list.appendChild(item);
  });
  if(!up.length)list.appendChild(el("div","sub","No upcoming bookings."));
  showPanel(true);
  $("plink").hidden=true;
}
function renderWeek(today){
  var mon=weekStart(sel),days=[],per=[],i;
  for(i=0;i<7;i++){days.push(addDays(mon,i));per.push(dayEvents(days[i]));}
  var nowD=new Date(),H=100,total=0,blocked=0,lo=1440,hi=0;
  per.forEach(function(l){total+=l.length;blocked+=blockedMinutes(l);l.forEach(function(x){lo=Math.min(lo,x.a);hi=Math.max(hi,x.b);});});
  var s=9,e=18;
  if(total){s=Math.max(0,Math.floor(lo/60)-1);e=Math.min(24,Math.ceil(hi/60)+1);if(e-s<8){e=Math.min(24,s+8);s=Math.max(0,e-8);}}
  var nu=nextUp(),nt="None";
  if(nu){var nst=new Date(nu.start);nt=fmt({weekday:"short"},nst)+" "+t12(nst)+" "+niceName(nu.invitee.split(",")[0]);}
  renderSummary(upcomingList().length,total?dur(blocked):"None",nt);
  var box=$("weekview");
  var old=box.querySelector(".wkwrap"),keep=old?old.scrollLeft:null;
  box.textContent="";
  var wrap=el("div","wkwrap"),grid=el("div","wkgrid");
  grid.appendChild(el("div","wkcorner"));
  days.forEach(function(d,idx){
    var h=el("div","wkhead"+(d===today?" today":""));
    h.appendChild(el("span",null,shortDay(d)));
    h.appendChild(el("span","wkcount",per[idx].length?per[idx].length+" booked":"Free"));
    grid.appendChild(h);
  });
  var axis=el("div","wkaxis");axis.style.height=((e-s)*H)+"px";
  for(var hh=s;hh<=e;hh++){var lab=el("span","wklab",hourLabel(hh));lab.style.top=((hh-s)*H)+"px";if(hh===s)lab.style.transform="none";axis.appendChild(lab);}
  grid.appendChild(axis);
  days.forEach(function(d,idx){
    var col=el("div","wkcol");col.style.height=((e-s)*H)+"px";
    var list=per[idx];cluster(list);
    list.forEach(function(x){
      var n=x.grp.cols.length,b=el("div","wkev"+(x.en<nowD?" past":""));
      var bh=Math.max(22,(x.dur/60*H)-2);
      b.style.top=(((x.a-s*60)/60*H)+1)+"px";
      b.style.height=bh+"px";
      b.style.left="calc("+(x.col*100/n)+"% + 2px)";
      b.style.width="calc("+(100/n)+"% - 4px)";
      var nn=niceName(x.e.invitee);
      b.title=[nn,x.e.company,x.e.round].filter(Boolean).join(" · ");
      b.tabIndex=0;b.setAttribute("role","button");
      if(bh>=80)b.classList.add("roomy");
      b.appendChild(el("b",null,nn));
      if(x.e.company)b.appendChild(el("span","wkco",x.e.company));
      if(x.e.round)b.appendChild(el("span","wkco",x.e.round));
      b.addEventListener("click",function(){openPerson(x.e);});
      b.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();openPerson(x.e);}});
      col.appendChild(b);
    });
    if(d===today){var nm=mod(nowD);if(nm>=s*60&&nm<=e*60){var nl=el("div","wknow");nl.style.top=((nm-s*60)/60*H)+"px";col.appendChild(nl);}}
    grid.appendChild(col);
  });
  wrap.appendChild(grid);box.appendChild(wrap);
  var hint=el("div","sub hint","Click a person to see all their interviews.");
  box.appendChild(hint);
  var over=wrap.scrollWidth>wrap.clientWidth;
  if(over)hint.textContent="Swipe sideways to see other days. Tap a person to see all their interviews.";
  if(keep!==null)wrap.scrollLeft=keep;
  else if(over){var th=grid.querySelector(".wkhead.today");if(th)wrap.scrollLeft=Math.max(0,th.getBoundingClientRect().left-grid.getBoundingClientRect().left-wrap.querySelector(".wkcorner").offsetWidth);}
}
function render(){
  if(!sel)sel=ymd(new Date());
  var today=ymd(new Date());
  var mon=weekStart(sel);
  $("title").textContent=dayLabel(mon)+" – "+dayLabel(addDays(mon,6));
  $("pick").value=sel;
  paintBanner();
  renderWeek(today);
  paintStatus();
}
function step(n){if(!sel)sel=ymd(new Date());sel=addDays(sel,n*7);render();}
$("prev").onclick=function(){step(-1);};
$("next").onclick=function(){step(1);};
$("today").onclick=function(){sel=ymd(new Date());render();};
$("pick").onchange=function(){if(this.value){sel=this.value;render();}};
connect();
`;

const SEARCH_JS = String.raw`
var query="",filter="all";
function words(){return query.toLowerCase().split(/\s+/).filter(Boolean);}
function matches(e,ws){
  var h=(e.invitee+" "+niceName(e.invitee)+" "+e.company+" "+e.round).toLowerCase();
  for(var i=0;i<ws.length;i++){if(h.indexOf(ws[i])<0)return false;}
  return true;
}
function render(){
  paintBanner();
  var ws=words(),nowD=new Date();
  $("fAll").className=filter==="all"?"on":"";
  $("fUp").className=filter==="up"?"on":"";
  $("fPast").className=filter==="past"?"on":"";
  var box=$("results");box.textContent="";
  if(!ws.length){
    $("rcount").textContent="";
    box.appendChild(el("div","rempty","Type a name, company or round to search bookings."));
    paintStatus();
    return;
  }
  var hits=state.events.filter(function(e){return matches(e,ws);});
  var up=hits.filter(function(e){return new Date(e.end)>nowD;});
  var past=hits.filter(function(e){return new Date(e.end)<=nowD;}).reverse();
  var shown=filter==="up"?up:filter==="past"?past:up.concat(past);
  var n=shown.length;
  $("rcount").textContent=n+(n===1?" booking":" bookings")+" match"+(filter==="all"?" · "+up.length+" upcoming":"");
  if(!n){
    box.appendChild(el("div","rempty",state.ready?"No bookings match your search.":"Loading bookings…"));
    paintStatus();
    return;
  }
  shown.slice(0,300).forEach(function(e){
    var st=new Date(e.start),isPast=new Date(e.end)<=nowD;
    var row=el("div","rrow"+(isPast?" past":""));
    row.tabIndex=0;row.setAttribute("role","button");
    row.appendChild(el("div","rwhen",fmt({weekday:"short",day:"numeric",month:"short",year:"numeric"},st)+" · "+t12(st)));
    var m=el("div","rmain");m.appendChild(el("b",null,niceName(e.invitee)));
    var d=[e.company,e.round].filter(Boolean).join(" · ");if(d)m.appendChild(el("div","sub",d));
    row.appendChild(m);
    var side=el("div","rside");
    side.appendChild(el("span","badge"+(isPast?"":" up"),isPast?"Past":"Upcoming"));
    var a=el("a","rlink","Calendar ›");a.href="/?date="+ymd(st);
    a.addEventListener("click",function(ev){ev.stopPropagation();});
    side.appendChild(a);
    row.appendChild(side);
    row.addEventListener("click",function(){openPerson(e);});
    row.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();openPerson(e);}});
    box.appendChild(row);
  });
  paintStatus();
}
$("q").addEventListener("input",function(){query=this.value;render();});
$("q").addEventListener("keydown",function(ev){if(ev.key==="Escape"&&this.value){this.value="";query="";render();}});
$("fAll").onclick=function(){filter="all";render();};
$("fUp").onclick=function(){filter="up";render();};
$("fPast").onclick=function(){filter="past";render();};
render();
connect();
`;

function shell(active: "calendar" | "search" | "analytics", body: string, js: string): string {
  const title = active === "calendar" ? "Calendly live view" : active === "search" ? "Search bookings" : "Person analytics";
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>' +
    title +
    '</title><link rel="icon" href="data:,"><style nonce="__NONCE__">' +
    BASE_CSS +
    APP_CSS +
    '</style></head><body><div class="row"><nav class="tabs"><a href="/"' +
    (active === "calendar" ? ' class="on"' : "") +
    '>Calendar</a><a href="/search"' +
    (active === "search" ? ' class="on"' : "") +
    '>Search</a><a href="/analytics"' +
    (active === "analytics" ? ' class="on"' : "") +
    '>Analytics</a></nav><div id="status" class="status"><span class="dot"></span><span id="statusText">Connecting…</span></div></div>' +
    body +
    PANEL_HTML +
    '<script nonce="__NONCE__">(function(){' +
    CORE_JS +
    js +
    "})();</script></body></html>"
  );
}

const CALENDAR_HTML = shell(
  "calendar",
  '<h1 id="title">Loading…</h1>' +
    '<div class="row nav"><button id="prev" aria-label="Previous week">&lsaquo;</button><button id="today">Today</button><button id="next" aria-label="Next week">&rsaquo;</button><input type="date" id="pick" aria-label="Pick a date"></div>' +
    '<div id="banner" class="banner" hidden></div>' +
    '<section id="summary" class="summary"></section>' +
    '<section id="weekview"></section>',
  CALENDAR_JS,
);

const SEARCH_HTML = shell(
  "search",
  '<h1 id="title">Search bookings</h1>' +
    '<div class="row nav"><input type="search" id="q" placeholder="Search name, company or round" aria-label="Search bookings" autocomplete="off" autofocus>' +
    '<div class="seg"><button id="fAll">All</button><button id="fUp">Upcoming</button><button id="fPast">Past</button></div></div>' +
    '<div id="banner" class="banner" hidden></div>' +
    '<div id="rcount" class="sub"></div>' +
    '<section id="results" class="results"></section>' +
    '<div class="sub hint">Search covers the last 6 weeks and the next 60 days. Click a booking to see that person\'s full interview history.</div>',
  SEARCH_JS,
);


const ANALYTICS_JS = String.raw`
plinkOn=false;
var people=[],chosen=null,data=null,pickerOpen=true,loadId=0,peopleKey="",shownTz="",joined={};
var DAY=864e5,QUIET=10;
var WORDS={first:1,second:2,third:3,fourth:4,fifth:5,sixth:6};
var STATE_LABEL={upcoming:"Upcoming",done:"Completed",noshow:"No-show",canceled:"Canceled",rescheduled:"Rescheduled"};
var STATE_BADGE={upcoming:"up",done:"ok",noshow:"ns",canceled:"ns",rescheduled:"warn"};
var SUFFIX={pvt:1,ltd:1,private:1,limited:1,inc:1,llp:1,corp:1,corporation:1,co:1,company:1,technologies:1,technology:1,solutions:1,services:1,india:1,global:1,group:1,systems:1,software:1,labs:1};
function words(s){return s.toLowerCase().split(/\s+/).filter(Boolean);}
function dayNum(s){return Date.parse(s+"T00:00:00Z")/DAY;}
function chosenName(){return chosen&&chosen.name?niceName(chosen.name):"";}
function loadPeople(){
  fetch("/api/people"+(merge?"?merge=1":"")).then(function(r){return r.json();}).then(function(j){people=Array.isArray(j)?j:[];renderPeople();}).catch(function(){});
}
function renderPeople(){
  var box=$("plistbox");box.textContent="";
  var v=$("pq").value.trim(),ws=words(v===chosenName()?"":v);
  if(!pickerOpen||!ws.length){box.hidden=true;return;}
  var list=people.filter(function(p){var h=(p.name+" "+niceName(p.name)+" "+(p.company||"")).toLowerCase();for(var i=0;i<ws.length;i++){if(h.indexOf(ws[i])<0)return false;}return true;});
  box.hidden=false;
  if(!list.length){box.appendChild(el("div","rempty",people.length?"No one matches.":"No people yet. They appear once their bookings have loaded."));return;}
  list.slice(0,60).forEach(function(p){
    var row=el("div","rrow");row.tabIndex=0;row.setAttribute("role","button");
    var m=el("div","rmain");m.appendChild(el("b",null,niceName(p.name)));
    if(p.company)m.appendChild(el("div","sub",p.company));
    row.appendChild(m);
    var last=p.last?fmt({day:"numeric",month:"short",year:"numeric"},new Date(p.last)):"";
    row.appendChild(el("span","sub",p.count+(p.count===1?" booking":" bookings")+(last?" · last "+last:"")+(p.emails>1?" · "+p.emails+" emails":"")));
    function go(){choose(p);}
    row.addEventListener("mousedown",function(ev){ev.preventDefault();});
    row.addEventListener("click",go);
    row.addEventListener("keydown",function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();go();}});
    box.appendChild(row);
  });
}
function choose(p){
  chosen=p;pickerOpen=false;
  $("pq").value=chosenName();$("pq").blur();
  renderPeople();load(p.event);
}
function chartBox(id,title,label){
  var b=$(id);b.textContent="";
  var h=el("div","chead");h.appendChild(el("b",null,title));
  if(label)h.appendChild(el("span","sub",label));
  b.appendChild(h);return b;
}
function clearAll(){["sumline","attn","cProg","cPace"].forEach(function(id){$(id).textContent="";});}
function load(eventId){
  var my=++loadId;data=null;joined={};
  $("empty").hidden=true;$("an").hidden=false;
  clearAll();$("hist").hidden=true;
  $("aname").textContent=chosenName();
  $("asub").textContent="Loading analytics…";
  fetch("/api/analytics?event="+encodeURIComponent(eventId)+mq())
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(x){
      if(my!==loadId)return;
      if(!x.ok){$("asub").textContent=(x.j&&x.j.error)||"Couldn't load analytics.";return;}
      data=x.j;
      if(!chosen)chosen={name:data.name,event:eventId};
      else if(!chosen.name)chosen.name=data.name;
      if(document.activeElement!==$("pq"))$("pq").value=chosenName();
      renderAnalytics();
    })
    .catch(function(){if(my===loadId)$("asub").textContent="Couldn't load analytics. Check your connection and try again.";});
}
function stats(evs,now){
  var s={held:[],noshow:0,resched:0,canceled:0};
  evs.forEach(function(e){
    if(e.status==="canceled"){if(e.rescheduled)s.resched++;else s.canceled++;return;}
    if(Date.parse(e.end)<=now){if(e.noShow)s.noshow++;else s.held.push(e);}
  });
  return s;
}
function roundKey(r){return String(r||"").trim().toLowerCase().replace(/\s+/g," ");}
function roundRank(r){
  var s=roundKey(r);if(!s)return null;
  if(/final|last|offer/.test(s))return 90;
  var m=s.match(/\d+/);if(m)return +m[0];
  for(var w in WORDS){if(s.indexOf(w)>=0)return WORDS[w];}
  if(/screen|phone|intro/.test(s))return 0;
  return null;
}
function ordinal(k){var v=k%100;return k+((v>=11&&v<=13)?"th":k%10===1?"st":k%10===2?"nd":k%10===3?"rd":"th");}
function roundShort(r){
  var k=roundRank(r);
  if(k===90)return "Final";
  if(k===0)return "Screen";
  if(k!==null)return ordinal(k);
  return String(r||"").trim().slice(0,10)||"Interview";
}
function evState(e,now){
  if(e.status==="canceled")return e.rescheduled?"rescheduled":"canceled";
  if(Date.parse(e.end)>now)return "upcoming";
  return e.noShow?"noshow":"done";
}
function relDay(t,now){var d=dayNum(ymd(new Date(t)))-dayNum(ymd(new Date(now)));return d<=0?"Today":d===1?"Tomorrow":"In "+d+" days";}
function canon(k){var n=0;while(joined[k]&&n++<10)k=joined[k];return k;}
function osa(a,b){
  var m=a.length,n=b.length,d=[],i,j;
  for(i=0;i<=m;i++)d[i]=[i];
  for(j=1;j<=n;j++)d[0][j]=j;
  for(i=1;i<=m;i++)for(j=1;j<=n;j++){
    var c=a[i-1]===b[j-1]?0:1;
    d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+c);
    if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])d[i][j]=Math.min(d[i][j],d[i-2][j-2]+1);
  }
  return d[m][n];
}
function simKey(s){return s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(" ").filter(function(w){return w&&!SUFFIX[w];}).join(" ");}
function similar(a,b){
  var sa=simKey(a),sb=simKey(b);
  if(!sa||!sb)return false;
  if(sa===sb)return true;
  var ja=sa.replace(/ /g,""),jb=sb.replace(/ /g,"");
  if(ja===jb)return true;
  var mn=Math.min(ja.length,jb.length),mx=Math.max(ja.length,jb.length);
  if(mn>=4&&osa(ja,jb)<=(mx<=7?1:2))return true;
  var ta=sa.split(" "),tb=sb.split(" "),sh=ta.length<=tb.length?ta:tb,lg=sh===ta?tb:ta;
  if(sh.join("").length>=4&&sh.length<lg.length){for(var i=0;i<sh.length;i++){if(lg[i]!==sh[i])return false;}return true;}
  return false;
}
function dupes(rows){
  var out=[];
  for(var i=0;i<rows.length;i++)for(var j=i+1;j<rows.length;j++){
    if(rows[i].key&&rows[j].key&&similar(rows[i].key,rows[j].key))out.push({a:rows[i].key,b:rows[j].key,an:rows[i].name,bn:rows[j].name});
  }
  return out;
}
function progress(evs){
  var now=Date.now(),groups={},keys=[];
  evs.forEach(function(e){
    var raw=String(e.company||"").trim(),k=canon(raw.toLowerCase());
    if(!groups[k]){groups[k]={names:{},evs:[]};keys.push(k);}
    var g=groups[k];g.evs.push(e);g.names[raw]=(g.names[raw]||0)+1;
  });
  var gaps=[];
  keys.forEach(function(k){
    var s=groups[k].evs.filter(function(e){return e.status!=="canceled";}).map(function(e){return Date.parse(e.start);}).sort(function(a,b){return a-b;});
    for(var i=1;i<s.length;i++)gaps.push((s[i]-s[i-1])/DAY);
  });
  var T=QUIET,personal=false;
  if(gaps.length>=3){
    var sg=gaps.slice().sort(function(a,b){return a-b;}),m=sg.length,med=m%2?sg[(m-1)/2]:(sg[m/2-1]+sg[m/2])/2;
    T=Math.min(21,Math.max(5,Math.ceil(med*1.5)));personal=true;
  }
  var rows=keys.map(function(k){
    var g=groups[k],act=[],drop=[],moved=[];
    g.evs.forEach(function(e){if(e.status!=="canceled")act.push(e);else if(e.rescheduled)moved.push(e);else drop.push(e);});
    var pool=act.length?act:(drop.length?drop:moved);
    var ranked=pool.every(function(e){return roundRank(e.round)!==null;});
    var sorted=pool.slice().sort(function(a,b){
      if(ranked){var d=roundRank(a.round)-roundRank(b.round);if(d)return d;}
      return Date.parse(a.start)-Date.parse(b.start);
    });
    var cur=sorted[sorted.length-1];
    var note="";
    if(act.length){
      var later=drop.filter(function(e){
        var rk=roundRank(e.round),ck=roundRank(cur.round);
        return Date.parse(e.start)>Date.parse(cur.start)||(ranked&&rk!==null&&ck!==null&&rk>ck);
      }).sort(function(a,b){return Date.parse(b.start)-Date.parse(a.start);});
      if(later.length)note=(later[0].round||"An interview")+" was canceled";
    }
    var allStarts=(act.length?act:g.evs).map(function(e){return Date.parse(e.start);});
    var name="",best=0;
    Object.keys(g.names).forEach(function(n){if(g.names[n]>best||(g.names[n]===best&&n.toLowerCase()===k)){best=g.names[n];name=n;}});
    var upc=act.filter(function(e){return Date.parse(e.end)>now;}).sort(function(a,b){return Date.parse(a.start)-Date.parse(b.start);});
    var heldA=act.filter(function(e){return Date.parse(e.end)<=now;}).sort(function(a,b){return Date.parse(b.end)-Date.parse(a.end);});
    var lastEnd=heldA.length?Date.parse(heldA[0].end):0;
    var since=lastEnd?Math.floor((now-lastEnd)/DAY):0,rank=roundRank(cur.round),status,text,nextStart=null,whenIso,whenLabel;
    if(upc.length){status="booked";nextStart=Date.parse(upc[0].start);text=relDay(nextStart,now);whenIso=upc[0].start;whenLabel="Next";}
    else{
      if(heldA.length){whenIso=heldA[0].start;whenLabel="Last";}else{whenIso=cur.start;whenLabel="Was booked for";}
      if(!act.length){status=evState(cur,now);text=status==="rescheduled"?"Rescheduled, new time not booked":"Not rebooked";}
      else if(evState(cur,now)==="noshow"){status="noshow";text="Marked as no-show";}
      else if(since>=T){status="quiet";text="No news for "+since+" days";}
      else{status="waiting";text=(rank===90?"Waiting for a result":"Waiting for the next round")+(since<1?" (interview was today)":" ("+since+(since===1?" day":" days")+" since the interview)");}
    }
    return {key:k,name:name?niceName(name):"Company not given",stage:cur.round||"Interview",state:evState(cur,now),
      whenIso:whenIso,whenLabel:whenLabel,curStart:cur.start,count:act.length,note:note,last:Math.max.apply(null,allStarts),
      events:g.evs,status:status,statusText:text,nextStart:nextStart,since:since,rank:rank};
  });
  rows.sort(function(a,b){
    var au=a.status==="booked",bu=b.status==="booked";
    if(au!==bu)return au?-1:1;
    if(au&&bu)return a.nextStart-b.nextStart;
    return b.last-a.last;
  });
  return {rows:rows,gaps:gaps,T:T,personal:personal};
}
function drawSum(evs,rows,cur,now){
  var box=$("sumline");box.textContent="";
  function st(n,label,cls){var s=el("div","st"+(cls?" "+cls:""));s.appendChild(el("b",null,String(n)));s.appendChild(el("span",null,label));box.appendChild(s);}
  var up=evs.filter(function(e){return e.status==="active"&&Date.parse(e.end)>now;}).length;
  st(cur.held.length,cur.held.length===1?"interview done":"interviews done");
  st(up,"upcoming");
  st(rows.length,rows.length===1?"company":"companies");
  if(cur.resched)st(cur.resched,"rescheduled","warn");
  if(cur.canceled)st(cur.canceled,"canceled","bad");
  if(cur.noshow)st(cur.noshow,cur.noshow===1?"no-show":"no-shows","bad");
}
function drawAttn(rows,evs,now,pr){
  var box=$("attn");box.textContent="";
  var n=0;
  function add(k,lines,cls){
    var c=el("div","att"+(cls?" "+cls:""));c.appendChild(el("div","k",k));
    lines.forEach(function(t){c.appendChild(el("div","t",t));});
    box.appendChild(c);n++;return c;
  }
  function some(rs,f){var out=rs.slice(0,4).map(f);if(rs.length>4)out.push("and "+(rs.length-4)+" more");return out;}
  function ago(r){return r.since<1?"today":r.since+(r.since===1?" day ago":" days ago");}
  var upc=evs.filter(function(e){return e.status==="active"&&Date.parse(e.end)>now;}).sort(function(a,b){return Date.parse(a.start)-Date.parse(b.start);});
  if(upc.length){
    var e=upc[0],d=new Date(e.start);
    add("Next interview",[[e.company||"Company not given",e.round].filter(Boolean).join(" · "),fmt({weekday:"short",day:"numeric",month:"short"},d)+" · "+t12(d)+" · "+relDay(e.start,now)]);
  }
  var waiting=rows.filter(function(r){return r.status==="waiting"&&r.rank!==90;});
  if(waiting.length)add("Waiting for the next round",some(waiting,function(r){return r.name+" ("+r.stage+", "+ago(r)+")";}));
  var result=rows.filter(function(r){return r.status==="waiting"&&r.rank===90;});
  if(result.length)add("Waiting for a result",some(result,function(r){return r.name+" ("+r.stage+", "+ago(r)+")";}));
  var quiet=rows.filter(function(r){return r.status==="quiet";});
  if(quiet.length)add(pr.personal?"Longer than usual ("+pr.T+"+ days)":"No news for "+pr.T+"+ days",some(quiet,function(r){return r.name+" ("+r.stage+", "+r.since+" days)";}));
  var look=rows.filter(function(r){return r.status==="canceled"||r.status==="rescheduled"||r.status==="noshow";});
  if(look.length)add("Needs a look",some(look,function(r){return r.name+": "+r.stage+(r.status==="noshow"?" no-show":r.status==="rescheduled"?" was rescheduled, new time not booked":" was canceled and not rebooked");}),"warn");
  dupes(rows).slice(0,3).forEach(function(p){
    var c=add("Possible duplicate company",[p.an+" and "+p.bn+" look like the same company."],"warn");
    var b=el("button",null,"Combine in this view");
    b.title="Only for this page view. It is not saved.";
    b.addEventListener("click",function(){joined[p.b]=p.a;renderAnalytics();});
    c.appendChild(b);
  });
  if(!n)add("All clear",["Nothing needs attention right now."]);
}
function drawProgress(rows,now){
  var box=chartBox("cProg","Progress by company","Furthest round reached at each company");
  if(!rows.length){box.appendChild(el("div","cempty","No bookings yet."));return;}
  var all=[];
  rows.forEach(function(r){r.events.forEach(function(e){all.push(Date.parse(e.start));});});
  var sd=dayNum(ymd(new Date(Math.min.apply(null,all)))),ed=Math.max(dayNum(ymd(new Date(Math.max.apply(null,all)))),dayNum(ymd(new Date(now)))),span=ed-sd+1;
  function pos(t){var d=new Date(t);return (dayNum(ymd(d))-sd+mod(d)/1440)/span*100;}
  function lab(k){return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"short",day:"numeric"}).format(new Date((sd+k)*DAY+43200000));}
  var grid=el("div","pgrid");
  var h=el("div","grow ghead");
  ["Company","Current stage","Next / last"].forEach(function(t){h.appendChild(el("div",null,t));});
  var hj=el("div"),ax=el("div","tl-track axis"),nt=Math.min(span,6),i;
  for(i=0;i<nt;i++){
    var dk=nt===1?0:Math.round(i*(span-1)/(nt-1)),tk=el("span","tl-tick",lab(dk));
    tk.style.left=((dk+0.5)/span*100)+"%";ax.appendChild(tk);
  }
  hj.appendChild(ax);h.appendChild(hj);grid.appendChild(h);
  rows.forEach(function(r){
    var row=el("div","grow");
    var c1=el("div");c1.setAttribute("data-l","Company");
    c1.appendChild(el("b",null,r.name));
    c1.appendChild(el("div","sub",r.count+(r.count===1?" interview":" interviews")));
    var c2=el("div");c2.setAttribute("data-l","Current stage");
    c2.appendChild(el("div","stage",r.stage));
    var sl=el("div","stline");sl.appendChild(el("span","badge "+STATE_BADGE[r.state],STATE_LABEL[r.state]));c2.appendChild(sl);
    c2.appendChild(el("div","sub",r.statusText));
    if(r.note)c2.appendChild(el("div","sub",r.note));
    var c3=el("div");c3.setAttribute("data-l","Next / last");
    var wd=new Date(r.whenIso);
    c3.appendChild(el("div","sub",r.whenLabel));
    c3.appendChild(el("div",null,fmt({weekday:"short",day:"numeric",month:"short",year:"numeric"},wd)));
    c3.appendChild(el("div","sub",t12(wd)));
    var c4=el("div");c4.setAttribute("data-l","Journey");
    var evl=r.events.slice().sort(function(a,b){return Date.parse(a.start)-Date.parse(b.start);}).map(function(e){return {e:e,p:pos(Date.parse(e.start))};});
    var last=[-1e9,-1e9,-1e9],nl=1;
    evl.forEach(function(x){
      var l=-1,m=0,j;
      for(j=0;j<3;j++){if(x.p-last[j]>=12){l=j;break;}if(last[j]<last[m])m=j;}
      if(l<0)l=m;
      x.lane=l;last[l]=x.p;if(l+1>nl)nl=l+1;
    });
    var tr=el("div","tl-track");tr.style.height=(nl===1?36:nl===2?58:80)+"px";
    tr.appendChild(el("div","tl-line"));
    var td=el("div","tl-today");td.style.left=pos(now)+"%";tr.appendChild(td);
    evl.forEach(function(x){
      var e=x.e,st=evState(e,now),d=new Date(e.start);
      var dot=el("span","tdot "+st+(e.start===r.curStart?" now":""),roundShort(e.round));
      dot.style.left=x.p+"%";dot.style.top=((x.lane+0.5)/nl*100)+"%";
      dot.title=r.name+" · "+(e.round||"Interview")+" · "+fmt({weekday:"short",day:"numeric",month:"short",year:"numeric"},d)+" · "+t12(d)+" · "+STATE_LABEL[st];
      tr.appendChild(dot);
    });
    c4.appendChild(tr);
    var en=el("div","tl-ends");en.appendChild(el("span",null,lab(0)));en.appendChild(el("span",null,lab(span-1)));c4.appendChild(en);
    row.appendChild(c1);row.appendChild(c2);row.appendChild(c3);row.appendChild(c4);
    grid.appendChild(row);
  });
  box.appendChild(grid);
  box.appendChild(el("div","why","Journey: one dot per interview. Green completed, blue upcoming, amber rescheduled, red canceled or no-show. The red line is today and the bold dot is the current stage."));
  if(grid.scrollHeight>grid.clientHeight){var sb=box.querySelector(".chead .sub");if(sb)sb.textContent=rows.length+" companies · scroll to see all";}
}
function drawPace(evs,rows,cur,pr){
  var box=chartBox("cPace","Pace and cancellations","");
  var cols=el("div","pcols"),a=el("div"),b=el("div");
  function kv(p,k,v){var r=el("div","kv");r.appendChild(el("span",null,k));r.appendChild(el("b",null,v));p.appendChild(r);}
  function sec(p,t){p.appendChild(el("div","ksec",t));}
  function note(p,t){p.appendChild(el("div","why",t));}
  function d(x){var v=Math.round(x);return v+(v===1?" day":" days");}
  sec(a,"Pace");
  var g=pr.gaps.slice().sort(function(x,y){return x-y;}),m=g.length;
  if(!m)kv(a,"Between rounds","Not enough data yet");
  else if(m===1)kv(a,"Between rounds",d(g[0])+" (one example)");
  else{var med=m%2?g[(m-1)/2]:(g[m/2-1]+g[m/2])/2;kv(a,"Between rounds","usually "+d(med)+" ("+Math.round(g[0])+" to "+Math.round(g[m-1])+")");}
  kv(a,"Flagged as quiet after",pr.T+" days");
  note(a,pr.personal?"Based on this candidate's usual wait between rounds.":"Default value. There is not enough history yet to use this candidate's own pattern.");
  var can=evs.filter(function(e){return e.status==="canceled";});
  var has=cur.resched||cur.canceled||cur.noshow;
  if(has){
    sec(b,"Cancellations and no-shows");
    if(cur.resched)kv(b,"Rescheduled",String(cur.resched));
    if(cur.canceled)kv(b,"Canceled",String(cur.canceled));
    if(cur.noshow)kv(b,"No-shows",String(cur.noshow));
    var byC=can.filter(function(e){return e.canceledBy==="invitee";}).length,byH=can.filter(function(e){return e.canceledBy==="host";}).length;
    if(byC+byH>0)kv(b,"Canceled by","Candidate "+byC+" · You "+byH);
    var why=can.filter(function(e){return e.cancelReason;}).sort(function(x,y){return Date.parse(y.start)-Date.parse(x.start);}).slice(0,4);
    why.forEach(function(e){note(b,fmt({day:"numeric",month:"short"},new Date(e.start))+" · "+(e.company||"Company not given")+" · "+(e.rescheduled?"rescheduled":"canceled")+": "+e.cancelReason);});
    if(can.length&&!why.length)note(b,"No cancellation reasons were given.");
  }else note(a,"No cancellations, reschedules or no-shows.");
  cols.appendChild(a);if(has)cols.appendChild(b);
  box.appendChild(cols);
}
function renderAnalytics(){
  if(!data)return;
  var evs=data.events,now=Date.now(),cur=stats(evs,now),pr=progress(evs),rows=pr.rows;
  $("aname").textContent=niceName(data.name);
  $("asub").textContent=data.emails>1?"Combined from "+data.emails+" email addresses":"";
  $("hist").hidden=false;
  drawSum(evs,rows,cur,now);
  drawAttn(rows,evs,now,pr);
  drawProgress(rows,now);
  drawPace(evs,rows,cur,pr);
  shownTz=state.tz;
}
function render(){
  paintBanner();paintStatus();
  if(data&&shownTz!==state.tz)renderAnalytics();
  renderPeople();
  var k=state.events.length+":"+state.events.map(function(e){return e.invitee;}).join("|");
  if(state.ready&&k!==peopleKey){peopleKey=k;loadPeople();}
}
$("pq").addEventListener("focus",function(){pickerOpen=true;this.select();renderPeople();});
$("pq").addEventListener("input",function(){pickerOpen=true;renderPeople();});
$("pq").addEventListener("blur",function(){setTimeout(function(){pickerOpen=false;renderPeople();},200);});
$("pq").addEventListener("keydown",function(ev){if(ev.key==="Escape"){pickerOpen=false;renderPeople();}});
$("hist").onclick=function(){if(chosen)openPerson({id:chosen.event,invitee:data?data.name:chosen.name});};
$("mg").checked=merge;
$("mg").addEventListener("change",function(){
  merge=this.checked;
  try{localStorage.setItem("lv_merge",merge?"1":"0");}catch(_){}
  loadPeople();
  if(chosen)load(chosen.event);
});
var ev0=new URLSearchParams(location.search).get("event");
if(ev0&&/^[0-9a-f-]{36}$/i.test(ev0)){chosen={name:"",event:ev0};pickerOpen=false;load(ev0);}
loadPeople();
connect();
`;

const ANALYTICS_HTML = shell(
  "analytics",
  '<h1 id="title">Person analytics</h1>' +
    '<div class="row nav"><input type="search" id="pq" placeholder="Type a name to choose a person" autocomplete="off" aria-label="Choose a person">' +
    '<label class="chk"><input type="checkbox" id="mg"> Combine people with the same name, even if they used different email addresses</label></div>' +
    '<div id="banner" class="banner" hidden></div>' +
    '<section id="plistbox" class="results" hidden></section>' +
    '<div id="empty" class="sub hint">Type a name above to pick a person and see their analytics. There is no overall view, only one person at a time.</div>' +
    '<section id="an" hidden>' +
    '<div class="row"><div><div id="aname" class="aname"></div><div id="asub" class="sub"></div></div><button id="hist" hidden>Interview list</button></div>' +
    '<section id="sumline" class="sumline"></section>' +
    '<section id="attn" class="attn"></section>' +
    '<section class="chart" id="cProg"></section>' +
    '<section class="chart" id="cPace"></section>' +
    "</section>",
  ANALYTICS_JS,
);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 30,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    if (path === "/healthz") return new Response("ok", { headers: SEC });

    if (configError) {
      return page(
        (n) =>
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Setup needed</title><style nonce="' + n + '">' +
          BASE_CSS + "</style></head><body><h1>Setup needed</h1><p>" + configError +
          ". Add it in the Railway service variables and the service will restart on its own.</p></body></html>",
        503,
      );
    }

    if (path === "/" && req.method === "GET") return page((n) => CALENDAR_HTML.replaceAll("__NONCE__", n));
    if (path === "/search" && req.method === "GET") return page((n) => SEARCH_HTML.replaceAll("__NONCE__", n));

    if (path === "/analytics" && req.method === "GET") return page((n) => ANALYTICS_HTML.replaceAll("__NONCE__", n));

    if (path === "/api/state") return json(state);

    const merge = url.searchParams.get("merge") === "1";

    if (path === "/api/people") return json(people(merge));

    if (path === "/api/analytics") {
      const id = url.searchParams.get("event") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bad request." }, 400);
      try {
        return json(await analyticsFor(id, merge));
      } catch (err) {
        if (err instanceof CalError) {
          if (err.status === 429) return json({ error: "Calendly is rate limiting requests. Try again in a minute." }, 429);
          if (err.status === 404) return json({ error: "This booking has no email, so analytics can't be built." }, 404);
          if (err.status === 401 || err.status === 403) return json({ error: "Calendly rejected the access token." }, 502);
        }
        return json({ error: "Couldn't load analytics from Calendly." }, 502);
      }
    }

    if (path === "/api/person") {
      const id = url.searchParams.get("event") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "Bad request." }, 400);
      try {
        return json(await personHistory(id, merge));
      } catch (err) {
        if (err instanceof CalError) {
          if (err.status === 429) return json({ error: "Calendly is rate limiting requests. Try again in a minute." }, 429);
          if (err.status === 404) return json({ error: "This booking has no email, so other interviews can't be looked up." }, 404);
          if (err.status === 401 || err.status === 403) return json({ error: "Calendly rejected the access token." }, 502);
        }
        return json({ error: "Couldn't load this person's interviews from Calendly." }, 502);
      }
    }

    if (path === "/stream") {
      if (clients.size >= MAX_CLIENTS) return new Response("Too many viewers", { status: 503, headers: SEC });
      (srv as any).timeout?.(req, 0);
      let ctrl!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode("retry: 3000\n\nevent: state\ndata: " + JSON.stringify(state) + "\n\n"));
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      req.signal.addEventListener("abort", () => clients.delete(ctrl));
      return new Response(stream, {
        headers: {
          ...SEC,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store, no-transform",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return new Response("Not found", { status: 404, headers: SEC });
  },
});

console.log("calendly-live-view listening on " + server.port + (configError ? " (setup needed: " + configError + ")" : ""));

