// Enquiries from the public /enquiry page, with their resumes.
import { DATA_DIR } from "./config";
import { type Enquiry, enquiriesStore, pushStore } from "./data";
import { type Srv, json, underLimit, clientIp } from "./http";
import { broadcastState } from "./live";
import { pushAll } from "./push";
import { saveStore } from "./store";
import { EMAIL_RE, normEmail } from "./util";
import { mkdir, rm } from "node:fs/promises";

// the form doesn't mention this limit; a bigger file gets RESUME_TOO_BIG, in the browser and here
const RESUME_MAX = 200 * 1024;
const RESUME_TOO_BIG = "Your resume is larger than 200 KB. Please upload a smaller file.";
const ENQUIRIES_PER_DAY = 100;
// what the first bytes of each allowed kind of file look like
const RESUME_KINDS = [
  { ext: ".pdf", type: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  { ext: ".docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", magic: [0x50, 0x4b, 0x03, 0x04] },
  { ext: ".doc", type: "application/msword", magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
];
const resumesInMemory = new Map<string, Uint8Array>();
async function saveResume(file: string, bytes: Uint8Array) {
  if (!DATA_DIR) return void resumesInMemory.set(file, bytes);
  await mkdir(DATA_DIR + "/resumes", { recursive: true });
  await Bun.write(DATA_DIR + "/resumes/" + file, bytes);
}
export async function readResume(file: string): Promise<Uint8Array | null> {
  if (!DATA_DIR) return resumesInMemory.get(file) ?? null;
  const f = Bun.file(DATA_DIR + "/resumes/" + file);
  return (await f.exists()) ? new Uint8Array(await f.arrayBuffer()) : null;
}
export async function removeResume(file: string) {
  if (!DATA_DIR) return void resumesInMemory.delete(file);
  await rm(DATA_DIR + "/resumes/" + file, { force: true });
}
// POST /api/enquiry, a multipart form from the /enquiry page. Five enquiries an hour per network address; a hidden
// "website" field that only bots fill in gets a thank-you and is dropped.
export async function receiveEnquiry(req: Request, srv: Srv): Promise<Response> {
  const ip = clientIp(req, srv);
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) return json({ error: "Bad request." }, 415);
  const length = Number(req.headers.get("content-length") ?? NaN);
  if (!(length > 0)) return json({ error: "Bad request." }, 411);
  if (length > RESUME_MAX + 64 * 1024) return json({ error: RESUME_TOO_BIG }, 413);
  if (!underLimit("enquiry:" + ip, 5, 3600000)) return json({ error: "Too many enquiries from this network. Try again in an hour." }, 429);
  // and at most 100 saved in any 24 hours from everyone together, so a flood of fake ones can't fill the disk with resumes
  const lastDay = enquiriesStore.data.enquiries.filter((v) => Date.parse(v.createdAt) > Date.now() - 86400000).length;
  if (lastDay >= ENQUIRIES_PER_DAY) return json({ error: "We're getting a lot of enquiries right now. Try again tomorrow." }, 429);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Bad request." }, 400);
  }
  const text = (k: string, max: number) =>
    String(form.get(k) ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  if (text("website", 200)) return json({ ok: true });
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
  const kind = RESUME_KINDS.find((k) => k.magic.every((b, i) => bytes[i] === b));
  if (!kind) return json({ error: "The resume must be a PDF or Word file." }, 400);
  const id = crypto.randomUUID();
  const original =
    (resume instanceof File ? resume.name : "")
      .replace(/[\u0000-\u001f"\\/]/g, "")
      .trim()
      .slice(-120) || "resume" + kind.ext;
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
    await saveResume(entry.resume.file, bytes);
    enquiriesStore.data.enquiries.push(entry);
    await saveStore(enquiriesStore);
  } catch {
    enquiriesStore.data.enquiries = enquiriesStore.data.enquiries.filter((v) => v.id !== id);
    await removeResume(entry.resume.file).catch(() => {});
    return json({ error: "Couldn't save your enquiry. Try again." }, 500);
  }
  console.log("enquiry received (" + enquiriesStore.data.enquiries.length + " in total)");
  broadcastState();
  if (pushStore.data.subs.length)
    void pushAll({
      title: "New enquiry",
      body: name + " \u00B7 " + tech + "\n" + experience,
      tag: "enquiry:" + id,
      url: "/admin?view=enquiries",
    });
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
