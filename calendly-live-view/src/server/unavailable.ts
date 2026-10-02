// Unavailable times (unavailable.json): an admin blocks a day, a run of days or a few hours, and candidates can't book
// or move an interview into them. Interviews already booked in that time stay as they are; adding the block says how
// many there are, so the admin can move or cancel them.
import { activeBookings, blocksStore } from "./data";
import { json, saveOrUndo } from "./http";
import { broadcastState } from "./live";
import { type Fields } from "./util";

const KEEP_MS = 90 * 86400000; // blocks that ended longer ago than this are dropped at the next change
const MAX_BLOCKS = 200;
const overlaps = (aStart: number, aEnd: number, bStart: string, bEnd: string) => Date.parse(bStart) < aEnd && Date.parse(bEnd) > aStart;
// POST /admin/api/unavailable: { startMs, endMs, note? }
export async function addBlock(body: Fields, by: string): Promise<Response> {
  const startMs = Number(body?.startMs);
  const endMs = Number(body?.endMs);
  const note = String(body?.note ?? "")
    .trim()
    .slice(0, 120);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs % 60000 || endMs % 60000) return json({ error: "Bad request." }, 400);
  if (endMs <= startMs) return json({ error: "The end has to be after the start." }, 400);
  if (endMs <= Date.now()) return json({ error: "That time has already passed." }, 400);
  if (endMs - startMs > 366 * 86400000) return json({ error: "Block at most a year at a time." }, 400);
  const prev = blocksStore.data.blocks;
  const kept = prev.filter((b) => Date.parse(b.end) > Date.now() - KEEP_MS);
  if (kept.length >= MAX_BLOCKS) return json({ error: "There are too many unavailable times. Remove some first." }, 409);
  const block = {
    id: crypto.randomUUID(),
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    note,
    createdAt: new Date().toISOString(),
    by,
  };
  blocksStore.data.blocks = [...kept, block];
  const failed = await saveOrUndo(blocksStore, () => (blocksStore.data.blocks = prev));
  if (failed) return failed;
  broadcastState();
  // interviews already booked in that time, which the admin may want to move
  const clashes = activeBookings().filter((b) => overlaps(Date.parse(b.start), Date.parse(b.end), block.start, block.end)).length;
  return json({ ok: true, id: block.id, clashes });
}
// POST /admin/api/unavailable/delete: { id }
export async function removeBlock(id: string): Promise<Response> {
  const prev = blocksStore.data.blocks;
  if (!prev.some((b) => b.id === id)) return json({ error: "That unavailable time was already removed." }, 404);
  blocksStore.data.blocks = prev.filter((b) => b.id !== id);
  const failed = await saveOrUndo(blocksStore, () => (blocksStore.data.blocks = prev));
  if (failed) return failed;
  broadcastState();
  return json({ ok: true });
}
