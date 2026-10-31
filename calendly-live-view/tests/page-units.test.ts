// Unit tests for the page scripts' logic that doesn't need a browser: dates and labels on the admin page, placing
// overlapping bookings, matching company spellings, and the Contacts page's people and timelines (analytics/api.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { layoutColumns, type Item } from "../src/pages/admin/layout";
import { dockPick, isoWeek, monthDays, nextInterview, shiftMonth, supporterCounts } from "../src/pages/admin/rail-data";
import { byWhom, plural, rating10, roundStatus, statusOf, statusPill, titleCase } from "../src/pages/admin/labels";
import {
  addDays,
  blockLabel,
  blockSpan,
  dayKeyOf,
  formatDay,
  formatRange,
  formatTime,
  hourLabel,
  istMs,
  minutesOfDay,
  shortDate,
  timeAgo,
  weekStart,
} from "../src/pages/admin/time";
import type { Booking } from "../src/pages/admin/types";
import { api } from "../src/pages/analytics/api";
import { sameCompany } from "../src/same-company";
import { samePerson } from "../src/same-name";
import { candidateMatches } from "../src/pages/admin/candidates";

const HOUR = 3600000;
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: "b1",
  name: "Priya Sharma",
  email: "priya@example.com",
  start: new Date(Date.now() + 2 * 24 * HOUR).toISOString(),
  end: new Date(Date.now() + 2 * 24 * HOUR + 30 * 60000).toISOString(),
  duration: 30,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("admin dates (always IST)", () => {
  const tenAm = Date.parse("2026-09-25T04:30:00Z"); // 10:00am IST, a Friday
  test("day keys follow India's date, not UTC's", () => {
    expect(dayKeyOf(tenAm)).toBe("2026-09-25");
    expect(dayKeyOf(Date.parse("2026-09-24T19:00:00Z"))).toBe("2026-09-25"); // 00:30 IST
  });
  test("times, minutes since midnight and hour labels", () => {
    expect(formatTime(tenAm)).toBe("10:00am");
    expect(formatTime(tenAm + 5.5 * HOUR)).toBe("3:30pm");
    expect(minutesOfDay(tenAm)).toBe(600);
    expect([0, 9, 12, 13, 24].map(hourLabel)).toEqual(["12 AM", "9 AM", "12 PM", "1 PM", "12 AM"]);
    expect(formatRange({ start: new Date(tenAm).toISOString(), end: new Date(tenAm + HOUR).toISOString() })).toBe(
      "Fri, Sep 25, 10:00am – 11:00am",
    );
  });
  test("day names, short dates and how long ago", () => {
    expect(formatDay("2026-09-25", { weekday: "long" })).toBe("Friday");
    expect(formatDay("2026-09-25", { day: "numeric", month: "short" })).toBe("Sep 25");
    expect(shortDate(new Date(tenAm).toISOString())).toBe("Fri, Sep 25");
    const ago = (ms: number) => timeAgo(new Date(Date.now() - ms).toISOString());
    expect([ago(20000), ago(5 * 60000), ago(3 * HOUR), ago(2 * 24 * HOUR)]).toEqual(["just now", "5m ago", "3h ago", "2d ago"]);
  });
  test("adding days crosses months and years; weeks start on Monday", () => {
    expect(addDays("2026-09-29", 3)).toBe("2026-10-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekStart("2026-09-25")).toBe("2026-09-21"); // Friday → Monday
    expect(weekStart("2026-09-27")).toBe("2026-09-21"); // Sunday belongs to the week before
    expect(weekStart("2026-09-21")).toBe("2026-09-21");
  });
});

describe("unavailable times (IST)", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  test("a day key and minutes become the moment in India", () => {
    expect(iso(istMs("2026-10-05", 0))).toBe("2026-10-04T18:30:00.000Z");
    expect(iso(istMs("2026-10-05", 14 * 60))).toBe("2026-10-05T08:30:00.000Z");
  });
  test("labels: one whole day, several days, some hours, and hours across midnight", () => {
    const day = (d: string, n = 1) => ({ start: iso(istMs(d, 0)), end: iso(istMs(addDays(d, n), 0)) });
    expect(blockLabel(day("2026-10-05"))).toBe("Mon, Oct 5");
    expect(blockLabel(day("2026-10-05", 3))).toBe("Mon, Oct 5 – Wed, Oct 7");
    expect(blockLabel({ start: iso(istMs("2026-10-05", 840)), end: iso(istMs("2026-10-05", 1020)) })).toBe("Mon, Oct 5, 2:00pm – 5:00pm");
    expect(blockLabel({ start: iso(istMs("2026-10-05", 1200)), end: iso(istMs("2026-10-06", 0)) })).toBe("Mon, Oct 5, 8:00pm – midnight");
    expect(blockLabel({ start: iso(istMs("2026-10-05", 1200)), end: iso(istMs("2026-10-06", 600)) })).toBe(
      "Mon, Oct 5, 8:00pm – Tue, Oct 6, 10:00am",
    );
  });
  test("the part of a block on each day", () => {
    const block = { start: iso(istMs("2026-10-05", 1200)), end: iso(istMs("2026-10-06", 600)) };
    expect(blockSpan(block, "2026-10-05")).toEqual({ from: 1200, to: 1440 });
    expect(blockSpan(block, "2026-10-06")).toEqual({ from: 0, to: 600 });
    expect(blockSpan(block, "2026-10-07")).toBeNull();
  });
});

