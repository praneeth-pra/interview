// The interview invite a candidate uploads with a booking (a screenshot or PDF of the company's invite email), and the
// HR emails and phone numbers read from it (invite-read.ts). Reading runs after the booking is saved, so a slow read
// never holds up the booking; admins see the results in the booking panel.
import { DATA_DIR, ID_CARD_MAX } from "./config";
import { type Booking, type IdCard, bookingsStore, onboardingStore } from "./data";
import { json, storedFile } from "./http";
import { broadcastState } from "./live";
import { CARD_KINDS } from "./onboarding";
import { inviteContacts, inviteText } from "./invite-read";
import { saveStore } from "./store";
import { type Fields, normEmail } from "./util";
import { mkdir, rm } from "node:fs/promises";

export const INVITE_NEEDED = "Add a screenshot or PDF of your interview invite.";
export type InviteUpload = { ext: string; type: string; name: string; bytes: Uint8Array };
// The invites are files in DATA_DIR/invites (kept in memory when there is no data folder).
const invitesInMemory = new Map<string, Uint8Array>();
export async function saveInvite(file: string, bytes: Uint8Array) {
  if (!DATA_DIR) return void invitesInMemory.set(file, bytes);
  await mkdir(DATA_DIR + "/invites", { recursive: true });
  await Bun.write(DATA_DIR + "/invites/" + file, bytes);
}
export async function readInviteFile(file: string): Promise<Uint8Array | null> {
  if (!DATA_DIR) return invitesInMemory.get(file) ?? null;
  const f = Bun.file(DATA_DIR + "/invites/" + file);
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}
export async function removeInvite(file: string) {
  if (!DATA_DIR) return void invitesInMemory.delete(file);
  await rm(DATA_DIR + "/invites/" + file, { force: true });
}
// A booking sent from the booking page as a multipart form: its fields, and the invite (a photo or a PDF, checked by its
// first bytes) when one was attached.
export async function bookingForm(req: Request): Promise<{ fields: Fields; invite: InviteUpload | null } | Response> {
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!(length > 0)) return json({ error: "Bad request." }, 411);
  if (length > ID_CARD_MAX + 64 * 1024) return json({ error: tooBig(), field: "invite" }, 413);
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
  const kind = CARD_KINDS.find((k) => k.magic.every((b, i) => bytes[k.at + i] === b));
  if (!kind) return json({ error: "The invite must be a screenshot, a photo or a PDF.", field: "invite" }, 400);
  const name =
    (upload instanceof File ? upload.name : "")
      .replace(/[\u0000-\u001f"\\/]/g, "")
      .trim()
      .slice(-120) || "invite" + kind.ext;
  return { fields, invite: { ext: kind.ext, type: kind.type, name, bytes } };
}
const tooBig = () =>
  "Your invite file is larger than " + Math.round((ID_CARD_MAX / 1048576) * 10) / 10 + " MB. Please upload a smaller screenshot.";
export const inviteRef = (id: string, u: InviteUpload): IdCard => ({
  file: id + "-invite" + u.ext,
  name: u.name,
  type: u.type,
  size: u.bytes.length,
});

// Reads a booking's invite and saves what it found. The candidate's own phone comes from their onboarding form.
export async function readInvite(b: Booking) {
  if (!b.invite) return;
  const bytes = await readInviteFile(b.invite.file);
  const text = bytes ? await inviteText(bytes, b.invite.type) : "";
  const email = normEmail(b.email);
  const phone = [...onboardingStore.data.forms].reverse().find((f) => normEmail(f.email) === email)?.phone;
  const found = inviteContacts(text, { email, phone });
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
  const bytes = b?.invite ? await readInviteFile(b.invite.file) : null;
  if (!b?.invite || !bytes) return json({ error: "That file isn't there any more." }, 404);
  return storedFile(bytes, b.invite, download, b.name, "Candidate", "interview invite");
}
