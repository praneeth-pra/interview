// Reading an interview invite: its text (pdftotext for PDFs, tesseract OCR for pictures, on this server like receipts)
// and the HR emails and phone numbers in it.
import { nameDistance, normalizeName } from "../same-name";
import { receiptText } from "./receipt-check";

// The invite's text: a PDF's own text, or both of the receipt reader's OCR passes over a picture.
export async function inviteText(bytes: Uint8Array, type: string) {
  return (await receiptText(bytes, type, 0)) + "\n" + (await receiptText(bytes, type, 1));
}
// Addresses that send mail but aren't a person: no-reply senders, calendar and meeting services, and this site.
const NOT_HR =
  /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|notifications?|calendar|invites?|meetings?|alerts?)[@.+-]|@(.*\.)?(hi-techie\.dev|google\.com|zoom\.us|microsoft\.com|teams\.microsoft\.com|calendly\.com|naukri\.com|webex\.com)$/i;
// Lines about joining a meeting (ids, passcodes, dial-in numbers) don't hold the HR's phone number.
const MEETING_LINE = /meeting\s*id|conference\s*id|passcode|password|\bpin\b|dial[\s-]?in|toll|webinar\s*id|access\s*code/i;
const PHONE_WORD = /phone|mobile|\bmob\b|\bph\b|\btel\b|contact|call|whats\s*app|\bcell\b/i;
// Whether the invite can be read here: a PDF with pdftotext, a picture with tesseract (not a HEIC photo). One that
// can't be read is accepted and left for an admin to look at.
export function inviteReadable(type: string) {
  if (type === "application/pdf") return !!Bun.which("pdftotext");
  return type !== "image/heic" && !!Bun.which("tesseract");
}
// Invites are sent to the candidate, so their own address is often in it, sometimes misread by OCR (0 for o, rn for
// m, a dot dropped) or a second address of theirs. Folded, addresses compare without dots, +tags and look-alikes.
const fold = (email: string) => {
  const [local, domain = ""] = email.toLowerCase().split("@");
  const same = (part: string) => part.replace(/0/g, "o").replace(/[1i|]/g, "l").replace(/rn/g, "m").replace(/5/g, "s");
  return same(local.split("+")[0].replace(/[._-]/g, "")) + "@" + same(domain);
};
const PERSONAL_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|icloud|rediffmail|protonmail|aol)\.[a-z.]+$/i;
function candidatesOwn(email: string, own: { email?: string; name?: string }) {
  const mine = (own.email ?? "").trim().toLowerCase();
  if (mine) {
    if (email === mine || fold(email) === fold(mine)) return true;
    if (fold(mine).length >= 10 && nameDistance(fold(email), fold(mine)) <= 2) return true;
  }
  // a personal address named after the candidate ("sravani.k@gmail.com" for Sravani K) is theirs, not the HR's
  if (PERSONAL_MAIL.test(email)) {
    const local = email.split("@")[0].replace(/[^a-z]/g, "");
    return normalizeName(own.name ?? "")
      .split(" ")
      .some((word) => word.length >= 4 && local.includes(word));
  }
  return false;
}
// The HR emails and phone numbers in an invite's text, at most three of each, leaving out the candidate's own.
// Mobile numbers (10 digits from 6 to 9, with or without +91 or 0) count anywhere; other 10-digit numbers (landlines)
// only on a line that says phone, mobile, contact and the like.
export function inviteContacts(text: string, own: { email?: string; phone?: string; name?: string } = {}) {
  const emails: string[] = [];
  for (const m of text.matchAll(/[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi)) {
    const email = m[0].replace(/[.]+$/, "").toLowerCase();
    if (!candidatesOwn(email, own) && !NOT_HR.test(email) && !emails.includes(email)) emails.push(email);
  }
  const phones: string[] = [];
  const ownPhone = (own.phone ?? "").replace(/\D/g, "").slice(-10);
  for (const line of text.split("\n")) {
    if (MEETING_LINE.test(line)) continue;
    // digits with spaces, dashes, dots or brackets between them, not part of a longer number, an email or a link
    for (const m of line.matchAll(/(?<![\w@./:])\+?\(?\d[\d\s().-]{8,16}\d(?![\w@])/g)) {
      let digits = m[0].replace(/\D/g, "");
      if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
      else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
      if (digits.length !== 10 || digits === ownPhone) continue;
      if (!/^[6-9]/.test(digits) && !PHONE_WORD.test(line)) continue;
      const shown = "+91 " + digits.slice(0, 5) + " " + digits.slice(5);
      if (!phones.includes(shown)) phones.push(shown);
    }
  }
  return { emails: emails.slice(0, 3), phones: phones.slice(0, 3) };
}
