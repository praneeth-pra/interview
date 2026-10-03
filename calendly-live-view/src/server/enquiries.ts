// Enquiries from the public /enquiry page, with their resumes.
import { type Enquiry, enquiriesStore, pushStore } from "./data";
import { type Srv, json, saveOrUndo, storedFile } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { saveStore } from "./store";
import { PDF_OR_WORD, kindOf, lastDay, readForm, resumes, uploadedName } from "./uploads";
import { EMAIL_RE, normEmail } from "./util";

// the form doesn't mention this limit; a bigger file gets RESUME_TOO_BIG, in the browser and here
const RESUME_MAX = 200 * 1024;
const RESUME_TOO_BIG = "Your resume is larger than 200 KB. Please upload a smaller file.";
// POST /api/enquiry, a multipart form from the /enquiry page. Five enquiries an hour per network address; a hidden
// "website" field that only bots fill in gets a thank-you and is dropped.
export async function receiveEnquiry(req: Request, srv: Srv): Promise<Response> {
  const got = await readForm(req, srv, {
    key: "enquiry",
    maxBytes: RESUME_MAX,
    tooBig: RESUME_TOO_BIG,
    tooMany: "Too many enquiries from this network. Try again in an hour.",
    busy: "We're getting a lot of enquiries right now. Try again tomorrow.",
    sentToday: lastDay(enquiriesStore.data.enquiries),
  });
  if (!got) return json({ ok: true });
  if (got instanceof Response) return got;
  const { form, text } = got;
  const name = text("name", 100);
  const email = normEmail(text("email", 200));
  const phone = text("phone", 20);
  const tech = text("tech", 100);
  const experience = text("experience", 40);
  if (name.length < 2) return json({ error: "Enter your full name." }, 400);
  if (!EMAIL_RE.test(email)) return json({ error: "Enter a valid email address." }, 400);
  const digits = phone.replace(/\D/g, "").length;
  if (digits < 10 || digits > 15 || /[^\d\s+()-]/.test(phone)) return json({ error: "Enter a valid phone number." }, 400);
  if (tech.length < 2) return json({ error: "Tell us the technology you're looking for." }, 400);
  if (!experience) return json({ error: "Choose your years of experience." }, 400);
  const resume = form.get("resume");
  if (!(resume instanceof Blob) || !resume.size) return json({ error: "Add your resume." }, 400);
  if (resume.size > RESUME_MAX) return json({ error: RESUME_TOO_BIG }, 413);
  const bytes = new Uint8Array(await resume.arrayBuffer());
  const kind = kindOf(bytes, PDF_OR_WORD);
  if (!kind) return json({ error: "The resume must be a PDF or Word file." }, 400);
  const id = crypto.randomUUID();
  const original = uploadedName(resume, "resume" + kind.ext);
  const entry: Enquiry = {
    id,
    name,
    email,
    phone,
    tech,
    experience,
    createdAt: new Date().toISOString(),
    resume: { file: id + kind.ext, name: original, type: kind.type, size: bytes.length },
  };
  try {
    await resumes.save(entry.resume.file, bytes);
    enquiriesStore.data.enquiries.push(entry);
    await saveStore(enquiriesStore);
  } catch {
    enquiriesStore.data.enquiries = enquiriesStore.data.enquiries.filter((v) => v.id !== id);
    await resumes.remove(entry.resume.file).catch(() => {});
    return json({ error: "Couldn't save your enquiry. Try again." }, 500);
  }
  console.log("enquiry received (" + enquiriesStore.data.enquiries.length + " in total)");
  broadcastState();
  if (pushStore.data.subs.length)
    void pushAll(
      {
        title: "New enquiry",
        body: name + " \u00B7 " + tech + "\n" + experience,
        tag: "enquiry:" + id,
        url: "/admin?view=enquiries",
      },
      true,
    );
  return json({ ok: true });
}
export const enquiryView = (v: Enquiry) => ({
  id: v.id,
  name: v.name,
  email: v.email,
  phone: v.phone,
  tech: v.tech,
  experience: v.experience,
  createdAt: v.createdAt,
  resume: { name: v.resume.name, size: v.resume.size },
});
// Newest first, for the Enquiries tab.
export const enquiriesList = () => ({
  enquiries: [...enquiriesStore.data.enquiries].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(enquiryView),
});
// An enquiry's resume: opens in the browser, or with download saves as "<candidate> resume.pdf".
export async function resumeFile(id: string, download: boolean): Promise<Response> {
  const v = enquiriesStore.data.enquiries.find((x) => x.id === id);
  const bytes = v && (await resumes.read(v.resume.file));
  if (!v || !bytes) return json({ error: "That resume isn't there any more." }, 404);
  return storedFile(bytes, v.resume, download, v.name, "Candidate", "resume");
}
export async function deleteEnquiry(id: string): Promise<Response> {
  const v = enquiriesStore.data.enquiries.find((x) => x.id === id);
  if (!v) return json({ error: "That enquiry was already deleted." }, 404);
  const prev = enquiriesStore.data.enquiries;
  enquiriesStore.data.enquiries = prev.filter((x) => x !== v);
  const failed = await saveOrUndo(enquiriesStore, () => (enquiriesStore.data.enquiries = prev));
  if (failed) return failed;
  await resumes.remove(v.resume.file).catch(() => {});
  broadcastState();
  return json({ ok: true });
}
// When this admin ("" with sign-in off) last opened Enquiries; with now, it is being opened now.
export async function enquiriesSeen(email: string, now: boolean): Promise<Response> {
  if (now) {
    enquiriesStore.data.seen[email] = new Date().toISOString();
    await saveStore(enquiriesStore).catch(() => {});
  }
  return json({ seenAt: enquiriesStore.data.seen[email] ?? "" });
}
