// The interview invite a candidate uploads with a booking (a screenshot or PDF of the company's invite email), and the
// HR emails and phone numbers read from it (invite-read.ts). Reading runs after the booking is saved, so a slow read
// never holds up the booking; admins see the results in the booking panel.
import { ID_CARD_MAX } from "./config";
import { type Booking, type IdCard, bookingsStore, onboardingStore } from "./data";
import { json, storedFile } from "./http";
import { broadcastState } from "./live";
import { PHOTO_OR_PDF, invites, kindOf, lastDay, mb, uploadedName } from "./uploads";
import { inviteContacts, inviteText } from "./invite-read";
import { saveStore } from "./store";
import { type Fields, isDemo, normEmail } from "./util";

export const INVITE_NEEDED = "Add a screenshot or PDF of your interview invite.";
export type InviteUpload = { ext: string; type: string; name: string; bytes: Uint8Array };
// A booking sent from the booking page as a multipart form: its fields, and the invite (a photo or a PDF, checked by its
// first bytes) when one was attached.
export async function bookingForm(req: Request): Promise<{ fields: Fields; invite: InviteUpload | null } | Response> {
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!(length > 0)) return json({ error: "Bad request." }, 411);
  if (length > ID_CARD_MAX + 64 * 1024) return json({ error: tooBig(), field: "invite" }, 413);
  // at most 100 invites saved in any 24 hours from everyone together, like the other upload forms
  if (lastDay(bookingsStore.data.bookings.filter((b) => b.invite)) >= 100)
    return json({ error: "We're getting a lot of bookings right now. Try again tomorrow." }, 429);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  const fields: Record<string, string> = {};
  form.forEach((v, k) => {
    if (typeof v === "string") fields[k] = v.slice(0, 300);
  });
  const upload = form.get("invite");
  if (!(upload instanceof Blob) || !upload.size) return { fields, invite: null };
  if (upload.size > ID_CARD_MAX) return json({ error: tooBig(), field: "invite" }, 413);
  const bytes = new Uint8Array(await upload.arrayBuffer());
  const kind = kindOf(bytes, PHOTO_OR_PDF);
  if (!kind) return json({ error: "The invite must be a screenshot, a photo or a PDF.", field: "invite" }, 400);
  const name = uploadedName(upload, "invite" + kind.ext);
  return { fields, invite: { ext: kind.ext, type: kind.type, name, bytes } };
}
const tooBig = () => "Your invite file is larger than " + mb(ID_CARD_MAX) + " MB. Please upload a smaller screenshot.";
export const inviteRef = (id: string, u: InviteUpload): IdCard => ({
  file: id + "-invite" + u.ext,
  name: u.name,
  type: u.type,
  size: u.bytes.length,
});

// What the booking page says when the invite doesn't show an HR's email (other than the candidate's own)
export const INVITE_NO_HR =
  "We couldn't find the HR's email in your invite. Upload a screenshot or PDF where the HR's email address is clearly visible.";
// The candidate's own email, phone (from their onboarding form) and name, left out of the HR's contacts.
export function candidate(email: string, name: string) {
  const e = normEmail(email);
  const phone = [...onboardingStore.data.forms].reverse().find((f) => normEmail(f.email) === e)?.phone;
  return { email: e, phone, name };
}
// Reads a booking's invite and saves what it found.
export async function readInvite(b: Booking) {
  if (!b.invite) return;
  const bytes = await invites.read(b.invite.file);
  const text = bytes ? await inviteText(bytes, b.invite.type) : "";
  const found = inviteContacts(text, candidate(b.email, b.name));
  // the booking may have been replaced by a restore while the invite was read
  const now = bookingsStore.data.bookings.find((x) => x.id === b.id);
  if (!now) return;
  Object.assign(now, { hrEmails: found.emails, hrPhones: found.phones, inviteRead: true });
  try {
    await saveStore(bookingsStore);
  } catch {
    return; // the read results show after the next save; the invite itself is safe
  }
  console.log("invite read: " + found.emails.length + " email(s), " + found.phones.length + " phone number(s)");
  broadcastState();
}
// A booking's invite: opens in the browser, or with download saves as "<candidate> interview invite.jpg".
export async function inviteFile(id: string, download: boolean): Promise<Response> {
  const b = bookingsStore.data.bookings.find((x) => x.id === id);
  const bytes = b?.invite ? await invites.read(b.invite.file) : null;
  if (!b?.invite || !bytes) return json({ error: "That file isn't there any more." }, 404);
  return storedFile(bytes, b.invite, download, b.name, "Candidate", "interview invite");
}
// Demo bookings carry no interview invite: on start, the invite of any demo booked before that rule is deleted, with
// the HR details read from it.
export async function dropDemoInvites() {
  if (!bookingsStore.ok) return;
  const demos = bookingsStore.data.bookings.filter((b) => b.invite && isDemo(b.round));
  if (!demos.length) return;
  const before = demos.map((b) => ({ ...b }));
  for (const b of demos) {
    delete b.invite;
    delete b.hrEmails;
    delete b.hrPhones;
    delete b.inviteRead;
  }
  try {
    await saveStore(bookingsStore);
  } catch {
    demos.forEach((b, i) => Object.assign(b, before[i]));
    return;
  }
  for (const b of before) await invites.remove(b.invite!.file).catch(() => {});
  console.log("cleanup: removed the invite from " + demos.length + " demo booking(s): " + demos.map((b) => b.id).join(", "));
}
// When a candidate's onboarding form is deleted, their interview invite screenshots go too, to free the space. The HR
// emails and phone numbers read from them stay on the bookings.
export async function dropInvites(email: string) {
  const mine = bookingsStore.data.bookings.filter((b) => b.invite && normEmail(b.email) === normEmail(email));
  if (!mine.length) return 0;
  const refs = mine.map((b) => b.invite!);
  for (const b of mine) delete b.invite;
  try {
    await saveStore(bookingsStore);
  } catch {
    mine.forEach((b, i) => (b.invite = refs[i]));
    return 0;
  }
  for (const r of refs) await invites.remove(r.file).catch(() => {});
  broadcastState();
  return refs.length;
}
