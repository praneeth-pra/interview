import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { inviteContacts, inviteText } from "../src/server/invite-read";

// Reading the HR's email and phone from an interview invite. tests/invites holds a made-up invite email screenshot; CI
// installs tesseract and pdftotext as the Docker image does.
describe("HR contacts in an invite", () => {
  test("emails, leaving out the candidate's own and no-reply senders", () => {
    const text = "From: Priya <Priya.Sharma@Infosys.com>\nnoreply@naukri.com\nto ravi@gmail.com\nhr@wipro.com. Thanks";
    expect(inviteContacts(text, { email: "Ravi@gmail.com" }).emails).toEqual(["priya.sharma@infosys.com", "hr@wipro.com"]);
    expect(inviteContacts("a@x.com b@x.com c@x.com d@x.com a@x.com").emails).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(inviteContacts("calendar-notification@google.com do-not-reply@teams.microsoft.com x@hi-techie.dev").emails).toEqual([]);
  });

  test("the candidate's own address misread by OCR, or a personal one named after them, isn't the HR's", () => {
    const own = { email: "ravi.kumar@gmail.com", name: "Ravi Kumar" };
    const text = "To: rav1kumar@gmai1.com, ravi.k.work@yahoo.com; From: hr.team@infosys.com, ravi@infosys.com";
    expect(inviteContacts(text, own).emails).toEqual(["hr.team@infosys.com", "ravi@infosys.com"]);
  });
  test("mobile numbers in the ways people write them, but not meeting ids, dial-ins or the candidate's own", () => {
    const phones = (t: string, own?: string) => inviteContacts(t, { phone: own }).phones;
    expect(phones("Mobile: +91 98450 12345")).toEqual(["+91 98450 12345"]);
    expect(phones("call 9845012345 or 09845-012-346")).toEqual(["+91 98450 12345", "+91 98450 12346"]);
    expect(phones("+91-(984) 501 2345")).toEqual(["+91 98450 12345"]);
    expect(phones("Meeting ID: 412 845 977 301\nPasscode 9845012345\nDial-in +91 22 6000 1234")).toEqual([]);
    // landlines only where the line says it's a phone number
    expect(phones("Ref 2234 567 890")).toEqual([]);
    expect(phones("Phone: 022 3456 7890")).toEqual(["+91 22345 67890"]);
    expect(phones("Mobile 98450 12345", "+91 98450-12345")).toEqual([]);
    // dates, links and longer numbers are not phone numbers
    expect(phones("08/10/2026 11:00 https://x.com/9845012345 1234567890123456")).toEqual([]);
  });

  test("the made-up invite screenshot gives the recruiter's email and mobile", async () => {
    const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, "invites/infosys-invite.png")).arrayBuffer());
    const text = await inviteText(bytes, "image/png");
    expect(inviteContacts(text, { email: "ravi.kumar@gmail.com" })).toEqual({
      emails: ["priya.sharma@infosys.com"],
      phones: ["+91 98450 12345"],
    });
  });
});
