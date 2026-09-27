// The booked screen: the confirmation, a calendar file and a way to book another round.
import { el } from "../shared/dom";
import { ICONS } from "./icons";
import { formatRange } from "./time";
import { card, eventName, hostName, setState, state } from "./app";
import { loadDays } from "./slots";
import type { Booking } from "./types";

function icsLink(booking: Booking) {
  function icsTime(iso: string) {
    return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  }
  function icsText(text: string) {
    return String(text)
      .replace(/[\\;,]/g, function (ch) {
        return "\\" + ch;
      })
      .replace(/\n/g, "\\n");
  }
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//booking-form//EN",
    "BEGIN:VEVENT",
    "UID:" + booking.id + "@booking-form",
    "DTSTAMP:" + icsTime(new Date().toISOString()),
    "DTSTART:" + icsTime(booking.start),
    "DTEND:" + icsTime(booking.end),
    "SUMMARY:" + icsText(eventName + " with " + hostName),
    "DESCRIPTION:" + icsText([booking.company, booking.round].filter(Boolean).join(", ")),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join(`\r
`);
  return "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
}
export function renderDone() {
  const booking = state.booking!;
  const startMs = Date.parse(booking.start);
  const section = el("section", {
    class: "done",
  });
  const inner = el("div", {
    class: "done-in",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "logo",
        "aria-hidden": "true",
      },
      [],
    ),
  );
  inner.appendChild(
    el("h1", {
      html: ICONS.check + "<span>You are scheduled</span>",
    }),
  );
  inner.appendChild(
    el("p", null, [
      "Your " +
        booking.duration +
        " minute " +
        eventName.toLowerCase() +
        " is booked. " +
        (booking.emailed ? "A calendar invite is on its way to " + booking.email + "." : "Add it to your calendar so it doesn't slip."),
    ]),
  );
  const meta = el("ul", {
    class: "meta",
  });
  function item(icon: string, text: string, highlight?: boolean) {
    const li = el("li", {
      class: highlight ? "hl" : null,
      html: icon + "<span></span>",
    });
    li.lastChild!.textContent = text;
    return li;
  }
  meta.appendChild(item(ICONS.user, hostName));
  meta.appendChild(item(ICONS.cal, formatRange(startMs, booking.duration), true));
  meta.appendChild(item(ICONS.globe, "India Standard Time"));
  inner.appendChild(
    el(
      "div",
      {
        class: "box",
      },
      [
        el(
          "h2",
          {
            class: "ev",
          },
          [eventName],
        ),
        meta,
      ],
    ),
  );
  const addToCalendar = el("a", {
    class: "pill",
    href: icsLink(booking),
    download: "interview.ics",
    html: ICONS.add + "<span>Add to calendar</span>",
  });
  inner.appendChild(
    el(
      "div",
      {
        class: "acts",
      },
      [
        addToCalendar,
        booking.manage
          ? el(
              "a",
              {
                class: "pill",
                href: booking.manage,
              },
              ["Reschedule or cancel"],
            )
          : null,
        el(
          "button",
          {
            type: "button",
            class: "pill",
            onclick: function () {
              setState({
                dur: state.dur,
                days: [],
                openSet: {},
                viewY: 0,
                viewM: 0,
                date: null,
                slots: null,
                slot: null,
                step: "pick",
                booking: null,
                err: "",
                fieldErr: {},
                form: {
                  name: booking.name,
                  email: booking.email,
                  company: "",
                  round: "",
                },
                busy: false,
              });
              loadDays();
            },
          },
          ["Book another time"],
        ),
      ],
    ),
  );
  section.appendChild(inner);
  card.appendChild(section);
}
