// The booking panel: one interview's details, its supporter, how it went and its result, and cancelling or moving it.
import { byId, el, onEnterOrSpace, setMessage, toast } from "./dom";
import { addDays, dayKeyOf, formatIst, formatRange, formatTime, shortDate, timeAgo, weekStart } from "./time";
import { type RoundStatus, byWhom, plural, rating10, roundStatus, statusPill, titleCase } from "./labels";
import { request } from "./api";
import { colorClass, render, state, view } from "./state";
import { closePanel, icon, initials, openPanel, panel, setPanelAvatar, setPanelLink } from "./panel";
import { shareOnTap } from "./share";
import type { Booking } from "./types";
import { allBookings, findBooking, loadAllBookings } from "./bookings";
import { sameCompany } from "../../same-company";

// Another booking the same interviewer has at an overlapping time.
function clashFor(booking: Booking, interviewer: string) {
  if (!interviewer) {
    return "";
  }
  const start = Date.parse(booking.start);
  const end = Date.parse(booking.end);
  for (let index = 0; index < state.events.length; index++) {
    const other = state.events[index];
    if (
      other.id !== booking.id &&
      state.iv.assign[other.id] === interviewer &&
      Date.parse(other.start) < end &&
      Date.parse(other.end) > start
    ) {
      return titleCase(other.name) + " at " + formatTime(new Date(other.start));
    }
  }
  return "";
}
function saveInterviewer(booking: Booking, name: string, msg: HTMLElement) {
  const change: Record<string, string> = {};
  change[booking.id] = name;
  setMessage(msg, "Saving…");
  request(
    "/admin/api/interviewers",
    {
      set: change,
    },
    "PUT",
  )
    .then(function () {
      toast(name ? "Supporter saved" : "Supporter cleared");
    })
    .catch(function (error) {
      setMessage(msg, error.message, true);
    });
}
// "in 2 days", "in 3 hours", "in 20 min"
function untilText(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) {
    return "in " + Math.max(1, minutes) + " min";
  } else if (minutes < 24 * 60) {
    return "in " + plural(Math.round(minutes / 60), "hour");
  } else {
    return "in " + plural(Math.round(minutes / 1440), "day");
  }
}
// Once the interview has started, the bottom of the panel offers Rejected and Didn't happen, the way an upcoming one
// offers Reschedule and Cancel. Otherwise it stays Completed until the candidate books the next round with the company,
// which marks it Cleared. With a result set, one button undoes it. Didn't happen isn't offered once interview support
// is recorded, since then it happened.
function resultFoot(booking: Booking, current: RoundStatus | null, supported: boolean) {
  const msg = el("p", { class: "msg", role: "status" });
  const choice = function (label: string, value: string, danger?: boolean) {
    const button = el("button", {
      type: "button",
      class: danger ? "ghost danger-t" : "ghost",
      text: label,
      onclick: function () {
        const ask = value
          ? "Mark " + titleCase(booking.name) + "'s " + (booking.round || "round") + " as " + label + "?"
          : "Take " + current!.label + " off " + titleCase(booking.name) + "'s " + (booking.round || "round") + "?";
        if (!confirm(ask)) {
          return;
        }
        button.disabled = true;
        setMessage(msg, "");
        request("/admin/api/round-status", { id: booking.id, status: value })
          .then(function () {
            toast(value ? "Marked " + label : current!.label + " removed");
          })
          .catch(function (error) {
            button.disabled = false;
            setMessage(msg, error.message, true);
          });
      },
    });
    return button;
  };
  const buttons = current
    ? [choice("Undo " + current.label, "")]
    : [choice("Rejected", "rejected", true), supported ? null : choice("Didn't happen", "other")];
  return el("div", null, [el("div", { class: "bk-foot" }, buttons), msg]);
}
// How the interview went, once it has started: a rating out of 10 and optional notes on any issues (what went wrong).
// Once saved the rating is final (the server refuses another); the notes can still be edited and saved again. The
// panel redraws on every live update, so what's typed but not saved is kept in drafts (and the notes box keeps its focus and caret).
const drafts: Record<string, { rating: number; notes: string }> = {};
// bookings whose rating circles are all showing again (the unsaved pick was tapped), so a redraw keeps them open
const choosing: Record<string, boolean> = {};
function feedbackCard(booking: Booking, caret: number | null) {
  const saved = { rating: booking.rating || 0, notes: booking.feedback || "" };
  const draft = drafts[booking.id] || { rating: saved.rating, notes: saved.notes };
  if (saved.rating) draft.rating = saved.rating;
  // the heading's right side says the score in words ("8/10 · Good")
  const verdict = el("span", { class: "fb-v" });
  const card = el("div", { class: "bk-card fbc" }, [el("div", { class: "fb-head" }, [el("h3", { text: "How did it go?" }), verdict])]);
  const msg = el("p", { class: "msg", role: "status" });
  const group = el("div", { class: "fb-opts", role: "group", "aria-label": "Rating out of 10" });
  const notes = el("textarea", {
    id: "fbnotes",
    maxlength: "1000",
    rows: "3",
    placeholder: "What went wrong, if anything…",
  }) as HTMLTextAreaElement;
  notes.value = draft.notes;
  const save = el("button", { type: "button", class: "pri", text: "Save" }) as HTMLButtonElement;
  const changed = function () {
    if (draft.rating === saved.rating && draft.notes.trim() === saved.notes) {
      delete drafts[booking.id];
    } else {
      drafts[booking.id] = draft;
    }
    save.hidden = !drafts[booking.id];
  };
  // ten circles in a row, the picked one filled in its colour (1 to 4 red, 5 and 6 amber, 7 to 10 green). Once a
  // rating is picked the other circles go away and only it stays; until it's saved, tapping it shows them all again
  // (and tapping it then unpicks it). A saved rating is just the one circle, not a button.
  const buttons: HTMLElement[] = [];
  const scale = el("p", { class: "sub fb-scale", "aria-hidden": "true" }, [
    el("span", { text: "Poor" }),
    el("span", { text: "Excellent" }),
  ]);
  const paint = function () {
    const tone = rating10(draft.rating);
    const shut = !!tone && !choosing[booking.id];
    group.className = "fb-opts" + (tone ? " rs-" + tone.key : "") + (shut ? " one" : "");
    buttons.forEach(function (button, index) {
      button.classList.toggle("on", draft.rating === index + 1);
      button.setAttribute("aria-pressed", String(draft.rating === index + 1));
      button.hidden = shut && draft.rating !== index + 1;
    });
    scale.hidden = shut;
    verdict.className = "fb-v" + (tone ? " rs-" + tone.key : "");
    verdict.textContent = tone ? draft.rating + "/10 · " + tone.word : "";
  };
  if (saved.rating) {
    delete choosing[booking.id];
    group.appendChild(
      el("span", { class: "fb-opt on", role: "img", "aria-label": saved.rating + " out of 10", text: String(saved.rating) }),
    );
  } else {
    for (let value = 1; value <= 10; value++) {
      buttons.push(
        el("button", {
          type: "button",
          class: "fb-opt",
          text: String(value),
          "aria-label": value + " out of 10",
          onclick: function () {
            if (group.classList.contains("one")) {
              choosing[booking.id] = true;
              paint();
              return;
            }
            draft.rating = draft.rating === value ? 0 : value;
            if (draft.rating) {
              delete choosing[booking.id];
            }
            paint();
            setMessage(msg, "");
            changed();
          },
        }),
      );
    }
    buttons.forEach(function (button) {
      group.appendChild(button);
    });
  }
  paint();
  card.appendChild(group);
  card.appendChild(scale);
  notes.addEventListener("input", function () {
    draft.notes = notes.value;
    changed();
  });
  card.appendChild(el("div", { class: "f fb-notes" }, [el("label", { for: "fbnotes", text: "Issues (optional)" }), notes]));
  save.onclick = function () {
    if (!draft.rating) {
      return setMessage(msg, "Pick a rating out of 10.", true);
    }
    save.disabled = true;
    setMessage(msg, "Saving…");
    request("/admin/api/feedback", { id: booking.id, rating: draft.rating, notes: draft.notes.trim() })
      .then(function () {
        delete drafts[booking.id];
        save.hidden = true;
        setMessage(msg, "");
        toast("Feedback saved");
      })
      .catch(function (error) {
        save.disabled = false;
        setMessage(msg, error.message, true);
      });
  };
  // a redraw from the save's own live update can land before its reply, with the draft now matching what's saved
  changed();
  card.appendChild(
    el("div", { class: "fb-foot" }, [
      save,
      el("span", {
        class: "sub",
        text: booking.feedbackAt
          ? "Saved " + timeAgo(booking.feedbackAt) + (booking.feedbackBy ? " by " + booking.feedbackBy : "")
          : "Not rated yet",
      }),
    ]),
  );
  card.appendChild(msg);
  if (caret !== null) {
    // put the caret back once the card is on the page
    requestAnimationFrame(function () {
      notes.focus();
      notes.setSelectionRange(caret, caret);
    });
  }
  return card;
}
// the invite screenshot, tap for full size, with Download beside "Tap to see it all". It fades in once loaded, over a
// shimmer in the card's colours, rather than a white box the image then pops into. Shown again (a refresh of the
// panel), it comes from the cache already loaded and shows at once.
function inviteShot(url: string, alt: string, download: HTMLAnchorElement) {
  const img = el("img", { src: url, alt: alt, decoding: "async" });
  const shot = el("div", { class: "bk-shot" }, [
    el("a", { class: "bk-open", href: url, target: "_blank", rel: "noopener", onclick: viewInvite(url, alt) }, [img]),
    el("div", { class: "bk-pills" }, [download, el("span", { text: "Tap to see it all", "aria-hidden": "true" })]),
  ]);
  if (img.complete && img.naturalWidth) {
    shot.classList.add("ld");
  } else {
    const loaded = function () {
      shot.classList.add("ld");
    };
    img.addEventListener("load", loaded, { once: true });
    img.addEventListener("error", loaded, { once: true });
  }
  return shot;
}

