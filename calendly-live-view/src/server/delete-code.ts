// Deleting an onboarding form needs a code emailed to the owner who asked, so a form (with the candidate's ID cards and
// interview invites) can't be removed by a tap or by someone holding an owner's open session alone. Codes live in
// memory for 10 minutes; five wrong tries end a code; one code every 30 seconds per form. With sign-in off (local runs
// only) there is no owner email to send to, so no code is asked.
import { CODE_MINUTES } from "./auth";
import { HOST_NAME, LOGIN_ON, RESEND_API_KEY } from "./config";
import { onboardingStore } from "./data";
import { emailBody, sendEmail } from "./email";
import { json } from "./http";
import { safeEq, sha256 } from "./util";
import { randomInt } from "node:crypto";

const pending = new Map<string, { hash: string; exp: number; tries: number; sent: number }>();
const keyOf = (owner: string, id: string) => owner + ":" + id;
// "pr…@hi-techie.dev": enough to recognise the inbox in the admin page
const masked = (email: string) => email.replace(/^(.{1,2})[^@]*/, "$1…");

// POST /admin/api/onboarding/delete-code {id}
export async function sendDeleteCode(id: string, owner: string): Promise<Response> {
  const form = onboardingStore.data.forms.find((x) => x.id === id);
  if (!form) return json({ error: "That form was already deleted." }, 404);
  if (!LOGIN_ON || !owner) return json({ needed: false });
  const key = keyOf(owner, id);
  const now = Date.now();
  const before = pending.get(key);
  if (before && now - before.sent < 30000) return json({ needed: true, to: masked(owner) });
  const code = String(randomInt(0, 1000000)).padStart(6, "0");
  pending.set(key, { hash: sha256(key + ":" + code), exp: now + CODE_MINUTES * 60000, tries: 0, sent: now });
  if (!RESEND_API_KEY) {
    console.log("delete code for " + owner + ": " + code + " (email is off, so it is only shown here)");
    return json({ needed: true, to: masked(owner) });
  }
  const body = emailBody({
    heading: "Code to delete an onboarding form",
    intro:
      "Enter this code in the " +
      HOST_NAME +
      " admin page to delete " +
      form.name +
      "'s onboarding form. It works for " +
      CODE_MINUTES +
      " minutes.",
    rows: [
      ["Code", code],
      ["Candidate", form.name + " (" + form.email + ")"],
    ],
    note: "Deleting removes the form, the Aadhaar and PAN cards and the candidate's interview invite screenshots. If you didn't ask for this, someone may be using your admin session: sign out from your devices.",
  });
  const sent = await sendEmail({ to: [owner], subject: "Delete code: " + code, ...body });
  if (!sent) {
    pending.delete(key);
    return json({ error: "Couldn't send the code. Try again." }, 502);
  }
  return json({ needed: true, to: masked(owner) });
}
// Whether the code is right for this owner and form; null when it is, else the answer to send.
export function checkDeleteCode(id: string, owner: string, code: string): Response | null {
  if (!LOGIN_ON || !owner) return null;
  const key = keyOf(owner, id);
  const p = pending.get(key);
  if (!p || p.exp < Date.now()) {
    pending.delete(key);
    return json({ error: "That code has expired. Ask for a new one.", expired: true }, 403);
  }
  if (p.tries >= 5) {
    pending.delete(key);
    return json({ error: "Too many wrong codes. Ask for a new one.", expired: true }, 403);
  }
  if (!/^\d{6}$/.test(code) || !safeEq(sha256(key + ":" + code), p.hash)) {
    p.tries++;
    return json({ error: "That code isn't right. Check the email and try again." }, 403);
  }
  pending.delete(key);
  return null;
}