describe("admin labels", () => {
  test("names typed in lower case get capitals; others are left alone", () => {
    expect(titleCase("priya sharma")).toBe("Priya Sharma");
    expect(titleCase("o'brien-kumar")).toBe("O'Brien-Kumar");
    expect(titleCase("McDonald")).toBe("McDonald");
    expect(titleCase(null)).toBe("");
    expect([plural(1, "email"), plural(3, "email")]).toEqual(["1 email", "3 emails"]);
    expect([byWhom("host"), byWhom("candidate"), byWhom(undefined)]).toEqual(["by you", "by the candidate", ""]);
  });
  test("a booking's status follows cancelled, missed, and the time now", () => {
    const past = { start: new Date(Date.now() - 2 * HOUR).toISOString(), end: new Date(Date.now() - HOUR).toISOString() };
    const now = { start: new Date(Date.now() - 10 * 60000).toISOString(), end: new Date(Date.now() + 20 * 60000).toISOString() };
    expect(statusOf(booking())).toBe("Upcoming");
    expect(statusOf(booking(now))).toBe("In progress");
    expect(statusOf(booking(past))).toBe("Completed");
    expect(statusOf(booking({ ...past, missed: "noshow" }))).toBe("No-show");
    expect(statusOf(booking({ ...past, missed: "other" }))).toBe("Didn't happen");
    expect(statusOf(booking({ cancelled: true, missed: "noshow" }))).toBe("Cancelled");
  });
  test("a rating out of 10 in words and colour", () => {
    expect(rating10(0)).toBeNull();
    expect(rating10(11)).toBeNull();
    expect(rating10(1)).toEqual({ word: "Poor", key: "rejected" });
    expect(rating10(4)).toEqual({ word: "Weak", key: "rejected" });
    expect(rating10(6)).toEqual({ word: "Average", key: "hold" });
    expect(rating10(8)).toEqual({ word: "Good", key: "cleared" });
    expect(rating10(10)).toEqual({ word: "Excellent", key: "cleared" });
  });
  test("the round's status wins over the time-based one, except when cancelled", () => {
    const past = { start: new Date(Date.now() - 2 * HOUR).toISOString(), end: new Date(Date.now() - HOUR).toISOString() };
    expect(roundStatus(booking({ ...past, outcome: "cleared" }))?.label).toBe("Cleared");
    expect(roundStatus(booking({ ...past, missed: "other" }))?.value).toBe("other");
    expect(roundStatus(booking({ ...past, outcome: "hold", cancelled: true }))).toBeNull();
    expect(statusPill(booking({ ...past, outcome: "rejected" }), true)).toEqual({ class: "bk-st sm rs-rejected", text: "Rejected" });
    expect(statusPill(booking(past))).toEqual({ class: "bk-st st-completed", text: "Completed" });
  });
});

describe("placing overlapping bookings", () => {
  const items = (spans: [number, number][]): Item[] => spans.map(([from, to], i) => ({ booking: booking({ id: "b" + i }), from, to }));
  test("bookings that don't overlap each get the full width", () => {
    const list = items([
      [600, 630],
      [630, 660],
    ]);
    layoutColumns(list);
    expect(list.map((item) => [item.col, item.group!.cols.length])).toEqual([
      [0, 1],
      [0, 1],
    ]);
  });
  test("overlaps share a group side by side, and a freed column is reused", () => {
    // 10:00-11:00, 10:30-11:30, 11:00-11:30: the third fits back in the first column
    const list = items([
      [600, 660],
      [630, 690],
      [660, 690],
    ]);
    layoutColumns(list);
    expect(list.map((item) => item.col)).toEqual([0, 1, 0]);
    expect(list[0].group).toBe(list[2].group!);
    expect(list[0].group!.cols.length).toBe(2);
  });
});

