// The MCP server at /mcp: lets an AI app (a Claude connector, Claude Code...) read the admin's data with tools. It speaks
// MCP's Streamable HTTP transport in its simplest form: each POST carries one JSON-RPC message and gets one JSON answer,
// with no sessions and no event stream. Every tool only reads. Owners' tokens also get the owner-only tools (payments,
// enquiries, onboarding forms, revenue and expenses), the same split as the admin page. Files (resumes, receipts,
// Aadhaar and PAN cards, interview invites) are never sent.
import { DAY_END_MIN, DAY_START_MIN, DURATIONS } from "./config";
import { type Booking, blocksStore, bookingsStore, enquiriesStore, expensesStore, ivStore, onboardingStore, paymentsStore } from "./data";
import { analyticsView } from "./analytics";
import { enquiryView } from "./enquiries";
import { onboardingList } from "./onboarding";
import { paymentView } from "./payments";
import { isBlocked, slotsFor } from "./schedule";
import { dayShort, istDate, istParts, istToUtcMs, t12 } from "./time";
import { DATE_KEY, DAY_MS, type Fields, asFields, normEmail } from "./util";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LIST_MAX = 200;

type Who = { email: string; owner: boolean };
type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
type Tool = { name: string; title: string; description: string; owner?: true; inputSchema: Schema; run: (a: Fields) => unknown };

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const int = (v: unknown, def: number, min: number, max: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;
const when = (iso: string) => (iso ? dayShort(iso) + " IST" : "");
// A day (YYYY-MM-DD, India time) to the moment it starts; "" or a bad value gives null.
function dayStart(key: string): number | null {
  if (!DATE_KEY.test(key)) return null;
  const [y, mo, d] = key.split("-").map(Number);
  const ms = istToUtcMs(y, mo, d, 0);
  return Number.isNaN(ms) ? null : ms;
}
const today = () => {
  const p = istParts(Date.now());
  return istToUtcMs(p.y, p.mo, p.d, 0);
};
const has = (q: string, ...fields: string[]) => !q || fields.some((f) => f.toLowerCase().includes(q.toLowerCase()));

// One booking as the tools show it: the round's status in words, as the admin page says it.
function status(b: Booking, now = Date.now()) {
  if (b.cancelled) return "Cancelled";
  if (b.missed) return b.missed === "noshow" ? "No-show" : "Didn't happen";
  if (b.outcome) return b.outcome === "cleared" ? "Cleared" : b.outcome === "rejected" ? "Rejected" : "On hold";
  if (Date.parse(b.start) > now) return "Upcoming";
  return Date.parse(b.end) > now ? "In progress" : "Completed (no result yet)";
}
const interview = (b: Booking) => ({
  id: b.id,
  candidate: b.name,
  email: b.email,
  company: b.company,
  round: b.round,
  when: when(b.start),
  start: b.start,
  minutes: b.duration,
  attend: b.attend === "remote" ? "Remote" : b.attend === "in-person" ? "In person" : "",
  status: status(b),
  supporter: ivStore.data.assign[b.id] ?? "",
  ...(b.rating ? { rating: b.rating } : {}),
});
const interviewDetail = (b: Booking) => ({
  ...interview(b),
  end: b.end,
  bookedAt: b.createdAt,
  bookedBy: b.source === "admin" ? "admin" : "candidate",
  ...(b.cancelled ? { cancelledAt: b.cancelledAt, cancelledBy: b.cancelledBy ?? "", cancelReason: b.cancelReason ?? "" } : {}),
  ...(b.rescheduledAt ? { rescheduledAt: b.rescheduledAt, rescheduledBy: b.rescheduledBy ?? "", previousStart: b.prevStart ?? "" } : {}),
  ...(b.feedback ? { issues: b.feedback } : {}),
  hrEmails: b.hrEmails ?? [],
  hrPhones: b.hrPhones ?? [],
  invite: b.invite ? "uploaded (open it in the admin page)" : "none",
});
const byStart = (a: Booking, b: Booking) => Date.parse(a.start) - Date.parse(b.start);
const average = (list: number[]) => (list.length ? Math.round((list.reduce((s, n) => s + n, 0) / list.length) * 10) / 10 : null);

function overview(who: Who) {
  const now = Date.now();
  const t0 = today();
  const active = bookingsStore.data.bookings.filter((b) => !b.cancelled);
  const todays = active.filter((b) => Date.parse(b.start) >= t0 && Date.parse(b.start) < t0 + DAY_MS).sort(byStart);
  const week = active.filter((b) => Date.parse(b.start) > now && Date.parse(b.start) < t0 + 8 * DAY_MS);
  const started = active.filter((b) => Date.parse(b.start) <= now && !b.missed);
  return {
    today: istDate(new Date(now).toISOString()),
    interviewsToday: todays.map(interview),
    upcomingNext7Days: week.length,
    // the admin page's "to review" count
    startedWithNoSupporter: started.filter((b) => !ivStore.data.assign[b.id]).length,
    completedWithNoResult: started.filter((b) => !b.outcome && Date.parse(b.end) <= now).length,
    ...(who.owner
      ? {
          paymentsWaitingForDecision: paymentsStore.data.payments.filter((p) => !p.decision).length,
          enquiriesLast7Days: enquiriesStore.data.enquiries.filter((e) => Date.parse(e.createdAt) > now - 7 * DAY_MS).length,
          onboardingForms: onboardingStore.data.forms.length,
        }
      : {}),
  };
}

function listInterviews(a: Fields) {
  const q = str(a.query, 100);
  const from = dayStart(str(a.from)) ?? (q ? -Infinity : today());
  const toDay = dayStart(str(a.to));
  const to = toDay !== null ? toDay + DAY_MS : q && !str(a.from) ? Infinity : (from === -Infinity ? today() : from) + 7 * DAY_MS;
  const statusWanted = str(a.status).toLowerCase();
  const limit = int(a.limit, 50, 1, LIST_MAX);
  const list = bookingsStore.data.bookings
    .filter((b) => (a.include_cancelled === true || statusWanted === "cancelled" ? true : !b.cancelled))
    .filter((b) => Date.parse(b.start) >= from && Date.parse(b.start) < to)
    .filter((b) => has(q, b.name, b.email, b.company, b.round, ivStore.data.assign[b.id] ?? ""))
    .map(interview)
    .filter((v) => !statusWanted || v.status.toLowerCase().startsWith(statusWanted))
    .sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
  return { count: list.length, shown: Math.min(limit, list.length), interviews: list.slice(0, limit) };
}

function getInterview(a: Fields) {
  const b = bookingsStore.data.bookings.find((x) => x.id === str(a.id, 40));
  return b ? interviewDetail(b) : { error: "No interview has that id. Find ids with list_interviews." };
}

function freeSlots(a: Fields) {
  const key = str(a.date);
  const start = dayStart(key);
  if (start === null) return { error: "Give date as YYYY-MM-DD (India time)." };
  const duration = DURATIONS.includes(Number(a.duration)) ? Number(a.duration) : 30;
  const [y, mo, d] = key.split("-").map(Number);
  const slots = slotsFor(y, mo, d, duration).map((ms) => ({
    time: t12(new Date(ms).toISOString()) + " IST",
    start: new Date(ms).toISOString(),
    // the team marked this time unavailable: candidates can't book it, admins still can
    unavailable: isBlocked(ms, ms + duration * 60000),
  }));
  const fmt = (min: number) => t12(new Date(istToUtcMs(y, mo, d, min)).toISOString());
  return { date: key, duration, hours: fmt(DAY_START_MIN) + " to " + fmt(DAY_END_MIN) + " IST", free: slots };
}

function listUnavailable() {
  const now = Date.now();
  return {
    unavailable: blocksStore.data.blocks
      .filter((b) => Date.parse(b.end) > now)
      .sort((x, y) => Date.parse(x.start) - Date.parse(y.start))
      .map((b) => ({ from: when(b.start), to: when(b.end), note: b.note })),
  };
}

// Everyone the app knows by email: from bookings, and for owners also payments, onboarding forms and enquiries.
function people(who: Who) {
  const map = new Map<string, { name: string; email: string; bookings: Booking[] }>();
  const add = (name: string, email: string) => {
    const e = normEmail(email);
    if (!e) return null;
    const p = map.get(e) ?? { name, email: e, bookings: [] };
    map.set(e, p);
    return p;
  };
  for (const b of [...bookingsStore.data.bookings].sort(byStart)) {
    const p = add(b.name, b.email);
    if (p) {
      p.name = b.name;
      p.bookings.push(b);
    }
  }
  if (who.owner) {
    for (const v of paymentsStore.data.payments) add(v.name, v.email);
    for (const v of onboardingStore.data.forms) add(v.name, v.email);
    for (const v of enquiriesStore.data.enquiries) add(v.name, v.email);
  }
  return map;
}
function summary(p: { name: string; email: string; bookings: Booking[] }) {
  const done = p.bookings.filter((b) => !b.cancelled);
  const last = done.at(-1);
  return {
    name: p.name,
    email: p.email,
    interviews: done.length,
    companies: [...new Set(done.map((b) => b.company))],
    lastInterview: last ? when(last.start) : "",
    averageRating: average(done.filter((b) => b.rating).map((b) => b.rating!)),
  };
}
function searchCandidates(a: Fields, who: Who) {
  const q = str(a.query, 100);
  if (!q) return { error: "Give part of a name, email or company." };
  const found = [...people(who).values()].filter((p) => has(q, p.name, p.email, ...p.bookings.map((b) => b.company)));
  return { count: found.length, candidates: found.slice(0, 50).map(summary) };
}
function getCandidate(a: Fields, who: Who) {
  const email = normEmail(a.email);
  const p = people(who).get(email);
  if (!p) return { error: "No candidate has that email. Find them with search_candidates." };
  const mine = (v: { email: string }) => normEmail(v.email) === email;
  const form = who.owner ? onboardingList().forms.find(mine) : undefined;
  return {
    ...summary(p),
    interviewList: p.bookings.map(interviewDetail),
    ...(who.owner
      ? {
          payments: paymentsStore.data.payments.filter(mine).map(payment),
          onboarding: form ? onboardingRow(form) : null,
          enquiries: enquiriesStore.data.enquiries.filter(mine).map(enquiry),
          expenses: expensesStore.data.expenses.filter((x) => x.email && mine(x)).map(expense),
        }
      : {}),
  };
}

// ---- owners only
const payment = (v: Parameters<typeof paymentView>[0]) => {
  const p = paymentView(v);
  return {
    id: p.id,
    name: p.name,
    email: p.email,
    amount: p.amount,
    installment: p.installment,
    sent: when(p.createdAt),
    receipt: p.check === "verified" ? "Verified" : "Needs check",
    decision: p.decision || "pending",
    decidedAt: p.decidedAt,
  };
};
const enquiry = (v: Parameters<typeof enquiryView>[0]) => {
  const e = enquiryView(v);
  return {
    name: e.name,
    email: e.email,
    phone: e.phone,
    tech: e.tech,
    experience: e.experience,
    genuine: e.genuine,
    sent: when(e.createdAt),
  };
};
const onboardingRow = (f: ReturnType<typeof onboardingList>["forms"][number]) => ({
  name: f.name,
  email: f.email,
  phone: f.phone,
  tech: f.tech,
  experience: f.experience,
  genuine: f.genuine,
  linkedin: f.linkedin,
  sent: when(f.createdAt),
});
const expense = (x: (typeof expensesStore.data.expenses)[number]) => ({
  date: x.date,
  amount: x.amount,
  why: x.what,
  paidTo: x.paidTo ?? "",
  category: x.category,
  candidate: x.email ? x.name + " <" + x.email + ">" : "",
});
function listPayments(a: Fields) {
  const want = str(a.status).toLowerCase() || "pending";
  const q = str(a.query, 100);
  const limit = int(a.limit, 50, 1, LIST_MAX);
  const list = [...paymentsStore.data.payments]
    .reverse()
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
    .filter((v) => want === "all" || (want === "pending" ? !v.decision : v.decision === want))
    .filter((v) => has(q, v.name, v.email))
    .map(payment);
  return { count: list.length, totalAmount: list.reduce((s, v) => s + v.amount, 0), payments: list.slice(0, limit) };
}
function listEnquiries(a: Fields) {
  const q = str(a.query, 100);
  const limit = int(a.limit, 30, 1, LIST_MAX);
  const list = [...enquiriesStore.data.enquiries]
    .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
    .filter((v) => has(q, v.name, v.email, v.tech))
    .map(enquiry);
  return { count: list.length, enquiries: list.slice(0, limit) };
}
function listOnboarding(a: Fields) {
  const q = str(a.query, 100);
  const list = onboardingList()
    .forms.filter((v) => has(q, v.name, v.email, v.tech))
    .map(onboardingRow);
  return { count: list.length, forms: list.slice(0, int(a.limit, 50, 1, LIST_MAX)) };
}
function revenue(a: Fields) {
  const v = analyticsView(str(a.query, 100));
  return {
    months: v.months,
    revenue: v.revenue,
    spent: v.spent,
    byCandidate: v.byCandidate.slice(0, 100),
    ...(v.found.length ? { found: v.found, paidIn: v.paidIn } : {}),
    note: "Amounts in rupees. Revenue counts confirmed payments only; pending is shown apart. byMonth lines up with months.",
  };
}
function listExpenses(a: Fields) {
  const from = str(a.from);
  const to = str(a.to);
  const q = str(a.query, 100);
  const list = [...expensesStore.data.expenses]
    .filter((x) => (!DATE_KEY.test(from) || x.date >= from) && (!DATE_KEY.test(to) || x.date <= to))
    .filter((x) => has(q, x.what, x.name, x.email, x.paidTo ?? "", x.category))
    .sort((x, y) => y.date.localeCompare(x.date))
    .map(expense);
  return { count: list.length, total: list.reduce((s, x) => s + x.amount, 0), expenses: list.slice(0, int(a.limit, 100, 1, 500)) };
}

const obj = (properties: Record<string, unknown>, required?: string[]): Schema => ({
  type: "object",
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});
const DAY = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const LIMIT = { type: "integer", minimum: 1, maximum: LIST_MAX, description: "Most rows to return." };
const tools = (who: Who): Tool[] => [
  {
    name: "get_overview",
    title: "Today at a glance",
    description:
      "Today's interviews, how many are coming up in the next 7 days, and what needs attention (interviews with no supporter or no result yet" +
      (who.owner ? ", payments waiting for a decision, new enquiries" : "") +
      "). Times are India time (IST).",
    inputSchema: obj({}),
    run: () => overview(who),
  },
  {
    name: "list_interviews",
    title: "List interviews",
    description:
      "Interviews (bookings) between two days, earliest first, with candidate, company, round, time (IST), status and interview supporter. " +
      "Without dates it lists today and the next 6 days; with only a query it searches all time.",
    inputSchema: obj({
      from: { ...DAY, description: "First day, YYYY-MM-DD (India time)." },
      to: { ...DAY, description: "Last day, YYYY-MM-DD (included)." },
      query: { type: "string", description: "Part of a candidate's name or email, a company, round or supporter." },
      status: {
        type: "string",
        enum: ["upcoming", "in progress", "completed", "cleared", "rejected", "on hold", "no-show", "didn't happen", "cancelled"],
      },
      include_cancelled: { type: "boolean" },
      limit: LIMIT,
    }),
    run: listInterviews,
  },
  {
    name: "get_interview",
    title: "One interview",
    description:
      "Everything about one interview: status, supporter, rating and issues noted, reschedules, cancel reason, HR contacts read from the invite.",
    inputSchema: obj({ id: { type: "string", description: "The interview's id, from list_interviews." } }, ["id"]),
    run: getInterview,
  },
  {
    name: "find_free_slots",
    title: "Free interview times",
    description: "Start times still free on a day (no other interview overlaps), in IST. Times the team marked unavailable are flagged.",
    inputSchema: obj(
      { date: { ...DAY, description: "The day, YYYY-MM-DD (India time)." }, duration: { type: "integer", enum: DURATIONS } },
      ["date"],
    ),
    run: freeSlots,
  },
  {
    name: "list_unavailable",
    title: "Unavailable times",
    description: "Upcoming times the team marked as unavailable, when candidates can't book.",
    inputSchema: obj({}),
    run: listUnavailable,
  },
  {
    name: "search_candidates",
    title: "Search candidates",
    description:
      "Find candidates by part of their name, email or a company they interviewed with. Gives each one's interview count, companies and average rating.",
    inputSchema: obj({ query: { type: "string" } }, ["query"]),
    run: (a) => searchCandidates(a, who),
  },
  {
    name: "get_candidate",
    title: "One candidate",
    description:
      "A candidate's full history by email: every interview with status, rating and notes" +
      (who.owner ? ", plus their payments, onboarding form (no ID cards), enquiries and expenses spent on them." : "."),
    inputSchema: obj({ email: { type: "string" } }, ["email"]),
    run: (a) => getCandidate(a, who),
  },
  {
    name: "list_payments",
    title: "Payments",
    owner: true,
    description: "Payments candidates reported, newest first. Defaults to the ones waiting for a decision. Amounts in rupees.",
    inputSchema: obj({
      status: { type: "string", enum: ["pending", "confirmed", "discarded", "all"] },
      query: { type: "string", description: "Part of a name or email." },
      limit: LIMIT,
    }),
    run: listPayments,
  },
  {
    name: "list_enquiries",
    title: "Enquiries",
    owner: true,
    description:
      "Enquiries from the public enquiry page, newest first: name, email, phone, technology and experience (resumes stay in the admin page).",
    inputSchema: obj({ query: { type: "string", description: "Part of a name, email or technology." }, limit: LIMIT }),
    run: listEnquiries,
  },
  {
    name: "list_onboarding",
    title: "Onboarding forms",
    owner: true,
    description:
      "Onboarding forms, newest first: name, email, phone, technology, experience, LinkedIn. Aadhaar and PAN cards are never shared.",
    inputSchema: obj({ query: { type: "string", description: "Part of a name, email or technology." }, limit: LIMIT }),
    run: listOnboarding,
  },
  {
    name: "get_revenue",
    title: "Revenue",
    owner: true,
    description:
      "The Revenue tab: confirmed payments and expenses for the last 12 months, month by month, and paid versus spent per candidate. " +
      "A query narrows it to matching candidates.",
    inputSchema: obj({ query: { type: "string", description: "Part of a candidate's name or email." } }),
    run: revenue,
  },
  {
    name: "list_expenses",
    title: "Expenses",
    owner: true,
    description: "Money paid out (supporters' pay, tools, ads...), newest first, with the total. Amounts in rupees.",
    inputSchema: obj({
      from: { ...DAY, description: "First day, YYYY-MM-DD." },
      to: { ...DAY, description: "Last day, YYYY-MM-DD (included)." },
      query: { type: "string", description: "Part of the reason, supporter, category or candidate." },
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
    run: listExpenses,
  },
];
export const toolsFor = (who: Who) => tools(who).filter((t) => who.owner || !t.owner);

const INSTRUCTIONS =
  "Hi-Techie's interview admin: candidates book interview support for their company interview rounds, and the team " +
  "(interview supporters) joins them. All times are India time (IST); amounts are rupees. Every tool only reads; " +
  "to book, reschedule, cancel or record results, use the admin page at /admin.";

type Rpc = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// One JSON-RPC message in, its answer out (null for a notification, which gets no answer).
export function handleRpc(msg: unknown, who: Who): object | null {
  const m = asFields(msg) as Rpc;
  const isRequest = "id" in m && (typeof m.id === "string" || typeof m.id === "number");
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string") return fail(m.id, -32600, "Invalid request.");
  if (!isRequest) return null;
  const params = asFields(m.params);
  switch (m.method) {
    case "initialize": {
      const asked = str(params.protocolVersion, 20);
      return reply(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hi-techie", title: "Hi-Techie interviews", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply(m.id, {});
    case "tools/list":
      return reply(m.id, {
        tools: toolsFor(who).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        })),
      });
    case "tools/call": {
      const tool = toolsFor(who).find((t) => t.name === params.name);
      if (!tool) return fail(m.id, -32602, "Unknown tool: " + String(params.name).slice(0, 60));
      let out: unknown;
      try {
        out = tool.run(asFields(params.arguments));
      } catch (e) {
        console.log("mcp: " + tool.name + " failed: " + String(e));
        return reply(m.id, { content: [{ type: "text", text: "Something went wrong reading the data." }], isError: true });
      }
      return reply(m.id, { content: [{ type: "text", text: JSON.stringify(out) }], ...(asFields(out).error ? { isError: true } : {}) });
    }
    default:
      return fail(m.id, -32601, "Method not found: " + m.method.slice(0, 60));
  }
}