// Opening the invite screenshot full size: it zooms up over a dark backdrop on this page, instead of a new tab (or, in
// the installed app, a browser sheet) that flashed white while it loaded. The screenshot is already loaded for the
// card above, so it shows at once. Ctrl/⌘-click and middle-click still open the image in a new tab.
function viewInvite(url: string, alt: string) {
  return function (event: MouseEvent) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    const opener = event.currentTarget as HTMLElement;
    const close = el("button", { class: "lbx-x", type: "button", "aria-label": "Close", text: "×" });
    const box = el("div", { class: "lbx", role: "dialog", "aria-modal": "true", "aria-label": alt }, [
      close,
      el("div", { class: "lbx-in" }, [el("img", { src: url, alt: alt, decoding: "async" })]),
    ]);
    const shut = function () {
      if (box.classList.contains("out")) {
        return;
      }
      box.classList.add("out");
      // removed once it has faded out (at once when motion is reduced and there is no animation to wait for)
      const gone = function () {
        box.remove();
      };
      box.addEventListener("animationend", gone, { once: true });
      setTimeout(gone, 300);
      if (document.contains(opener)) {
        opener.focus();
      }
    };
    close.onclick = shut;
    box.addEventListener("click", function (click) {
      if (click.target === box || (click.target as HTMLElement).classList.contains("lbx-in")) {
        shut();
      }
    });
    // Escape closes the screenshot, not the booking panel under it; Tab stays on the close button
    box.addEventListener("keydown", function (key) {
      if (key.key === "Escape" || key.key === "Tab") {
        key.preventDefault();
        key.stopPropagation();
        if (key.key === "Escape") {
          shut();
        }
      }
    });
    document.body.appendChild(box);
    close.focus();
  };
}