describe("laptop sidebar and panel", () => {
  // 10:00 IST on Friday, Oct 30, 2026
  const NOW = Date.parse("2026-10-30T04:30:00Z");
  const at = (iso: string, minutes: number, over: Partial<Booking> = {}) =>
    booking({ start: iso, end: new Date(Date.parse(iso) + minutes * 60000).toISOString(), ...over });
  test("a month is whole weeks from Monday", () => {
    const days = monthDays("2026-10");
    expect(days.length % 7).toBe(0);
    expect(days[0]).toEqual({ day: "2026-09-28", inMonth: false });
    expect(days.find((d) => d.day === "2026-10-31")!.inMonth).toBe(true);
    expect(days[days.length - 1].day).toBe("2026-11-01");
    expect(monthDays("2027-02").length).toBe(28);
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(isoWeek("2026-10-26")).toEqual({ week: 44, year: 2026 });
    expect(isoWeek("2026-12-28")).toEqual({ week: 53, year: 2026 });
    expect(isoWeek("2027-01-03")).toEqual({ week: 53, year: 2026 });
    expect(isoWeek("2027-01-04")).toEqual({ week: 1, year: 2027 });
  });
  test("the week's interviews per supporter", () => {
    const events = [
      at("2026-10-26T05:30:00Z", 60, { id: "a" }),
      at("2026-10-27T05:30:00Z", 60, { id: "b" }),
      at("2026-10-28T05:30:00Z", 60, { id: "c" }),
      at("2026-10-28T07:30:00Z", 60, { id: "d", cancelled: true }),
      at("2026-11-02T05:30:00Z", 60, { id: "e" }),
    ];
    const counts = supporterCounts(events, { a: "Asha", b: "Old", d: "Asha", e: "Asha" }, ["Asha", "Ravi"], "2026-10-26");
    expect(counts.rows).toEqual([
      { name: "Asha", count: 1 },
      { name: "Ravi", count: 0 },
      { name: "Old", count: 1 },
    ]);
    expect(counts.none).toBe(1);
  });
  test("the interview on now or next", () => {
    const past = at("2026-10-30T03:00:00Z", 60, { id: "p" });
    const live = at("2026-10-30T04:00:00Z", 60, { id: "l" });
    const later = at("2026-10-30T07:30:00Z", 30, { id: "n" });
    const gone = at("2026-10-30T04:40:00Z", 30, { id: "x", cancelled: true });
    expect(nextInterview([later, past, live, gone], NOW)!.id).toBe("l");
    expect(nextInterview([past], NOW)).toBeNull();
  });
  test("the agenda opens a day on its next interview, else its first", () => {
    const first = at("2026-10-30T03:00:00Z", 60, { id: "f" });
    const next = at("2026-10-30T07:30:00Z", 30, { id: "n" });
    const cancelled = at("2026-10-30T05:00:00Z", 30, { id: "c", cancelled: true });
    expect(dockPick([first, cancelled, next], NOW)!.id).toBe("n");
    expect(dockPick([first], NOW)!.id).toBe("f");
    expect(dockPick([cancelled], NOW)!.id).toBe("c");
    expect(dockPick([], NOW)).toBeNull();
  });
});
describe("company spellings", () => {
  test("the same company however it is written", () => {
    expect(sameCompany("Infosys", "infosys ltd")).toBe(true);
    expect(sameCompany("Tata Consultancy Services Pvt Ltd", "tata consultancy")).toBe(true);
    expect(sameCompany("Infosys", "Wipro")).toBe(false);
  });
});

