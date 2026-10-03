// Deleting an onboarding form needs a code emailed to the owner who asked (the sign-in code helpers, keyed by owner and
// form). With sign-in off (local runs only) there is no owner email to send to, so no code is asked.
import { CODE_MINUTES, checkCode, newCode } from "./auth";
import { HOST_NAME, LOGIN_ON, RESEND_API_KEY } from "./config";
import { onboardingStore } from "./data";
import { emailBody, sendEmail } from "./email";
import { json, underLimit } from "./http";

const keyOf = (owner: string, id: string) => "delete:" + owner + ":" + id;
// "in…@hi-techie.dev": enough to recognise the inbox in the admin page
const masked = (email: string) => email.replace(/^(.{1,2})[^@]*/, "$1…");

// POST /admin/api/onboarding/delete-code {id}: five codes an hour per owner
export async function sendDeleteCode(id: string, owner: string): Promise<Response> {
  const form = onboardingStore.data.forms.find((x) => x.id === id);
  if (!form) return json({ error: "That form was already deleted." }, 404);
  if (!LOGIN_ON || !owner) return json({ needed: false });
  if (!underLimit("delete-code:" + owner, 5, 3600000)) return json({ error: "Too many codes asked for. Try again in an hour." }, 429);
  const code = newCode(keyOf(owner, id));
  if (!RESEND_API_KEY) console.log("delete code for " + owner + ": " + code + " (email is off, so it is only shown here)");
  else {
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
      note: "Deleting removes the form, the Aadhaar and PAN cards and the candidate's interview invite screenshots. If you didn't ask for this, sign out your devices.",
    });
    if (!(await sendEmail({ to: [owner], subject: "Delete code: " + code, ...body })))
      return json({ error: "Couldn't send the code. Try again." }, 502);
  }
  return json({ needed: true, to: masked(owner) });
}
// null when the code is right for this owner and form (or none is needed), else the answer to send
export function checkDeleteCode(id: string, owner: string, code: string): Response | null {
  if (!LOGIN_ON || !owner) return null;
  const r = checkCode(keyOf(owner, id), code);
  if (r === "ok") return null;
  if (r === "wrong") return json({ error: "That code isn't right. Check the email and try again." }, 403);
  return json({ error: "That code has expired. Ask for a new one." }, 403);
}
