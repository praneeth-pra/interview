// The details step: name, email, company, round and the interview invite, then sending the booking.
import { el } from "../shared/dom";
import { loadCompanies } from "./companies";
import { render, state } from "./app";
import { clearSlots, loadDays, showSlots } from "./slots";
import { companyField, roundField, textField } from "./fields";
import { bookingForm, inviteField, inviteProblem } from "./invite";
import { WELCOME_BACK, prefillName, previousCompanies, rememberBooking, setNameHint, showPreviousCompanies } from "./returning";

let lookupTimer: ReturnType<typeof setTimeout> | null = null; // clearTimeout(null) does nothing, so the calls below pass it as is
export function renderDetails() {
  loadCompanies();
  const form = el("form", {
    class: "form",
    novalidate: true,
    "aria-labelledby": "formh",
    onsubmit: function (event: SubmitEvent) {
      event.preventDefault();
      submitBooking();
    },
  });
  form.appendChild(
    el(
      "h2",
      {
        id: "formh",
      },
      ["Enter Details"],
    ),
  );
  if (state.err) {
    form.appendChild(
      el(
        "div",
        {
          class: "banner",
          role: "alert",
        },
        [state.err],
      ),
    );
  }
  const emailField = textField("femail", "email", "Email", "email", {
    req: true,
    ac: "email",
    max: 200,
  });
  const nameField = textField("fname", "name", "Name", "text", {
    req: true,
    ac: "name",
  });
  nameField.appendChild(
    el(
      "div",
      {
        class: "hint",
        id: "fnameh",
        role: "status",
      },
      [state.nameAuto ? WELCOME_BACK : ""],
    ),
  );
  const emailInput = emailField.querySelector("input")!;
  const nameInput = nameField.querySelector("input")!;
  emailInput.addEventListener("input", function () {
    showPreviousCompanies();
    clearTimeout(lookupTimer!);
    lookupTimer = setTimeout(function () {
      prefillName(emailInput.value);
    }, 350);
  });
  emailInput.addEventListener("change", function () {
    clearTimeout(lookupTimer!);
    prefillName(emailInput.value);
  });
  nameInput.addEventListener("input", function () {
    if (state.nameAuto) {
      state.nameAuto = false;
      setNameHint("");
    }
  });
  form.appendChild(emailField);
  form.appendChild(nameField);
  if (state.form.email && !state.form.name.trim()) {
    setTimeout(function () {
      prefillName(state.form.email);
    }, 0);
  }
  const previous = previousCompanies();
  if (previous) {
    form.appendChild(previous);
  }
  form.appendChild(
    el(
      "div",
      {
        class: "row2",
      },
      [companyField(), roundField()],
    ),
  );
  form.appendChild(inviteField());
  form.appendChild(
    el(
      "button",
      {
        type: "submit",
        class: "submit",
        id: "submitb",
        disabled: state.busy,
      },
      [state.busy ? "Booking…" : "Confirm interview"],
    ),
  );
  return form;
}
function submitBooking() {
  const errors: Record<string, string> = {};
  const form = state.form;
  if (!form.name.trim()) {
    errors.name = "Enter your name.";
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = "Enter an email address like name@example.com.";
  }
  if (!form.company.trim()) {
    errors.company = "Enter the company you're interviewing with.";
  }
  const invite = state.invite;
  const inviteError = inviteProblem(invite);
  if (inviteError) {
    errors.invite = inviteError;
  }
  state.fieldErr = errors;
  state.err = "";
  if (Object.keys(errors).length || !invite) {
    render();
    const firstInvalid = document.getElementById(errors.email ? "femail" : errors.name ? "fname" : errors.company ? "fcompany" : "finv");
    if (firstInvalid) {
      firstInvalid.focus();
    }
    return;
  }
  state.busy = true;
  render();
  bookingForm(
    {
      name: form.name.trim(),
      email: form.email.trim(),
      company: form.company.trim(),
      round: form.round.trim(),
      duration: state.dur,
      startMs: state.slot!,
    },
    invite,
  )
    .then(function (body) {
      return fetch("/api/book", { method: "POST", body: body });
    })
    .then(function (res) {
      return res.json().then(function (body) {
        return {
          ok: res.ok,
          j: body,
        };
      });
    })
    .then(function (result) {
      state.busy = false;
      if (result.ok) {
        rememberBooking(form.name.trim(), form.email.trim(), String(result.j.booking.company || form.company).trim());
        state.booking = result.j.booking;
        state.booking!.emailed = !!result.j.emailed;
        state.step = "done";
        render();
        window.scrollTo(0, 0);
        return;
      }
      if (result.j.field === "email" || result.j.field === "company" || result.j.field === "invite") {
        state.fieldErr = {
          [result.j.field]: result.j.error,
        };
        render();
        const badInput = document.getElementById(
          result.j.field === "email" ? "femail" : result.j.field === "company" ? "fcompany" : "finv",
        );
        if (badInput) {
          badInput.focus();
        }
        return;
      }
      if (result.j.retry) {
        clearSlots();
        state.step = "pick";
        state.err = result.j.error || "That time is no longer available. Pick another time.";
        loadDays(true).then(function () {
          if (state.date) {
            showSlots();
          } else {
            render();
          }
        });
        return;
      }
      state.err = result.j.error || "Couldn't schedule the event. Try again.";
      render();
    })
    .catch(function () {
      state.busy = false;
      state.err = "Couldn't reach the server. Check your connection and try again.";
      render();
    });
}
