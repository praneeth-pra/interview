// Enquiries (owners only): the tab listing what people sent from /enquiry, and its red count of new ones.
import { byId, el, setMessage, toast } from "./dom";
import { formatIst, formatTime } from "./time";
import { titleCase } from "./labels";
import { request } from "./api";
import { SEEN_KEY, boot, state } from "./state";
import { icon } from "./panel";

// The Enquiries tab: responses from the public /enquiry page, newest first, with contact details, technology,
// experience and the resume. Opening it marks them as seen, which clears the red count.
export function showEnquiries() {
  var body = byId("enqBody");
  body.textContent = "";
  var link = location.origin + "/enquiry";
  var msg = el("p", { class: "msg", role: "status" });
  body.appendChild(
    el("div", { class: "enqlink" }, [
      el("a", { href: "/enquiry", target: "_blank", rel: "noopener", text: link.replace(/^https?:\/\//, "") }),
      el("button", {
        type: "button",
        class: "ghost",
        text: "Copy link",
        onclick: function () {
          navigator.clipboard.writeText(link).then(
            function () {
              toast("Link copied");
            },
            function () {
              setMessage(msg, "Couldn't copy. The link is " + link, true);
            },
          );
        },
      }),
    ]),
  );
  var list = el("div", { class: "enqlist" }, [el("p", { class: "sub", text: "Loading…" })]);
  body.appendChild(list);
  body.appendChild(msg);
  function draw(enquiries: any[]) {
    list.textContent = "";
    if (!enquiries.length) {
      list.appendChild(el("p", { class: "sub", text: "No enquiries yet. Share the link above." }));
      return;
    }
    enquiries.forEach(function (item) {
      var when = new Date(item.createdAt);
      list.appendChild(
        el("div", { class: "enq" }, [
          el("div", { class: "enqh" }, [
            el("b", { text: titleCase(item.name) }),
            el("small", { text: formatIst({ month: "short", day: "numeric" }, when) + ", " + formatTime(when) }),
          ]),
          el("p", { class: "enqt", text: item.tech + " · " + item.experience }),
          el("p", { class: "enqc" }, [
            el("a", { href: "mailto:" + item.email, text: item.email }),
            el("a", { href: "tel:" + item.phone.replace(/[^\d+]/g, ""), text: item.phone }),
          ]),
          el("div", { class: "enqa" }, [
            // the resume opens in a new tab to read; the icon beside it saves it, named after the candidate
            el("div", { class: "enqr" }, [
              el("a", {
                class: "bk-act",
                href: "/admin/api/enquiries/" + item.id + "/resume",
                target: "_blank",
                rel: "noopener",
                text: "Resume · " + Math.max(1, Math.round(item.resume.size / 1024)) + " KB",
              }),
              el(
                "a",
                {
                  class: "bk-act dl",
                  href: "/admin/api/enquiries/" + item.id + "/resume?download=1",
                  download: "",
                  title: "Download resume",
                  "aria-label": "Download the resume of " + item.name,
                },
                [icon("download")],
              ),
            ]),
            el("button", {
              type: "button",
              class: "rm",
              text: "Delete",
              "aria-label": "Delete the enquiry from " + item.name,
              onclick: function () {
                if (!confirm("Delete the enquiry from " + item.name + ", with their resume? This can't be undone.")) {
                  return;
                }
                request("/admin/api/enquiries/delete", { id: item.id })
                  .then(function () {
                    toast("Enquiry deleted");
                    load();
                  })
                  .catch(function (error) {
                    setMessage(msg, error.message, true);
                  });
              },
            }),
          ]),
        ]),
      );
    });
  }
  function load() {
    request("/admin/api/enquiries")
      .then(function (result) {
        draw(result.enquiries || []);
        markEnquiriesSeen();
      })
      .catch(function (error) {
        list.textContent = "";
        setMessage(msg, error.message, true);
      });
  }
  load();
}
// The red count on the Enquiries tab: enquiries that came in after this admin last opened the tab (kept on the server,
// so phone and laptop agree). The home-screen app's icon shows it too, where the phone allows it.
// Until the last-opened time is known (kept on this device, then checked with the server) the badge stays hidden, so a
// refresh doesn't flash every enquiry as new and then drop to the real count.
var enquiriesSeenAt: string | null = null;
try {
  enquiriesSeenAt = localStorage.getItem(SEEN_KEY);
} catch (e) {}
var enquiriesShown = -1;
function setEnquiriesSeen(at: string) {
  enquiriesSeenAt = at;
  try {
    localStorage.setItem(SEEN_KEY, at);
  } catch (e) {}
  renderEnquiryBadge();
}
function unreadEnquiries() {
  if (enquiriesSeenAt === null) return 0;
  var seen = enquiriesSeenAt ? Date.parse(enquiriesSeenAt) : 0;
  return (state.enquiries || []).filter(function (at) {
    return Date.parse(at) > seen;
  }).length;
}
export function renderEnquiryBadge() {
  var count = byId("viewEnq").hidden ? unreadEnquiries() : 0;
  document.querySelectorAll<HTMLElement>(".nbadge:not(.pbadge)").forEach(function (badge: HTMLElement) {
    badge.hidden = !count;
    badge.textContent = count > 99 ? "99+" : String(count);
  });
  byId("tabEnq").setAttribute("aria-label", count ? "Enquiries, " + count + " new" : "Enquiries");
  var nav = navigator as any;
  try {
    if (count && nav.setAppBadge) {
      nav.setAppBadge(count).catch(function () {});
    } else if (!count && nav.clearAppBadge) {
      nav.clearAppBadge().catch(function () {});
    }
  } catch (e) {}
  // a new enquiry while the tab is open shows up straight away
  var total = (state.enquiries || []).length;
  if (!byId("viewEnq").hidden && enquiriesShown >= 0 && total !== enquiriesShown) {
    showEnquiries();
  }
  enquiriesShown = total;
}
export function markEnquiriesSeen() {
  request("/admin/api/enquiries/seen", {})
    .then(function (result) {
      setEnquiriesSeen(result.seenAt || "");
    })
    .catch(function () {});
}
// only owners have Enquiries
export function setupEnquiries() {
  if (boot.owner) {
    request("/admin/api/enquiries/seen")
      .then(function (result) {
        setEnquiriesSeen(result.seenAt || "");
      })
      .catch(function () {});
  }
}
