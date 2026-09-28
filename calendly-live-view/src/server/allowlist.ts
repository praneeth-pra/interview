// The Candidates list (allowlist.json): when it is on, only its emails can book. Payments are open to any email, and
// confirming one adds the payer here.
import { allowStore, bookingsStore } from "./data";
import { json, saveOrUndo } from "./http";
import { broadcastState } from "./live";
import { EMAIL_RE, normEmail, type Fields } from "./util";

const MAX_EMAILS = 5000;
export const allowView = () => ({ enabled: allowStore.data.enabled, emails: [...allowStore.data.emails].sort() });
// Add one email (a confirmed payer). True when it is on the list afterwards; false when the list is full or the save
// failed, which leaves the list as it was. The caller broadcasts the new state.
export async function allowEmail(email: string): Promise<boolean> {
  const e = normEmail(email);
  const before = allowStore.data;
  if (before.emails.includes(e)) return true;
  if (!EMAIL_RE.test(e) || before.emails.length >= MAX_EMAILS) return false;
  allowStore.data = { enabled: before.enabled, emails: [...before.emails, e] };
  return !(await saveOrUndo(allowStore, () => (allowStore.data = before)));
}
// POST /admin/api/allowlist: add pasted emails, remove one, turn the list on or off, or add everyone who has booked.
// Nothing changes unless the whole action succeeds and is saved.
export async function changeAllowlist(body: Fields): Promise<Response> {
  const before = allowStore.data;
  const a = { enabled: before.enabled, emails: [...before.emails] };
  let extra: Record<string, unknown> = {};
  const action = String(body?.action ?? "");
  if (action === "add") {
    const have = new Set(a.emails);
    let added = 0;
    let existing = 0;
    const invalid: string[] = [];
    for (const raw of String(body?.text ?? "").split(/[\s,;]+/)) {
      const p = raw.replace(/^[<("']+|[>)"'.]+$/g, "");
      if (!p) continue;
      const e = normEmail(p);
      if (!EMAIL_RE.test(e) || e.length > 200) {
        if (invalid.length < 50) invalid.push(p.slice(0, 80));
        continue;
      }
      if (have.has(e)) {
        existing++;
        continue;
      }
      if (a.emails.length >= MAX_EMAILS) return json({ error: "The list is full (5,000 emails). Remove some first." }, 400);
      have.add(e);
      a.emails.push(e);
      added++;
    }
    extra = { added, existing, invalid };
  } else if (action === "remove") {
    const e = normEmail(body?.email);
    a.emails = a.emails.filter((x) => x !== e);
  } else if (action === "enable") {
    const on = body?.on === true;
    if (on && !a.emails.length) return json({ error: "Add at least one email first. With an empty list, nobody could book." }, 400);
    a.enabled = on;
  } else if (action === "importBooked") {
    const have = new Set(a.emails);
    let added = 0;
    for (const b of bookingsStore.data.bookings) {
      const e = normEmail(b.email);
      if (EMAIL_RE.test(e) && !have.has(e) && a.emails.length < MAX_EMAILS) {
        have.add(e);
        a.emails.push(e);
        added++;
      }
    }
    extra = { added };
  } else return json({ error: "Bad request." }, 400);
  allowStore.data = a;
  const failed = await saveOrUndo(allowStore, () => (allowStore.data = before));
  if (failed) return failed;
  broadcastState();
  return json({ state: allowView(), ...extra });
}
