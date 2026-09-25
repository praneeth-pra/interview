import { describe, expect, test } from "bun:test";
import { compact, loadCompanies, suggestCompanies } from "../src/pages/book/companies";
import { formatRange, formatTime, middayOf, todayKey } from "../src/pages/book/time";

describe("time (always IST)", () => {
  const start = Date.parse("2026-09-25T04:30:00Z"); // 10:00am IST
  test("formats times and ranges", () => {
    expect(formatTime(start)).toBe("10:00am");
    expect(formatTime(start + 5.5 * 3600000)).toBe("3:30pm");
    expect(formatRange(start, 90)).toBe("10:00am – 11:30am, Friday, September 25, 2026");
  });
  test("day keys", () => {
    expect(middayOf("2026-09-25")).toBe(Date.parse("2026-09-25T06:30:00Z"));
    expect(todayKey()).toBe(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()));
  });
});

describe("company suggestions", () => {
  test("rank exact, prefix, word and alias matches", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      Response.json({
        companies: [
          { n: "Google", a: ["Alphabet"], f: 3 },
          { n: "Goldman Sachs", a: [], f: 1 },
          { n: "Amazon Web Services", a: ["AWS"], f: 0 },
          { n: "Tata Consultancy Services", a: ["TCS"], f: 5 },
        ],
      })) as typeof fetch;
    try {
      await new Promise<void>((done) => loadCompanies(done));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(compact("Tata  Consultancy-Services!")).toBe("tataconsultancyservices");
    expect(suggestCompanies("go").map((m) => m.name)).toEqual(["Google", "Goldman Sachs"]);
    expect(suggestCompanies("alpha")).toEqual([{ name: "Google", popularity: 3, score: 1.5, via: "Alphabet" }]);
    expect(suggestCompanies("services").map((m) => m.name)).toEqual(["Tata Consultancy Services", "Amazon Web Services"]);
    expect(suggestCompanies("tcs")[0]).toMatchObject({ name: "Tata Consultancy Services", via: "TCS" });
    expect(suggestCompanies("")).toEqual([]);
  });
});
