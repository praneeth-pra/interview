// Onboarding forms from the public /onboarding page: the candidate's details with photos or PDFs of their Aadhaar and PAN
// cards. These are ID documents, so only owners see them (like enquiries and payments). It's the way in for candidates:
// a form is accepted only from an email with a confirmed payment, and accepting it adds the email to the Candidates
// list, so they can book.
import { allowEmail } from "./allowlist";
import { ID_CARD_MAX } from "./config";
import { type IdCard, type Onboarding, onboardingStore, paymentStatus, pushStore } from "./data";
import { type Srv, json, saveOrUndo, storedFile } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { saveStore } from "./store";
import { PHOTO_OR_PDF, idCards, kindOf, lastDay, mb, readForm, uploadedName } from "./uploads";
import { EMAIL_RE, normEmail } from "./util";

// the form doesn't mention this limit (it shrinks big photos first); a bigger file gets this answer, in the browser and here
const tooBig = (card: string) => "Your " + card + " file is larger than " + mb(ID_CARD_MAX) + " MB. Please upload a smaller file.";
export const CARDS = { aadhaar: "Aadhaar card", pan: "PAN card" } as const;
export type Card = keyof typeof CARDS;
// The LinkedIn profile as a full https address on linkedin.com, or "" when what was typed isn't one.
export function linkedinUrl(typed: string): string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(typed) ? typed : "https://" + typed);
  } catch {
    return "";
  }
  if (!/^([a-z]{2,3}\.)?linkedin\.com$/i.test(url.hostname) || url.pathname.length < 2) return "";
  return "https://" + url.hostname.toLowerCase() + url.pathname + url.search;
}
// POST /api/onboarding, a multipart form from the /onboarding page. Five an hour per network address and 100 a day in
// all; a hidden "website" field that only bots fill in gets a thank-you and is dropped.
export async function receiveOnboarding(req: Request, srv: Srv): Promise<Response> {
  const got = await readForm(req, srv, {
    key: "onboarding",
    maxBytes: 2 * ID_CARD_MAX,
    tooBig: "Your files are too large. Please upload smaller ones.",
    tooMany: "Too many forms from this network. Try again in an hour.",
    busy: "We're getting a lot of forms right now. Try again tomorrow.",
    sentToday: lastDay(onboardingStore.data.forms),
  });
  if (!got) return json({ ok: true });
  if (got instanceof Response) return got;
  const { form, text } = got;
  const name = text("name", 100);
  const email = normEmail(text("email", 200));
  const phone = text("phone", 20);
  const tech = text("tech", 100);
  const experience = text("experience", 40);
  const genuine = text("genuine", 3);
  const linkedin = linkedinUrl(text("linkedin", 200));
  if (name.length < 2) return json({ error: "Enter your full name.", field: "name" }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address.", field: "email" }, 400);
  const digits = phone.replace(/\D/g, "").length;
  if (digits < 10 || digits > 15 || /[^\d\s+()-]/.test(phone)) return json({ error: "Enter a valid phone number.", field: "phone" }, 400);
  if (tech.length < 2) return json({ error: "Tell us your technology.", field: "tech" }, 400);
  if (!experience) return json({ error: "Choose your years of experience.", field: "experience" }, 400);
  if (genuine !== "yes" && genuine !== "no")
    return json({ error: "Tell us whether your recent experience is genuine.", field: "genuine" }, 400);
  if (!linkedin) return json({ error: "Enter your LinkedIn profile link, like linkedin.com/in/your-name.", field: "linkedin" }, 400);
  const paid = paymentStatus(email);
  if (paid === "pending")
    return json(
      { error: "We're still checking your payment. Please send this form once it's confirmed.", field: "email", payment: paid },
      403,
    );
  if (paid === "none")
    return json({ error: "We couldn't find a payment from this email. Use the email you paid with.", field: "email", payment: paid }, 403);
  const id = crypto.randomUUID();
  const files: Partial<Record<Card, { ref: IdCard; bytes: Uint8Array }>> = {};
  for (const card of Object.keys(CARDS) as Card[]) {
    const upload = form.get(card);
    if (!(upload instanceof Blob) || !upload.size) return json({ error: "Add your " + CARDS[card] + ".", field: card }, 400);
    if (upload.size > ID_CARD_MAX) return json({ error: tooBig(CARDS[card]), field: card }, 413);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const kind = kindOf(bytes, PHOTO_OR_PDF);
    if (!kind) return json({ error: "Your " + CARDS[card] + " must be a photo or a PDF.", field: card }, 400);
    const original = uploadedName(upload, card + kind.ext);
    files[card] = { ref: { file: id + "-" + card + kind.ext, name: original, type: kind.type, size: bytes.length }, bytes };
  }
  const entry: Onboarding = {
    id,
    name,
    email,
    phone,
    tech,
    experience,
    genuine: genuine as "yes" | "no",
    linkedin,
    createdAt: new Date().toISOString(),
    aadhaar: files.aadhaar!.ref,
    pan: files.pan!.ref,
  };
  try {
    for (const f of Object.values(files)) await idCards.save(f.ref.file, f.bytes);
    onboardingStore.data.forms.push(entry);
    await saveStore(onboardingStore);
  } catch {
    onboardingStore.data.forms = onboardingStore.data.forms.filter((v) => v.id !== id);
    for (const f of Object.values(files)) await idCards.remove(f.ref.file).catch(() => {});
    return json({ error: "Couldn't save your details. Try again." }, 500);
  }
  // the form is saved either way; if the list is full or can't be saved, an owner adds the email by hand
  if (!(await allowEmail(email))) console.error("onboarding: couldn't add the email to the Candidates list");
  console.log("onboarding form received (" + onboardingStore.data.forms.length + " in total)");
  broadcastState();
  if (pushStore.data.subs.length)
    void pushAll(
      {
        title: "New onboarding",
        body: name + " · " + tech + "\n" + experience,
        tag: "onboarding:" + id,
        url: "/admin?view=onboarding",
      },
      true,
    );
  return json({ ok: true });
}
const cardView = (c: IdCard) => ({ name: c.name, type: c.type, size: c.size });
// Newest first, for the Onboarding sheet (⋯ menu); reversed first, so two sent in the same millisecond list the later first.
export const onboardingList = () => ({
  forms: [...onboardingStore.data.forms]
    .reverse()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map((v) => ({
      id: v.id,
      name: v.name,
      email: v.email,
      phone: v.phone,
      tech: v.tech,
      experience: v.experience,
      genuine: v.genuine ?? "",
      linkedin: v.linkedin ?? "",
      createdAt: v.createdAt,
      aadhaar: cardView(v.aadhaar),
      pan: cardView(v.pan),
    })),
});
// One of a form's cards: opens in the browser, or with download saves as "<candidate> Aadhaar card.jpg".
export async function idCardFile(id: string, card: string, download: boolean): Promise<Response> {
  const v = onboardingStore.data.forms.find((x) => x.id === id);
  if (!v || !Object.hasOwn(CARDS, card)) return json({ error: "That file isn't there any more." }, 404);
  const ref = v[card as Card];
  const bytes = await idCards.read(ref.file);
  if (!bytes) return json({ error: "That file isn't there any more." }, 404);
  return storedFile(bytes, ref, download, v.name, "Candidate", CARDS[card as Card]);
}
export async function deleteOnboarding(id: string): Promise<Response> {
  const v = onboardingStore.data.forms.find((x) => x.id === id);
  if (!v) return json({ error: "That form was already deleted." }, 404);
  const prev = onboardingStore.data.forms;
  onboardingStore.data.forms = prev.filter((x) => x !== v);
  const failed = await saveOrUndo(onboardingStore, () => (onboardingStore.data.forms = prev));
  if (failed) return failed;
  for (const c of Object.keys(CARDS) as Card[]) await idCards.remove(v[c].file).catch(() => {});
  broadcastState();
  return json({ ok: true });
}