describe("same person (one email is one person)", () => {
  test("a first name alone, swapped words or a typo are the same person; another name isn't", () => {
    expect(samePerson("Hareesh", "Hareesh Kumar")).toBe(true);
    expect(samePerson("sharma priya", "Priya Sharma")).toBe(true);
    expect(samePerson("Karthik Redy", "Karthik Reddy")).toBe(true);
    expect(samePerson("Hemanth", "Hareesh")).toBe(false);
    expect(samePerson("Priya Sharma", "Priya Verma")).toBe(false);
    expect(samePerson("", "Anyone")).toBe(true);
  });
});
describe("Contacts data (analytics/api.ts, answered in the browser)", () => {
  const base = Date.now();
  const iso = (hoursFromNow: number) => new Date(base + hoursFromNow * HOUR).toISOString();
  const bookings: Booking[] = [
    booking({ id: "a1", name: "Priya Sharma", email: "priya@example.com", company: "Google", start: iso(-72), end: iso(-71), rating: 8, feedback: "Nervous at first" }),
    // the same person under another email, with her words swapped: merged with merge=1
    booking({ id: "a2", name: "sharma priya", email: "p.sharma@work.com", company: "Microsoft", start: iso(24), end: iso(25), rating: 7 }),
    // one typo in a long name: merged too
    booking({ id: "a3", name: "Karthik Reddy", email: "karthik@example.com", start: iso(-48), end: iso(-47) }),
    booking({ id: "a4", name: "Karthik Redy", email: "kreddy@example.com", start: iso(48), end: iso(49) }),
    // a one-word name never matches loosely, and "Guest" never merges
    booking({ id: "a5", name: "Guest", email: "g1@example.com", start: iso(-24), end: iso(-23) }),
    booking({ id: "a6", name: "Guest", email: "g2@example.com", start: iso(-20), end: iso(-19) }),
    // someone else booked a demo with Hareesh's email: two contacts, each with only their own bookings
    booking({ id: "h1", name: "Hareesh", email: "hareesh@example.com", start: iso(-96), end: iso(-95) }),
    booking({ id: "h2", name: "Hareesh", email: "hareesh@example.com", start: iso(-30), end: iso(-29) }),
    booking({ id: "h3", name: "Hemanth", email: "hareesh@example.com", round: "Demo", start: iso(-10), end: iso(-9) }),
    // the owner's email used for a demo for an existing candidate: her page keeps only her own email
    booking({ id: "v1", name: "Vinila", email: "owner@example.com", round: "Demo", start: iso(-200), end: iso(-199), staff: true }),
    booking({ id: "v2", name: "Vinila", email: "vinila@example.com", company: "Acme", start: iso(-100), end: iso(-99) }),
    // an email booked under two people's names isn't either one's own, even without the admin mark
    booking({ id: "s1", name: "Sravan Kumar", email: "shared@example.com", round: "Demo", start: iso(-150), end: iso(-149) }),
    booking({ id: "s2", name: "Deepika Rao", email: "shared@example.com", round: "Demo", start: iso(-140), end: iso(-139) }),
    booking({ id: "s3", name: "Deepika Rao", email: "deepika@example.com", start: iso(-60), end: iso(-59) }),
    // cancelled: not a contact, but on the timeline
    booking({
      id: "a7",
      name: "Priya Sharma",
      email: "priya@example.com",
      start: iso(5),
      end: iso(6),
      cancelled: true,
      cancelledBy: "candidate",
      cancelReason: "Clash",
    }),
    // rescheduled from an earlier time: shows twice on the timeline
    booking({
      id: "a8",
      name: "Priya Sharma",
      email: "priya@example.com",
      start: iso(72),
      end: iso(73),
      prevStart: iso(10),
      rescheduledAt: iso(-1),
      rescheduledBy: "host",
    }),
  ];
  const realWindow = (globalThis as any).window;
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    (globalThis as any).window = globalThis;
    globalThis.fetch = (async (url: string) =>
      url === "/admin/api/bookings"
        ? Response.json({ bookings })
        : Response.json({ iv: { names: ["Asha"], assign: { a1: "Asha" } } })) as unknown as typeof fetch;
  });
  afterAll(() => {
    (globalThis as any).window = realWindow;
    globalThis.fetch = realFetch;
  });
  const get = async (url: string) => {
    const res = await api(url);
    return { status: res.status, body: await res.json() };
  };

  test("with merge=1, look-alike names under different emails are one contact", async () => {
    const people = (await get("/api/people?merge=1")).body;
    const names = people.map((p: any) => p.name).sort();
    expect(names).toEqual(["Deepika Rao", "Guest", "Guest", "Hareesh", "Hemanth", "Karthik Redy", "Priya Sharma", "Sravan Kumar", "Vinila"]);
    const priya = people.find((p: any) => p.name === "Priya Sharma");
    expect(priya).toMatchObject({ count: 3, emails: 2 });
    expect(priya.companies_.split(", ").sort()).toEqual(["Google", "Microsoft"]);
    expect(Date.parse(priya.next)).toBe(Date.parse(iso(24))); // the soonest upcoming, not the rescheduled one further out
  });
  test("without merge, every email is its own contact", async () => {
    const people = (await get("/api/people")).body;
    // eleven emails have an active booking: priya@, p.sharma@, karthik@, kreddy@, g1@, g2@, hareesh@, owner@, vinila@,
    // shared@, deepika@
    expect(people.length).toBe(11);
  });
  test("every candidate has one email: an owner's or shared email is set aside for their own", async () => {
    const vinila = (await get("/api/analytics?event=v1&merge=1")).body;
    expect(vinila).toMatchObject({ emailList: ["vinila@example.com"], emails: 1 });
    expect(vinila.events.map((e: any) => e.id)).toEqual(["v1", "v2"]);
    expect((await get("/api/people?merge=1")).body.find((p: any) => p.name === "Vinila")).toMatchObject({ count: 2, emails: 1 });
    expect((await get("/api/analytics?event=s2&merge=1")).body).toMatchObject({ emailList: ["deepika@example.com"], emails: 1 });
    // someone with only the shared email still shows it: it's the only one they have
    expect((await get("/api/analytics?event=s1&merge=1")).body).toMatchObject({ emailList: ["shared@example.com"], emails: 1 });
  });
  test("a contact's timeline: newest last, a reschedule adds the old time as cancelled", async () => {
    const { status, body } = await get("/api/analytics?event=a1&merge=1");
    expect(status).toBe(200);
    // one email per contact: the one with the latest booking (both are her own, so the note still says she has 2)
    expect(body.emailList).toEqual(["priya@example.com"]);
    expect(body.emails).toBe(2);
    const ids = body.events.map((e: any) => e.id);
    expect(ids).toEqual(["a1", "a7", "a8-moved", "a2", "a8"]);
    expect(body.events.find((e: any) => e.id === "a7")).toMatchObject({ status: "canceled", canceledBy: "invitee", cancelReason: "Clash" });
    expect(body.events.find((e: any) => e.id === "a8-moved")).toMatchObject({ status: "canceled", rescheduled: true, canceledBy: "host" });
    // ratings from the booking panel: on each interview, and their average for the person
    expect(body.events.find((e: any) => e.id === "a1")).toMatchObject({ rating: 8, issues: "Nervous at first" });
    expect(body.events.find((e: any) => e.id === "a8")).toMatchObject({ rating: 0, issues: "" });
    expect(body.rating).toEqual({ average: 7.5, count: 2 });
  });
  test("a contact's page has only the bookings their row counts, even when they share an email", async () => {
    const people = (await get("/api/people?merge=1")).body;
    expect(people.find((p: any) => p.name === "Hemanth")).toMatchObject({ count: 1 });
    expect(people.find((p: any) => p.name === "Hareesh")).toMatchObject({ count: 2 });
    expect((await get("/api/analytics?event=h3&merge=1")).body.events.map((e: any) => e.id)).toEqual(["h3"]);
    expect((await get("/api/analytics?event=h1&merge=1")).body.events.map((e: any) => e.id)).toEqual(["h1", "h2"]);
    // shown separately (by email), the shared email is one contact with all three
    expect((await get("/api/analytics?event=h3")).body.events.length).toBe(3);
    expect((await get("/api/analytics?event=a3")).body.rating).toEqual({ average: 0, count: 0 });
  });
  test("unknown bookings and paths are 404s; interviewers come from the live state", async () => {
    expect((await get("/api/analytics?event=nope")).status).toBe(404);
    expect((await get("/api/nothing")).status).toBe(404);
    expect((await get("/api/interviewers")).body).toMatchObject({ names: ["Asha"], assign: { a1: "Asha" } });
  });
});