export function showBooking(id: string, refresh?: boolean) {
  const booking = findBooking(id);
  if (!booking) {
    if (refresh) {
      closePanel();
    }
    return;
  }
  const start = new Date(booking.start);
  const end = new Date(booking.end);
  const now = Date.now();
  const interviewer = state.iv.assign[booking.id] || "";
  const upcoming = Date.parse(booking.start) > now;
  const status = roundStatus(booking);
  // a redraw while typing feedback notes keeps the caret where it was
  const typing = document.activeElement as HTMLTextAreaElement | null;
  const caret = refresh && typing && typing.id === "fbnotes" ? typing.selectionStart : null;
  panel.refresh = function () {
    showBooking(id, true);
  };
  const body = openPanel(
    titleCase(booking.name),
    [booking.company, booking.round].filter(Boolean).join(" · ") || "No company given",
    refresh,
  );
  setPanelAvatar(booking.name, interviewer);
  // tapping the candidate opens their page in Contacts, which needs the booking's email to find them
  if (booking.email) {
    setPanelLink(
      function () {
        window.__openContact?.(id);
      },
      "Open " + titleCase(booking.name) + " in Contacts",
    );
  }
  panel.bookingId = id;

  // When: a calendar tile, the day and time, how far away it is, and the status.
  const relative = booking.cancelled
    ? "Cancelled " + (booking.cancelledAt ? timeAgo(booking.cancelledAt) : "")
    : upcoming
      ? "Starts " + untilText(Date.parse(booking.start) - now)
      : Date.parse(booking.end) > now
        ? "Happening now"
        : "Ended " + timeAgo(booking.end);
  body.appendChild(
    el("div", { class: "bk-when" }, [
      el("div", { class: "bk-cal", "aria-hidden": "true" }, [
        el("span", { text: formatIst({ month: "short" }, start) }),
        el("b", { text: formatIst({ day: "numeric" }, start) }),
      ]),
      el("div", { class: "bk-wt" }, [
        el("b", { text: formatIst({ weekday: "long", month: "short", day: "numeric" }, start) }),
        el("span", { text: formatTime(start) + " – " + formatTime(end) }),
        el("small", { text: booking.duration + " min · " + relative }),
      ]),
      el("span", statusPill(booking)),
    ]),
  );

  if (!booking.cancelled && !upcoming) {
    if (!booking.missed) {
      body.appendChild(feedbackCard(booking, caret));
    }
  }

  // Details
  const details = el("div", { class: "bk-card bk-rows" });
  function row(name: string, label: string, value: Node | string | undefined) {
    if (value) {
      details.appendChild(
        el("div", { class: "bk-row" }, [icon(name), el("div", null, [el("small", { text: label }), el("span", null, [value])])]),
      );
    }
  }
  row("mail", "Email", booking.email ? el("a", { href: "mailto:" + booking.email, text: booking.email }) : "");
  // the company's invite the candidate uploaded, and the HR's email and phone read from it
  const inviteUrl = "/admin/api/bookings/" + booking.id + "/invite";
  if (booking.invite) {
    const links = function (items: string[], scheme: string) {
      return el(
        "span",
        { class: "bk-inv" },
        items.map(function (item) {
          return el("a", { href: scheme + (scheme === "tel:" ? item.replace(/[^\d+]/g, "") : item), text: item });
        }),
      );
    };
    if (!booking.inviteRead) {
      row("mail", "HR contact", "Reading the invite…");
    } else if (!(booking.hrEmails || []).length && !(booking.hrPhones || []).length) {
      row("mail", "HR contact", "None found. Check the invite below.");
    } else {
      row("mail", "HR email", (booking.hrEmails || []).length ? links(booking.hrEmails!, "mailto:") : "");
      row("phone", "HR phone", (booking.hrPhones || []).length ? links(booking.hrPhones!, "tel:") : "");
    }
  }
  row(
    "clock",
    "Booked",
    formatIst({ month: "short", day: "numeric", year: "numeric" }, new Date(booking.createdAt)) +
      (booking.source === "admin" ? " by you" : booking.source === "calendly" ? " in Calendly" : " by the candidate"),
  );
  if (booking.rescheduledAt) {
    row(
      "moved",
      "Moved",
      (booking.prevStart ? "From " + shortDate(booking.prevStart) + ", " + formatTime(new Date(booking.prevStart)) + " " : "") +
        byWhom(booking.rescheduledBy),
    );
  }
  if (booking.cancelled) {
    row("x", "Cancelled", (booking.cancelledAt ? shortDate(booking.cancelledAt) + " " : "") + byWhom(booking.cancelledBy));
    row("note", "Reason", booking.cancelReason);
  }
  body.appendChild(details);
  // the invite itself: a screenshot or photo shows here (tap for full size); a PDF or HEIC photo opens in a new tab
  if (booking.invite) {
    const shown = /^image\/(png|jpeg|webp)$/.test(booking.invite.type);
    const inviteDownload = el("a", {
      href: inviteUrl + "?download=1",
      download: "",
      "aria-label": "Download the interview invite of " + booking.name,
      text: "Download",
    });
    shareOnTap(inviteDownload, booking.invite.type, "Interview invite of " + titleCase(booking.name));
    body.appendChild(
      el("div", { class: "bk-card" }, [
        el("h3", { text: "Interview invite" }),
        shown
          ? inviteShot(inviteUrl, "Interview invite " + titleCase(booking.name) + " uploaded", inviteDownload)
          : el("span", { class: "bk-inv" }, [
              el("a", { href: inviteUrl, target: "_blank", rel: "noopener", text: "Open the invite" }),
              inviteDownload,
            ]),
      ]),
    );
  }

  // Interview support (not for an interview marked as a no-show or didn't happen: its status card says so)
  if (!booking.cancelled && !booking.missed) {
    const box = el("div", { class: "bk-card" }, [el("h3", { text: "Interview support given by" })]);
    if (upcoming) {
      box.appendChild(
        el("p", { class: "sub", text: "You can record who gave interview support once it starts at " + formatTime(start) + "." }),
      );
    } else {
      const choices = el("div", { class: "ivc" });
      const msg = el("p", { class: "msg", role: "status" });
      const names = interviewer ? [interviewer] : state.iv.names.slice();
      names.forEach(function (name) {
        choices.appendChild(
          el(
            "button",
            {
              type: "button",
              class: colorClass(name),
              "aria-pressed": String(interviewer === name),
              disabled: !!interviewer,
              onclick: function () {
                if (
                  !interviewer &&
                  confirm(
                    "Record " + name + " as the interview supporter for " + titleCase(booking.name) + "? This can't be changed later.",
                  )
                ) {
                  saveInterviewer(booking, name, msg);
                }
              },
            },
            [el("i", { class: "ivd", text: initials(name) }), el("span", { text: name })],
          ),
        );
      });
      box.appendChild(choices);
      if (interviewer) {
        box.appendChild(el("p", { class: "lockd", text: "Locked. This can't be changed once recorded." }));
      } else {
        box.appendChild(el("p", { class: "sub ivh", text: "Tap who gave interview support." }));
      }
      const clash = clashFor(booking, interviewer);
      if (clash) {
        box.appendChild(el("div", { class: "warn", text: interviewer + " also has " + clash + " at the same time." }));
      }
      box.appendChild(msg);
    }
    body.appendChild(box);
  }

  // The candidate's other interviews (same email) with this company: its other rounds and any repeat bookings, newest
  // first. Spellings that differ slightly ("Randstand", "Randstandi") count as the same company.
  const seen: Record<string, boolean> = {};
  const sameEmail = function (other: Booking) {
    return !!booking.email && other.email.toLowerCase() === booking.email.toLowerCase();
  };
  const sameFirm = function (other: Booking) {
    const mine = (booking.company || "").trim().toLowerCase();
    const theirs = (other.company || "").trim().toLowerCase();
    return !!mine && (mine === theirs || sameCompany(mine, theirs));
  };
  const sameSpelling = function (other: Booking) {
    return (other.company || "").trim().toLowerCase() === (booking.company || "").trim().toLowerCase();
  };
  const others = (state.events || [])
    .concat(allBookings || [])
    .filter(function (other) {
      const keep = other.id !== booking.id && !seen[other.id] && sameEmail(other) && sameFirm(other);
      seen[other.id] = true;
      return keep;
    })
    .sort(function (first, second) {
      return Date.parse(second.start) - Date.parse(first.start);
    });
  if (others.length) {
    const history = el("div", { class: "bk-card bk-hist" }, [el("h3", { text: "Other interviews at " + (booking.company || "").trim() })]);
    others.slice(0, 10).forEach(function (other) {
      history.appendChild(
        el(
          "button",
          {
            type: "button",
            class: "bk-h",
            onclick: function () {
              showBooking(other.id);
            },
          },
          [
            el("span", { class: "bk-hd" }, [
              el("span", { text: formatIst({ month: "short", day: "numeric" }, new Date(other.start)) }),
              el("small", { text: formatTime(new Date(other.start)) }),
            ]),
            // the company is in the title; show it here only when spelled differently
            el("span", {
              class: "bk-hm",
              text: [sameSpelling(other) ? "" : other.company, other.round].filter(Boolean).join(" · ") || "Interview",
            }),
            el("span", statusPill(other, true)),
          ],
        ),
      );
    });
    body.appendChild(history);
  }
  if (!allBookings && booking.email) {
    loadAllBookings()
      .then(function () {
        if (panel.bookingId === id && !byId("panel").hidden) {
          showBooking(id, true);
        }
      })
      .catch(function () {});
  }

  if (!booking.cancelled && !upcoming) {
    body.appendChild(resultFoot(booking, status, !!interviewer));
  }
  // a misspelt company is corrected here, for this booking and the candidate's others spelt the same way
  body.appendChild(
    el("p", { class: "bk-fix" }, [
      el("button", {
        type: "button",
        class: "linkbtn",
        text: booking.company ? "Fix the company's spelling" : "Add the company",
        onclick: function () {
          showCompany(booking);
        },
      }),
    ]),
  );
  if (!booking.cancelled && upcoming) {
    body.appendChild(
      el("div", { class: "bk-foot" }, [
        el("button", {
          type: "button",
          class: "ghost",
          text: "Reschedule",
          onclick: function () {
            showReschedule(booking);
          },
        }),
        el("button", {
          type: "button",
          class: "ghost danger-t",
          text: "Cancel booking",
          onclick: function () {
            showCancel(booking);
          },
        }),
      ]),
    );
  }
}
export function showCompany(booking: Booking) {
  panel.refresh = null;
  const body = openPanel("Company", titleCase(booking.name) + " · " + formatRange(booking), true);
  const input = el("input", { id: "cname", type: "text", maxlength: "120", autocomplete: "off" }) as HTMLInputElement;
  input.value = booking.company || "";
  const msg = el("p", { class: "msg", role: "status" });
  body.appendChild(el("div", { class: "f" }, [el("label", { for: "cname", text: "Company name" }), input]));
  if (booking.company) {
    body.appendChild(
      el("p", { class: "sub", text: "Their other bookings with \u201c" + booking.company.trim() + "\u201d are changed too." }),
    );
  }
  const save = function () {
    if (!input.value.trim()) {
      return setMessage(msg, "Enter the company's name.", true);
    }
    button.disabled = true;
    button.textContent = "Saving…";
    request<{ changed?: number }>("/admin/api/company", { id: booking.id, company: input.value })
      .then(function (reply) {
        showBooking(booking.id, true);
        toast(reply && reply.changed && reply.changed > 1 ? "Company fixed on " + reply.changed + " bookings" : "Company saved");
      })
      .catch(function (error) {
        button.disabled = false;
        button.textContent = "Save";
        setMessage(msg, error.message, true);
      });
  };
  const button = el("button", { type: "button", class: "pri", text: "Save", onclick: save }) as HTMLButtonElement;
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      save();
    }
  });
  body.appendChild(
    el("div", { class: "row mt" }, [
      button,
      el("button", {
        type: "button",
        class: "ghost",
        text: "Back",
        onclick: function () {
          showBooking(booking.id, true);
        },
      }),
    ]),
  );
  body.appendChild(msg);
  input.focus();
}
export function showCancel(booking: Booking) {
  panel.refresh = null;
  const body = openPanel("Cancel booking", titleCase(booking.name) + " · " + formatRange(booking), true);
  const reason = el("textarea", {
    id: "creason",
    maxlength: "500",
    rows: "3",
  });
  const msg = el("p", {
    class: "msg",
    role: "status",
  });
  body.appendChild(
    el(
      "div",
      {
        class: "f",
      },
      [
        el("label", {
          for: "creason",
          text: state.email ? "Reason (optional, included in the candidate's email)" : "Reason (optional, for your records)",
        }),
        reason,
      ],
    ),
  );
  body.appendChild(
    el("p", {
      class: "sub",
      text: state.email
        ? "The candidate gets a cancellation email, and the time opens up again."
        : "The time opens up again. Emails are off, so let the candidate know yourself.",
    }),
  );
  const button = el("button", {
    type: "button",
    class: "danger",
    text: "Cancel booking",
    onclick: function () {
      button.disabled = true;
      button.textContent = "Cancelling…";
      request("/admin/api/cancel", {
        id: booking.id,
        reason: reason.value.trim(),
      })
        .then(function () {
          closePanel();
          toast("Booking cancelled");
        })
        .catch(function (error) {
          button.disabled = false;
          button.textContent = "Cancel booking";
          setMessage(msg, error.message, true);
        });
    },
  });
  body.appendChild(
    el(
      "div",
      {
        class: "row mt",
      },
      [
        button,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Keep booking",
          onclick: function () {
            showBooking(booking.id, true);
          },
        }),
      ],
    ),
  );
  body.appendChild(msg);
  reason.focus();
}
// Date, length and free-time fields. get() gives the chosen time, or null.
export function timePicker(duration: number, day: string | null, ignoreId?: string) {
  const today = dayKeyOf(new Date());
  const durationSelect = el("select", {
    id: "cdur",
  });
  const dateInput = el("input", {
    type: "date",
    id: "cdate",
    min: today,
    max: addDays(today, 29),
  });
  const timeSelect = el("select", {
    id: "ctime",
  });
  [30, 60, 90].forEach(function (minutes) {
    durationSelect.appendChild(
      el("option", {
        value: String(minutes),
        text: minutes + " min",
      }),
    );
  });
  durationSelect.value = String(duration || 30);
  dateInput.value = day && day >= today ? day : today;
  function placeholder(text: string) {
    timeSelect.textContent = "";
    timeSelect.appendChild(
      el("option", {
        value: "",
        text: text,
      }),
    );
    timeSelect.disabled = true;
  }
  function loadTimes() {
    const day = dateInput.value;
    placeholder("Loading…");
    if (!day) {
      return placeholder("Pick a date");
    }
    request<{ slots: number[] }>(
      "/admin/api/slots?date=" + day + "&duration=" + durationSelect.value + (ignoreId ? "&ignore=" + ignoreId : ""),
    )
      .then(function (result) {
        if (day === dateInput.value) {
          if (!result.slots.length) {
            return placeholder("No free times this day");
          }
          timeSelect.textContent = "";
          timeSelect.disabled = false;
          result.slots.forEach(function (startMs: number) {
            timeSelect.appendChild(
              el("option", {
                value: String(startMs),
                text: formatTime(new Date(startMs)),
              }),
            );
          });
        }
      })
      .catch(function () {
        placeholder("Couldn't load times");
      });
  }
  durationSelect.onchange = loadTimes;
  dateInput.onchange = loadTimes;
  loadTimes();
  return {
    el: el("div", null, [
      el(
        "div",
        {
          class: "two",
        },
        [
          el(
            "div",
            {
              class: "f",
            },
            [
              el("label", {
                for: "cdate",
                text: "Date",
              }),
              dateInput,
            ],
          ),
          el(
            "div",
            {
              class: "f",
            },
            [
              el("label", {
                for: "cdur",
                text: "Length",
              }),
              durationSelect,
            ],
          ),
        ],
      ),
      el(
        "div",
        {
          class: "f",
        },
        [
          el("label", {
            for: "ctime",
            text: "Time",
          }),
          timeSelect,
        ],
      ),
    ]),
    get: function () {
      if (timeSelect.value) {
        return {
          startMs: +timeSelect.value,
          duration: +durationSelect.value,
        };
      } else {
        return null;
      }
    },
  };
}
export function goToTime(startMs: number) {
  const day = dayKeyOf(new Date(startMs));
  view.day = day;
  view.week = weekStart(day);
  render();
}
export function showReschedule(booking: Booking) {
  panel.refresh = null;
  const body = openPanel("Reschedule", titleCase(booking.name) + " · now " + formatRange(booking), true);
  const picker = timePicker(booking.duration, dayKeyOf(new Date(booking.start)), booking.id);
  const msg = el("p", {
    class: "msg",
    role: "status",
  });
  body.appendChild(picker.el);
  body.appendChild(
    el("p", {
      class: "sub",
      text: state.email
        ? "The candidate gets an updated calendar invite by email."
        : "Emails are off, so let the candidate know the new time yourself.",
    }),
  );
  const button = el("button", {
    type: "button",
    class: "pri",
    text: "Save new time",
    onclick: function () {
      const choice = picker.get();
      if (!choice) {
        return setMessage(msg, "Pick a time first.", true);
      }
      button.disabled = true;
      request("/admin/api/reschedule", {
        id: booking.id,
        startMs: choice.startMs,
        duration: choice.duration,
      })
        .then(function () {
          closePanel();
          toast("Booking moved");
          goToTime(choice!.startMs);
        })
        .catch(function (error) {
          button.disabled = false;
          setMessage(msg, error.message, true);
        });
    },
  });
  body.appendChild(
    el(
      "div",
      {
        class: "row mt",
      },
      [
        button,
        el("button", {
          type: "button",
          class: "ghost",
          text: "Back",
          onclick: function () {
            showBooking(booking.id, true);
          },
        }),
      ],
    ),
  );
  body.appendChild(msg);
  byId("cdate").focus();
}
export function showWeekOf(booking: Booking) {
  const day = dayKeyOf(new Date(booking.start));
  const week = weekStart(day);
  view.day = day;
  if (week !== view.week) {
    view.week = week;
    render();
  }
}
export function showList(title: string, subtitle: string, bookings: Booking[]) {
  panel.refresh = null;
  const body = openPanel(title, subtitle);
  if (!bookings.length) {
    body.appendChild(
      el("p", {
        class: "sub",
        text: "Nothing here.",
      }),
    );
    return;
  }
  const list = el("ul", {
    class: "items",
  });
  bookings.forEach(function (booking) {
    function open() {
      showWeekOf(booking);
      showBooking(booking.id);
    }
    list.appendChild(
      el(
        "li",
        {
          tabindex: "0",
          role: "button",
          onclick: open,
          onkeydown: onEnterOrSpace(open),
        },
        [
          el("b", {
            text: titleCase(booking.name),
          }),
          el("div", {
            class: "m",
            text: formatRange(booking) + (booking.company ? " · " + booking.company : "") + (booking.cancelled ? " · Cancelled" : ""),
          }),
        ],
      ),
    );
  });
  body.appendChild(list);
}
