// The owner's own interview sheet (/praneeth): one row per candidate and company, one cell per round with its date and
// time, coloured by the round's result. Laid out like the spreadsheet Praneeth kept before the app.
// Only the rounds recorded with Praneeth as the interview supporter are listed (a supporter is recorded once a round starts).
import { sameCompany } from "../same-company";
import { type Booking, bookingsStore, ivStore } from "./data";
import { istParts, t12 } from "./time";
import { normEmail } from "./util";

export const MY_SUPPORTER = "Praneeth";
export type SheetCell = {
  when: string;
  round: string;
  // the round's result; "" while there's none (upcoming, or not set yet)
  result: "cleared" | "hold" | "rejected" | "";
};
export type SheetRow = { candidate: string; company: string; rounds: SheetCell[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ord = (d: number) => d + (d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th");
// "15th Jul 10am", "22nd Jul 3:30pm"; the year is added when it isn't this year
export function sheetWhen(iso: string, now = Date.now()) {
  const p = istParts(Date.parse(iso));
  return ord(p.d) + " " + MONTHS[p.mo - 1] + (p.y === istParts(now).y ? "" : " " + p.y) + " " + t12(iso).replace(":00", "");
}

export function mySheet(me = MY_SUPPORTER, now = Date.now()): { rows: SheetRow[]; columns: number } {
  const assign = ivStore.data.assign;
  const groups: { email: string; company: string; candidate: string; list: Booking[] }[] = [];
  const mine = bookingsStore.data.bookings
    .filter((b) => !b.cancelled && assign[b.id]?.toLowerCase() === me.toLowerCase())
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const b of mine) {
    const email = normEmail(b.email);
    let g = groups.find((x) => x.email === email && sameCompany(x.company, b.company));
    if (!g) groups.push((g = { email, company: b.company, candidate: b.name, list: [] }));
    g.list.push(b);
    g.candidate = b.name;
  }
  const rows = groups
    .map((g) => ({
      candidate: g.candidate,
      company: g.company,
      rounds: g.list.map((b): SheetCell => ({ when: sheetWhen(b.start, now), round: b.round, result: b.outcome ?? "" })),
      latest: Date.parse(g.list[g.list.length - 1].start),
    }))
    // newest first, so the latest interviews are on top without scrolling
    .sort((a, b) => b.latest - a.latest)
    .map(({ latest, ...r }) => r);
  return { rows, columns: Math.max(3, ...rows.map((r) => r.rounds.length)) };
}
