// Interview supporters (interviewers.json): the names admins can record against a started interview, and who was
// recorded for each booking. A recorded supporter is locked; the names can be renamed, and records follow the rename.
import { bookingsStore, ivStore } from "./data";
import { json, saveOrUndo } from "./http";
import { broadcastState } from "./live";
import { UUID, type Fields } from "./util";

// PUT /admin/api/interviewers: { set: { <booking id>: <name, or "" to clear> } }
export async function assignInterviewers(body: Fields): Promise<Response> {
  const iv = ivStore.data;
  const set: Record<string, string> = {};
  for (const [id, name] of Object.entries(body?.set ?? {})) {
    if (!UUID.test(id) || typeof name !== "string" || (name !== "" && !iv.names.includes(name)))
      return json({ error: "Bad request." }, 400);
    if (iv.assign[id] && iv.assign[id] !== name)
      return json({ error: "The interview supporter is locked once recorded, so it can't be changed." }, 409);
    const b = bookingsStore.data.bookings.find((x) => x.id === id);
    if (name && b && Date.parse(b.start) > Date.now() + 60000)
      return json({ error: "You can record the interview supporter once the interview starts." }, 409);
    if (name && b?.missed) return json({ error: "This interview is marked as not happened. Undo that first." }, 409);
    set[id] = name;
  }
  const prev = { ...iv.assign };
  for (const [id, name] of Object.entries(set)) name ? (iv.assign[id] = name) : delete iv.assign[id];
  const failed = await saveOrUndo(ivStore, () => (iv.assign = prev));
  if (failed) return failed;
  broadcastState();
  return json({ ok: true });
}
// POST /admin/api/interviewer-names: { list: [{ from?: <old name>, to: <name> }] }, in order, at most 12
export async function renameInterviewers(body: Fields): Promise<Response> {
  const iv = ivStore.data;
  if (!Array.isArray(body?.list) || body.list.length > 12) return json({ error: "You can have up to 12 interview supporters." }, 400);
  const names: string[] = [];
  const renames = new Map<string, string>();
  for (const r of body.list) {
    const to = String(r?.to ?? "")
      .trim()
      .slice(0, 30);
    if (!to) continue;
    if (names.some((n) => n.toLowerCase() === to.toLowerCase()))
      return json({ error: "Each interview supporter needs a different name." }, 400);
    names.push(to);
    const from = typeof r?.from === "string" ? r.from : "";
    if (from && from !== to && iv.names.includes(from)) renames.set(from, to);
  }
  if (!names.length) return json({ error: "Keep at least one interview supporter." }, 400);
  const prev = { names: iv.names, assign: { ...iv.assign } };
  iv.names = names;
  for (const [id, n] of Object.entries(iv.assign)) if (renames.has(n)) iv.assign[id] = renames.get(n)!;
  const failed = await saveOrUndo(ivStore, () => Object.assign(iv, prev));
  if (failed) return failed;
  broadcastState();
  return json({ ok: true });
}
