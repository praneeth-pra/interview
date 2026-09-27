// Admins (⋯ menu): who can sign in to the admin page.
import { el, setMessage, toast } from "./dom";
import { request } from "./api";
import { boot } from "./state";
import { openPanel, panel } from "./panel";
import type { AdminsView } from "./types";

// Who can sign in. Owners come from the server's ADMIN_EMAILS and can't be removed here; everyone else can be added or
// removed, and removing someone signs them out on all their devices.
export function showAdmins() {
  panel.refresh = null;
  // only owners add and remove admins; everyone else sees the list
  const body = openPanel(
    "Admins",
    boot.owner ? "People on this list sign in with a code sent to their email." : "Only the owner can add or remove admins.",
  );
  const msg = el("p", {
    class: "msg",
    role: "status",
  });
  const me = el("p", { class: "sub", text: "Loading…" });
  const rows = el("div", { class: "admlist" });
  const input = el("input", {
    type: "email",
    inputmode: "email",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "name@example.com",
    "aria-label": "Email of the admin to add",
  }) as HTMLInputElement;
  const addButton = el("button", { type: "button", class: "pri", text: "Add" }) as HTMLButtonElement;
  let view = { owners: [] as string[], emails: [] as string[], me: "" };
  function save(emails: string[], done: string) {
    addButton.disabled = true;
    return request<AdminsView>("/admin/api/admins", { emails: emails })
      .then(function (result) {
        view = result;
        draw();
        toast(done);
        return true;
      })
      .catch(function (error) {
        setMessage(msg, error.message, true);
        return false;
      })
      .then(function (ok) {
        addButton.disabled = false;
        return ok;
      });
  }
  function draw() {
    me.textContent = view.me ? "You're signed in as " + view.me + "." : "";
    rows.textContent = "";
    view.owners.forEach(function (email) {
      rows.appendChild(
        el("div", { class: "admrow" }, [el("span", { class: "admail", text: email }), el("span", { class: "tag r", text: "Owner" })]),
      );
    });
    view.emails.forEach(function (email) {
      if (!boot.owner) {
        rows.appendChild(el("div", { class: "admrow" }, [el("span", { class: "admail", text: email })]));
        return;
      }
      rows.appendChild(
        el("div", { class: "admrow" }, [
          el("span", { class: "admail", text: email }),
          el("button", {
            type: "button",
            class: "rm",
            text: "Remove",
            "aria-label": "Remove " + email,
            onclick: function () {
              if (confirm("Remove " + email + "? They'll be signed out on every device.")) {
                save(
                  view.emails.filter(function (other) {
                    return other !== email;
                  }),
                  "Admin removed",
                );
              }
            },
          }),
        ]),
      );
    });
  }
  function add() {
    const email = input.value.trim().toLowerCase();
    setMessage(msg, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMessage(msg, "Enter a valid email address.", true);
      input.focus();
      return;
    }
    if (view.owners.indexOf(email) >= 0 || view.emails.indexOf(email) >= 0) {
      setMessage(msg, email + " is already an admin.", true);
      return;
    }
    save(view.emails.concat([email]), "Admin added").then(function (ok) {
      if (ok) {
        input.value = "";
        setMessage(msg, email + " can now sign in with a code sent to that email.");
      }
    });
  }
  addButton.onclick = add;
  input.addEventListener("keydown", function (event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    }
  });
  body.appendChild(me);
  body.appendChild(rows);
  if (boot.owner) {
    body.appendChild(el("div", { class: "admadd" }, [input, addButton]));
  }
  body.appendChild(msg);
  request<AdminsView>("/admin/api/admins")
    .then(function (result) {
      view = result;
      draw();
    })
    .catch(function (error) {
      me.textContent = "";
      setMessage(msg, error.message, true);
    });
}
