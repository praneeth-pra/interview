// Unit tests for the page scripts' logic that doesn't need a browser: dates and labels on the admin page, placing
// overlapping bookings, matching company spellings, and the Contacts page's people and timelines (analytics/api.ts).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { layoutColumns, type Item } from "../src/pages/admin/layout";
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

describe("company spellings", () => {
  test("the same company however it is written", () => {
    expect(sameCompany("Infosys", "infosys ltd")).toBe(true);
    expect(sameCompany("Tata Consultancy Services Pvt Ltd", "tata consultancy")).toBe(true);
    expect(sameCompany("Infosys", "Wipro")).toBe(false);
  });
});

describe("Contacts data (analytics/api.ts, answered in the browser)", () => {
  const base = Date.now();
  const iso = (hoursFromNow: number) => new Date(base + hoursFromNow * HOUR).toISOString();
  const bookings: Booking[] = [
    booking({ id: "a1", name: "Priya Sharma", email: "priya@example.com", company: "Google", start: iso(-72), end: iso(-71) }),
    // the same person under another email, with her words swapped: merged with merge=1
    booking({ id: "a2", name: "sharma priya", email: "p.sharma@work.com", company: "Microsoft", start: iso(24), end: iso(25) }),
    // one typo in a long name: merged too
    booking({ id: "a3", name: "Karthik Reddy", email: "karthik@example.com", start: iso(-48), end: iso(-47) }),
    booking({ id: "a4", name: "Karthik Redy", email: "kreddy@example.com", start: iso(48), end: iso(49) }),
    // a one-word name never matches loosely, and "Guest" never merges
    booking({ id: "a5", name: "Guest", email: "g1@example.com", start: iso(-24), end: iso(-23) }),
    booking({ id: "a6", name: "Guest", email: "g2@example.com", start: iso(-20), end: iso(-19) }),
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
    expect(names).toEqual(["Guest", "Guest", "Karthik Redy", "Priya Sharma"]);
    const priya = people.find((p: any) => p.name === "Priya Sharma");
    expect(priya).toMatchObject({ count: 3, emails: 2 });
    expect(priya.companies_.split(", ").sort()).toEqual(["Google", "Microsoft"]);
    expect(Date.parse(priya.next)).toBe(Date.parse(iso(24))); // the soonest upcoming, not the rescheduled one further out
  });
  test("without merge, every email is its own contact", async () => {
    const people = (await get("/api/people")).body;
    // six emails have an active booking: priya@, p.sharma@, karthik@, kreddy@, g1@, g2@
    expect(people.length).toBe(6);
  });
  test("a contact's timeline: newest last, a reschedule adds the old time as cancelled", async () => {
    const { status, body } = await get("/api/analytics?event=a1&merge=1");
    expect(status).toBe(200);
    expect(body.emailList.sort()).toEqual(["p.sharma@work.com", "priya@example.com"]);
    const ids = body.events.map((e: any) => e.id);
    expect(ids).toEqual(["a1", "a7", "a8-moved", "a2", "a8"]);
    expect(body.events.find((e: any) => e.id === "a7")).toMatchObject({ status: "canceled", canceledBy: "invitee", cancelReason: "Clash" });
    expect(body.events.find((e: any) => e.id === "a8-moved")).toMatchObject({ status: "canceled", rescheduled: true, canceledBy: "host" });
  });
  test("unknown bookings and paths are 404s; interviewers come from the live state", async () => {
    expect((await get("/api/analytics?event=nope")).status).toBe(404);
    expect((await get("/api/nothing")).status).toBe(404);
    expect((await get("/api/interviewers")).body).toMatchObject({ names: ["Asha"], assign: { a1: "Asha" } });
  });
});
