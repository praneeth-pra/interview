// Signed out (or the session ended): drop the bookings the admin app kept on this device, and its offline copy.
try {
  localStorage.removeItem("adm.state");
} catch (e) {}
if (navigator.serviceWorker && navigator.serviceWorker.controller) {
  navigator.serviceWorker.controller.postMessage("signed-out");
}
// Two steps: the admin's email (a 6-digit code is emailed to people on the admin list), then the code.
const form = document.getElementById("f") as HTMLFormElement;
const emailInput = document.getElementById("em") as HTMLInputElement;
const codeInput = document.getElementById("code") as HTMLInputElement;
const button = document.getElementById("go") as HTMLButtonElement;
const errorBox = document.getElementById("err") as HTMLElement;
const lead = document.getElementById("lead") as HTMLElement;
const firstLead = lead.textContent;
let step = 1;
let busy = false;
try {
  emailInput.value = localStorage.getItem("adm.email") || "";
} catch (e) {}
function post(url: string, body: object) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(function (response) {
    return response
      .json()
      .catch(function () {
        return {};
      })
      .then(function (json) {
        return { ok: response.ok, json: json };
      });
  });
}
function setBusy(on: boolean, label: string) {
  busy = on;
  button.disabled = on;
  button.textContent = label;
}
function showStep(next: number) {
  step = next;
  document.getElementById("s1")!.hidden = step !== 1;
  document.getElementById("s2")!.hidden = step !== 2;
  document.getElementById("alt")!.hidden = step !== 2;
  button.textContent = step === 1 ? "Email me a code" : "Sign in";
  lead.textContent =
    step === 1 ? firstLead : "If " + emailInput.value.trim() + " is on the admin list, a code is on its way. It works for 10 minutes.";
  (step === 1 ? emailInput : codeInput).focus();
}
function askForCode() {
  const email = emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errorBox.textContent = "Enter your email address.";
    emailInput.focus();
    return;
  }
  setBusy(true, "Sending…");
  errorBox.textContent = "";
  post("/admin/login/code", { email: email })
    .then(function (result) {
      if (!result.ok) {
        setBusy(false, step === 1 ? "Email me a code" : "Sign in");
        errorBox.textContent = result.json.error || "Couldn't send a code. Try again.";
        return;
      }
      try {
        localStorage.setItem("adm.email", email);
      } catch (e) {}
      codeInput.value = "";
      setBusy(false, "Sign in");
      showStep(2);
    })
    .catch(function () {
      setBusy(false, step === 1 ? "Email me a code" : "Sign in");
      errorBox.textContent = "Couldn't reach the server. Check your connection and try again.";
    });
}
function signIn() {
  const code = codeInput.value.replace(/\D/g, "");
  if (code.length !== 6) {
    errorBox.textContent = "Enter the 6-digit code from the email.";
    codeInput.focus();
    return;
  }
  setBusy(true, "Signing in…");
  errorBox.textContent = "";
  post("/admin/login", { email: emailInput.value.trim(), code: code })
    .then(function (result) {
      if (result.ok) {
        return location.reload();
      }
      setBusy(false, "Sign in");
      errorBox.textContent = result.json.error || "Couldn't sign in.";
      codeInput.select();
    })
    .catch(function () {
      setBusy(false, "Sign in");
      errorBox.textContent = "Couldn't reach the server. Check your connection and try again.";
    });
}
form.addEventListener("submit", function (event) {
  event.preventDefault();
  if (busy) {
    return;
  }
  if (step === 1) {
    askForCode();
  } else {
    signIn();
  }
});
// the code is filled from the email (or pasted): sign in as soon as all six digits are there
codeInput.addEventListener("input", function () {
  const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
  if (digits !== codeInput.value) {
    codeInput.value = digits;
  }
  if (digits.length === 6 && !busy) {
    signIn();
  }
});
document.getElementById("again")!.addEventListener("click", function () {
  if (!busy) {
    askForCode();
  }
});
document.getElementById("other")!.addEventListener("click", function () {
  errorBox.textContent = "";
  showStep(1);
  emailInput.select();
});
