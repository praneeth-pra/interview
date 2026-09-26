// Emails (sent through Resend) with calendar invites.
import { EMAIL_FROM, EVENT_LOCATION, EVENT_NAME, HOST_EMAILS, HOST_NAME, MEETING_LINK, RESEND_API_KEY, RESEND_URL } from "./config";
import type { Booking } from "./data";
import { manageUrl } from "./links";
import { dayShort, whenText } from "./time";
import { EMAIL_RE } from "./util";

const firstName = (n: string) => (n.split(/[\s,]+/)[0] || "there").slice(0, 40);
const icsEsc = (s: string) =>
  String(s)
    .replace(/[\\;,]/g, (c) => "\\" + c)
    .replace(/\r?\n/g, "\\n");
const icsParam = (s: string) => '"' + String(s).replace(/["\r\n]/g, "") + '"';
const icsTime = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
function icsFold(line: string) {
  let out = "";
  while (line.length > 74) {
    out += line.slice(0, 74) + "\r\n ";
    line = line.slice(74);
  }
  return out + line;
}
function buildIcs(b: Booking, method: "REQUEST" | "CANCEL") {
  const from = (EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? EMAIL_FROM).trim();
  const desc = [
    EVENT_NAME + " with " + HOST_NAME,
    MEETING_LINK && "Join: " + MEETING_LINK,
    b.company && "Company: " + b.company,
    b.round && "Round: " + b.round,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    [
      "BEGIN:VCALENDAR",
      "PRODID:-//booking-form//EN",
      "VERSION:2.0",
      "CALSCALE:GREGORIAN",
      "METHOD:" + method,
      "BEGIN:VEVENT",
      "UID:" + b.id + "@booking-form",
      "SEQUENCE:" + (b.seq ?? 0),
      "DTSTAMP:" + icsTime(new Date().toISOString()),
      "DTSTART:" + icsTime(b.start),
      "DTEND:" + icsTime(b.end),
      "SUMMARY:" + icsEsc(EVENT_NAME + " with " + HOST_NAME),
      "DESCRIPTION:" + icsEsc(desc),
      ...(MEETING_LINK || EVENT_LOCATION ? ["LOCATION:" + icsEsc(MEETING_LINK || EVENT_LOCATION)] : []),
      "ORGANIZER;CN=" + icsParam(HOST_NAME) + ":mailto:" + from,
      "ATTENDEE;CN=" + icsParam(b.name) + ";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:" + b.email,
      "STATUS:" + (method === "CANCEL" ? "CANCELLED" : "CONFIRMED"),
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(icsFold)
      .join("\r\n") + "\r\n"
  );
}
type Attachment = { filename: string; content: string; content_type: string };
type Mail = {
  to: string[];
  subject: string;
  html: string;
  text: string;
  ics?: { method: "REQUEST" | "CANCEL"; body: string };
  replyTo?: string[];
  files?: Attachment[];
};
export async function sendEmail(m: Mail): Promise<boolean> {
  const to = m.to.filter((e) => EMAIL_RE.test(e));
  if (!RESEND_API_KEY || !to.length) return false;
  const attachments: Attachment[] = [
    ...(m.ics
      ? [
          {
            filename: m.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics",
            content: Buffer.from(m.ics.body).toString("base64"),
            content_type: "text/calendar; charset=utf-8; method=" + m.ics.method,
          },
        ]
      : []),
    ...(m.files ?? []),
  ];
  try {
    const r = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        ...(m.replyTo?.length ? { reply_to: m.replyTo } : {}),
        ...(attachments.length ? { attachments } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) console.log("email sent: " + m.subject.split(":")[0] + " (" + to.length + " recipient" + (to.length === 1 ? "" : "s") + ")");
    else console.log("email failed (" + r.status + "): " + (await r.text()).slice(0, 300));
    return r.ok;
  } catch (e) {
    console.log("email failed: " + String(e));
    return false;
  }
}
export function emailBody(o: {
  heading: string;
  intro: string;
  rows: [string, string][];
  buttons?: { label: string; href: string; primary?: boolean }[];
  note?: string;
}) {
  const e = (s: string) => Bun.escapeHTML(s);
  const rows = o.rows.filter((r) => r[1]);
  const rowHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 18px 6px 0;color:#6b6b6b;vertical-align:top;white-space:nowrap">${e(k)}</td><td style="padding:6px 0;color:#1a1a1a;font-weight:600">${e(v)}</td></tr>`,
    )
    .join("");
  const btns = (o.buttons ?? [])
    .map(
      (b) =>
        `<a href="${e(b.href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 22px;border-radius:40px;text-decoration:none;font-weight:600;font-size:15px;${b.primary ? "background:#006bff;color:#ffffff" : "border:1px solid #b2b2b2;color:#1a1a1a"}">${e(b.label)}</a>`,
    )
    .join("");
  const html =
    `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e6e6e6;border-radius:10px;padding:28px">` +
    `<h1 style="margin:0 0 8px;font-size:20px">${e(o.heading)}</h1><p style="margin:0 0 20px;color:#555555;font-size:15px;line-height:1.5">${e(o.intro)}</p>` +
    `<table role="presentation" style="border-collapse:collapse;font-size:15px;margin:0 0 22px">${rowHtml}</table>` +
    (btns ? `<div>${btns}</div>` : "") +
    (o.note ? `<p style="margin:16px 0 0;color:#888888;font-size:13px;line-height:1.5">${e(o.note)}</p>` : "") +
    `</div></body></html>`;
  const text = [
    o.heading,
    "",
    o.intro,
    "",
    ...rows.map(([k, v]) => k + ": " + v),
    "",
    ...(o.buttons ?? []).map((b) => b.label + ": " + b.href),
    ...(o.note ? ["", o.note] : []),
  ].join("\n");
  return { html, text };
}
const candidateRows = (b: Booking): [string, string][] => [
  ["What", EVENT_NAME + " with " + HOST_NAME],
  ["When", whenText(b.start, b.end)],
  ["Length", b.duration + " minutes"],
  ["Where", MEETING_LINK || EVENT_LOCATION],
];
const hostRows = (b: Booking): [string, string][] => [
  ["Candidate", b.name + " <" + b.email + ">"],
  ["When", whenText(b.start, b.end)],
  ["Company", b.company],
  ["Round", b.round],
];
const MANAGE_NOTE = "Please don't forward this email. Its links can change your booking.";
export function notifyBooked(b: Booking, base: string) {
  const link = manageUrl(base, b);
  const c = emailBody({
    heading: "Your interview is confirmed",
    intro: "Hi " + firstName(b.name) + ", you're booked with " + HOST_NAME + ". The calendar invite is attached.",
    rows: candidateRows(b),
    buttons: [
      { label: "Reschedule", href: link + "&a=reschedule" },
      { label: "Cancel", href: link + "&a=cancel" },
    ],
    note: MANAGE_NOTE,
  });
  void sendEmail({
    to: [b.email],
    subject: "Confirmed: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start),
    ...c,
    ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") },
    replyTo: HOST_EMAILS,
  });
  if (!HOST_EMAILS.length) return;
  const h = emailBody({
    heading: "New booking",
    intro: b.name + " booked a " + b.duration + " minute " + EVENT_NAME.toLowerCase() + ".",
    rows: hostRows(b),
    buttons: [{ label: "Open calendar", href: base + "/admin", primary: true }],
  });
  void sendEmail({
    to: HOST_EMAILS,
    subject: "New booking: " + b.name + " \u2013 " + dayShort(b.start),
    ...h,
    ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") },
    replyTo: [b.email],
  });
}
export function notifyRescheduled(b: Booking, prevStart: string, prevEnd: string, base: string) {
  const link = manageUrl(base, b);
  const was: [string, string] = ["Was", whenText(prevStart, prevEnd)];
  const c = emailBody({
    heading: "Your interview has moved",
    intro:
      b.rescheduledBy === "host"
        ? "Hi " +
          firstName(b.name) +
          ", " +
          HOST_NAME +
          " moved your " +
          EVENT_NAME.toLowerCase() +
          " to the time below. The updated invite is attached."
        : "Hi " +
          firstName(b.name) +
          ", your " +
          EVENT_NAME.toLowerCase() +
          " with " +
          HOST_NAME +
          " is now at the time below. The updated invite is attached.",
    rows: [...candidateRows(b), was],
    buttons: [
      { label: "Reschedule", href: link + "&a=reschedule" },
      { label: "Cancel", href: link + "&a=cancel" },
    ],
    note: MANAGE_NOTE,
  });
  void sendEmail({
    to: [b.email],
    subject: "Updated: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start),
    ...c,
    ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") },
    replyTo: HOST_EMAILS,
  });
  if (!HOST_EMAILS.length) return;
  const h = emailBody({
    heading: "Booking rescheduled",
    intro:
      b.rescheduledBy === "host"
        ? "You moved " + b.name + "'s " + EVENT_NAME.toLowerCase() + "."
        : b.name + " moved their " + EVENT_NAME.toLowerCase() + ".",
    rows: [...hostRows(b), was],
    buttons: [{ label: "Open calendar", href: base + "/admin", primary: true }],
  });
  void sendEmail({
    to: HOST_EMAILS,
    subject: "Rescheduled: " + b.name + " \u2013 " + dayShort(b.start),
    ...h,
    ics: { method: "REQUEST", body: buildIcs(b, "REQUEST") },
    replyTo: [b.email],
  });
}
export function notifyCancelled(b: Booking, base: string) {
  const byHost = b.cancelledBy === "host";
  const c = emailBody({
    heading: "Your interview is cancelled",
    intro: byHost
      ? "Hi " +
        firstName(b.name) +
        ", " +
        HOST_NAME +
        " cancelled your " +
        EVENT_NAME.toLowerCase() +
        ". Reply to this email if you have questions."
      : "Hi " + firstName(b.name) + ", your " + EVENT_NAME.toLowerCase() + " with " + HOST_NAME + " is cancelled, as you asked.",
    rows: [
      ["What", EVENT_NAME + " with " + HOST_NAME],
      ["When", whenText(b.start, b.end)],
      ["Reason", byHost ? (b.cancelReason ?? "") : ""],
    ],
    buttons: [{ label: "Book a new time", href: base + "/booking", primary: true }],
  });
  void sendEmail({
    to: [b.email],
    subject: "Cancelled: " + EVENT_NAME + " with " + HOST_NAME + " \u2013 " + dayShort(b.start),
    ...c,
    ics: { method: "CANCEL", body: buildIcs(b, "CANCEL") },
    replyTo: HOST_EMAILS,
  });
  if (!HOST_EMAILS.length) return;
  const h = emailBody({
    heading: "Booking cancelled",
    intro: byHost
      ? "You cancelled " + b.name + "'s " + EVENT_NAME.toLowerCase() + " from the admin calendar."
      : b.name + " cancelled their " + EVENT_NAME.toLowerCase() + ".",
    rows: [...hostRows(b), ["Reason", b.cancelReason ?? ""]],
  });
  void sendEmail({
    to: HOST_EMAILS,
    subject: "Cancelled: " + b.name + " \u2013 " + dayShort(b.start),
    ...h,
    ics: { method: "CANCEL", body: buildIcs(b, "CANCEL") },
    replyTo: [b.email],
  });
}