describe("admin search candidates", () => {
  test("one row per person, showing their own email over an admin's demo email", () => {
    const rows = candidateMatches(
      [
        booking({ id: "d", name: "Vinila K", email: "owner@example.com", round: "Demo", staff: true, start: "2026-10-01T05:00:00Z" }),
        booking({ id: "i", name: "vinila  k", email: "vinila@example.com", round: "Round 1", start: "2026-10-05T05:00:00Z" }),
        booking({ id: "o", name: "Other Person", email: "other@example.com" }),
      ],
      "vinila",
      8,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "vinila@example.com", count: 2 });
    expect(rows[0].booking.id).toBe("i");
  });
  test("an own email beats a demo one, and the latest booking opens Contacts", () => {
    const rows = candidateMatches(
      [
        booking({ id: "a", name: "Asha", email: "asha@work.com", round: "Round 1", start: "2026-10-01T05:00:00Z" }),
        booking({ id: "b", name: "Asha", email: "asha@demo.com", round: "Demo", start: "2026-10-09T05:00:00Z" }),
      ],
      "asha",
      8,
    );
    expect(rows).toEqual([expect.objectContaining({ email: "asha@work.com", count: 2 })]);
    expect(rows[0].booking.id).toBe("b");
  });
  test("guests group by email, and the limit applies to people", () => {
    const rows = candidateMatches(
      [
        booking({ id: "1", name: "Guest", email: "x@example.com" }),
        booking({ id: "2", name: "Guest", email: "x@example.com" }),
        booking({ id: "3", name: "Guest", email: "y@example.com" }),
      ],
      "guest",
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });
});
