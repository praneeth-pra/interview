// The owner's interview sheet (/praneeth): the table the server sends in the boot block, one row per candidate and
// company, one cell per round, coloured by the round's result.
import { byId, el } from "./shared/dom";

type Cell = { when: string; round: string; result: "cleared" | "hold" | "rejected" | ""; note: string };
type Row = { candidate: string; company: string; rounds: Cell[] };
const boot: { rows: Row[]; columns: number } = JSON.parse(byId("boot").textContent || "{}");
const rows = boot.rows || [];
const columns = boot.columns || 3;
const RESULT = { cleared: "Cleared", hold: "On hold", rejected: "Rejected", "": "" };

const count = rows.reduce((n, r) => n + r.rounds.length, 0);
byId("lead").textContent = rows.length
  ? rows.length +
    (rows.length === 1 ? " candidate and company, " : " candidates and companies, ") +
    count +
    (count === 1 ? " round" : " rounds")
  : "No interviews yet.";

if (rows.length) {
  const head = el("tr", null, [
    el("th", { scope: "col" }, ["Candidate"]),
    el("th", { scope: "col" }, ["Company"]),
    ...Array.from({ length: columns }, (_, i) => el("th", { scope: "col" }, ["Round " + (i + 1)])),
  ]);
  const body = rows.map((r) =>
    el("tr", null, [
      el("th", { scope: "row" }, [r.candidate]),
      el("td", null, [r.company]),
      ...Array.from({ length: columns }, (_, i) => {
        const c = r.rounds[i];
        if (!c) return el("td", { class: "rd" });
        const sub = [c.round, c.note].filter(Boolean).join(" · ");
        return el("td", { class: "rd r-" + (c.result || "none") }, [
          el("span", { class: "w" }, [c.when]),
          sub ? el("span", { class: "s" }, [sub]) : null,
          c.result ? el("span", { class: "vh" }, [", " + RESULT[c.result]]) : null,
        ]);
      }),
    ]),
  );
  byId("tw").appendChild(el("table", null, [el("thead", null, [head]), el("tbody", null, body)]));
}
