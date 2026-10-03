// Onboarding (⋯ menu, owners only): what new candidates sent from /onboarding, with their Aadhaar and PAN cards, in the
// side panel (a bottom sheet on phones). A new form shows up while it is open.
import { el, setMessage, toast } from "./dom";
import { formatIst, formatTime } from "./time";
import { titleCase } from "./labels";
import { request } from "./api";
import { state } from "./state";
import { icon, openPanel, panel } from "./panel";
import type { IdCard, OnboardingForm } from "./types";

// what the candidate said about their experience, after the years
const GENUINE = { yes: " · Genuine", no: " · Not genuine", "": "" };
const kb = (card: IdCard) => Math.max(1, Math.round(card.size / 1024)) + " KB";

export function showOnboarding() {
  const body = openPanel("Onboarding", "Details and ID cards from the onboarding page.");
  const link = location.origin + "/onboarding";
  const msg = el("p", { class: "msg", role: "status" });
  const list = el("div", { class: "onbl" }, [el("p", { class: "sub", text: "Loading…" })]);
  body.appendChild(
    el("div", { class: "enqlink" }, [
      el("a", { href: "/onboarding", target: "_blank", rel: "noopener", text: link.replace(/^https?:\/\//, "") }),
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
  body.appendChild(list);
  body.appendChild(msg);
  // a card opens in a new tab to look at; the icon beside it saves it, named after the candidate
  function cardLinks(item: OnboardingForm, key: "aadhaar" | "pan", label: string) {
    const url = "/admin/api/onboarding/" + item.id + "/" + key;
    return el("div", { class: "enqr" }, [
      el("a", { class: "bk-act", href: url, target: "_blank", rel: "noopener", text: label + " · " + kb(item[key]) }),
      el(
        "a",
        {
          class: "bk-act dl",
          href: url + "?download=1",
          download: "",
          title: "Download " + label + " card",
          "aria-label": "Download the " + label + " card of " + item.name,
        },
        [icon("download")],
      ),
    ]);
  }
  function draw(forms: OnboardingForm[]) {
    list.textContent = "";
    if (!forms.length) {
      list.appendChild(el("p", { class: "sub", text: "No onboarding forms yet. Share the link above." }));
      return;
    }
    forms.forEach(function (item) {
      const when = new Date(item.createdAt);
      list.appendChild(
        el("div", { class: "enq" }, [
          el("div", { class: "enqh" }, [
            el("b", { text: titleCase(item.name) }),
            el("small", { text: formatIst({ month: "short", day: "numeric" }, when) + ", " + formatTime(when) }),
          ]),
          el("p", { class: "enqt", text: item.tech + " · " + item.experience + GENUINE[item.genuine] }),
          el("p", { class: "enqc" }, [
            el("a", { href: "mailto:" + item.email, text: item.email }),
            el("a", { href: "tel:" + item.phone.replace(/[^\d+]/g, ""), text: item.phone }),
            // the server only keeps https addresses on linkedin.com
            item.linkedin ? el("a", { href: item.linkedin, target: "_blank", rel: "noopener", text: "LinkedIn" }) : null,
          ]),
          el("div", { class: "onba" }, [
            cardLinks(item, "aadhaar", "Aadhaar"),
            cardLinks(item, "pan", "PAN"),
            el("button", {
              type: "button",
              class: "rm",
              text: "Delete",
              "aria-label": "Delete the onboarding form from " + item.name,
              onclick: function () {
                if (!confirm("Delete the onboarding form from " + item.name + ", with their ID cards? This can't be undone.")) {
                  return;
                }
                request("/admin/api/onboarding/delete", { id: item.id })
                  .then(function () {
                    toast("Form deleted");
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
  let shown = state.onboarding ?? 0;
  function load() {
    shown = state.onboarding ?? 0;
    return request<{ forms: OnboardingForm[] }>("/admin/api/onboarding")
      .then(function (result) {
        draw(result.forms || []);
      })
      .catch(function (error) {
        list.textContent = "";
        setMessage(msg, error.message, true);
      });
  }
  // the live state says how many forms there are; a new one (or one deleted on another device) redraws the list
  panel.refresh = function () {
    if ((state.onboarding ?? 0) !== shown) {
      load();
    }
  };
  load();
}
