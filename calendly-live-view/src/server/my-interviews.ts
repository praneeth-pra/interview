// The owner's own interview sheet (/praneeth): one row per candidate and company, one cell per round with its date and
// time, coloured by the round's result. Laid out like the spreadsheet Praneeth kept before the app.
// A row is listed when Praneeth supported at least one of its rounds, or a round has no supporter recorded yet (upcoming
// or not filled in); rounds another supporter took show their name, as the sheet's "Taken by others".
import { sameCompany } from "../same-company";
import { TZ } from "./config";
import { type Booking, bookingsStore, ivStore } from "./data";
import { normEmail } from "./util";

export const MY_SUPPORTER = "Praneeth";
export type SheetCell = {
  id: string;
  when: string;
  round: string;
  // the round's result; "" while there's none (upcoming, or not set yet)
  result: "cleared" | "hold" | "rejected" | "";
  note: string;
};
export type SheetRow = { candidate: string; company: string; rounds: SheetCell[] };

const ord = (d: number) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");
// "15th Jul 10 AM", "22nd Jul 3:30 PM", as in the sheet; the year is added when it isn't this year
export function sheetWhen(iso: string, now = Date.now()) {
  const part = (o: Intl.DateTimeFormatOptions, at: number | string = iso) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...o }).format(new Date(at));
  const year = part({ year: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso))
    .replace(":00", "");
  const thisYear = year === part({ year: "numeric" }, now);
  return ord(Number(part({ day: "numeric" }))) + " " + part({ month: "short" }) + (thisYear ? "" : " " + year) + " " + time;
}

function cell(b: Booking, by: string, me: string, now: number): SheetCell {
  const note =
    b.missed === "noshow"
      ? "No-show"
      : b.missed
        ? "Didn't happen"
        : by && by.toLowerCase() !== me.toLowerCase()
          ? "Taken by " + by
          : Date.parse(b.start) > now
            ? "Upcoming"
            : "";
  return { id: b.id, when: sheetWhen(b.start, now), round: b.round, result: b.missed ? "" : (b.outcome ?? ""), note };
}

export function mySheet(me = MY_SUPPORTER, now = Date.now()): { rows: SheetRow[]; columns: number } {
  const assign = ivStore.data.assign;
  const groups: { email: string; company: string; candidate: string; list: Booking[] }[] = [];
  const active = bookingsStore.data.bookings.filter((b) => !b.cancelled).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const b of active) {
    const email = normEmail(b.email);
    let g = groups.find((x) => x.email === email && sameCompany(x.company, b.company));
    if (!g) groups.push((g = { email, company: b.company, candidate: b.name, list: [] }));
    g.list.push(b);
    g.candidate = b.name;
  }
  const mine = (b: Booking) => !assign[b.id] || assign[b.id].toLowerCase() === me.toLowerCase();
  const rows = groups
    .filter((g) => g.list.some(mine))
    .map((g) => ({
      candidate: g.candidate,
      company: g.company,
      rounds: g.list.map((b) => cell(b, assign[b.id] ?? "", me, now)),
      latest: Date.parse(g.list[g.list.length - 1].start),
    }))
    // newest first, so the latest interviews are on top without scrolling
    .sort((a, b) => b.latest - a.latest)
    .map(({ latest, ...r }) => r);
  return { rows, columns: Math.max(3, ...rows.map((r) => r.rounds.length)) };
}
