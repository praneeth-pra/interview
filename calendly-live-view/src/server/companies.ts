// Company names: suggestions for the booking form, and keeping one spelling per candidate.
import { readData } from "../assets";
import { sameCompany } from "../same-company";
import { bookingsStore } from "./data";
import { compact, normEmail } from "./util";

const KNOWN_COMPANIES: string[] = JSON.parse(readData("companies.json"));
export function knownName(email: string) {
  const e = normEmail(email);
  const groups = new Map<string, { n: number; last: number; spell: Map<string, { n: number; last: number }> }>();
  for (const b of bookingsStore.data.bookings) {
    if (normEmail(b.email) !== e) continue;
    const name = String(b.name ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (!name) continue;
    const t = Date.parse(b.createdAt) || Date.parse(b.start) || 0;
    let g = groups.get(name.toLowerCase());
    if (!g) groups.set(name.toLowerCase(), (g = { n: 0, last: 0, spell: new Map() }));
    g.n++;
    g.last = Math.max(g.last, t);
    const sp = g.spell.get(name) ?? { n: 0, last: 0 };
    sp.n++;
    sp.last = Math.max(sp.last, t);
    g.spell.set(name, sp);
  }
  let best: { n: number; last: number; spell: Map<string, { n: number; last: number }> } | null = null;
  for (const g of groups.values()) if (!best || g.n > best.n || (g.n === best.n && g.last > best.last)) best = g;
  if (!best) return "";
  const cased = (s: string) => (s !== s.toLowerCase() && s !== s.toUpperCase() ? 1 : 0);
  return [...best.spell.entries()].sort((x, y) => y[1].n - x[1].n || cased(y[0]) - cased(x[0]) || y[1].last - x[1].last)[0][0];
}
const JUNK_COMPANY = new Set([
  "na",
  "none",
  "nil",
  "null",
  "test",
  "nothing",
  "notapplicable",
  "self",
  "xyz",
  "abc",
  "no",
  "yes",
  "other",
  "fresher",
  "student",
  "unemployed",
  "confidential",
]);
export function companySuggestions() {
  const list = KNOWN_COMPANIES.map((s) => {
    const [n, ...a] = s.split("|");
    return { n, a, f: 0 };
  });
  const byKey = new Map<string, (typeof list)[number]>();
  for (const c of list) for (const t of [c.n, ...c.a]) if (!byKey.has(compact(t))) byKey.set(compact(t), c);
  const typed = new Map<string, { people: Set<string>; spell: Map<string, number> }>();
  for (const b of bookingsStore.data.bookings) {
    const raw = String(b.company ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const k = compact(raw);
    if (raw.length < 2 || raw.length > 50 || !k || JUNK_COMPANY.has(k) || /[@<>{}]|https?:|\d{5,}/.test(raw) || raw.split(" ").length > 5)
      continue;
    const known = byKey.get(k);
    if (known) {
      known.f++;
      continue;
    }
    let g = typed.get(k);
    if (!g) typed.set(k, (g = { people: new Set(), spell: new Map() }));
    g.people.add(String(b.email || b.name || b.id).toLowerCase());
    g.spell.set(raw, (g.spell.get(raw) ?? 0) + 1);
  }
  // a name only one candidate typed stays private: it may be their own company or a typo with their details
  for (const g of typed.values()) {
    if (g.people.size < 2) continue;
    const n = [...g.spell.entries()].sort((x, y) => y[1] - x[1])[0][0];
    list.push({ n, a: [], f: g.people.size });
  }
  return list;
}
// Known company names and aliases ("TCS" and "Tata Consultancy Services"), keyed by compact(), to the name's line in companies.json.
const KNOWN_BY_KEY = new Map<string, number>();
KNOWN_COMPANIES.forEach((line, index) => {
  for (const name of line.split("|")) if (!KNOWN_BY_KEY.has(compact(name))) KNOWN_BY_KEY.set(compact(name), index);
});
// A candidate's later rounds keep the company name they gave before, so analytics sees one company: when the new name is
// a near-spelling of an earlier one ("Infosis" after "Infosys") or another name of the same known company ("TCS" after
// "Tata Consultancy Services"), the earlier spelling is saved. A known name is never replaced by an unknown spelling.
export function earlierSpelling(email: string, company: string): string {
  if (!company) return company;
  const key = compact(company);
  const known = KNOWN_BY_KEY.get(key);
  const earlier = bookingsStore.data.bookings
    .filter((b) => b.email.toLowerCase() === email.toLowerCase() && String(b.company ?? "").trim())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((b) => String(b.company).trim());
  if (earlier.includes(company)) return company;
  for (const prev of earlier) {
    const prevKnown = KNOWN_BY_KEY.get(compact(prev));
    if (known !== undefined && prevKnown === undefined) continue;
    if (compact(prev) === key || (known !== undefined && prevKnown === known) || sameCompany(prev, company)) return prev;
  }
  return company;
}
