// The public payment form (/payment): email, full name, the amount paid in rupees and a receipt (an image or a PDF), sent
// as one multipart request to /api/payment, which also checks that the amount is the one on the receipt. The receipt's
// size limit comes from the server (the boot block) and is only mentioned when a file is too big. The same rules are
// checked again on the server.
var MAX_BYTES = JSON.parse(document.getElementById("boot").textContent).max;
var MAX_TEXT = Math.round((MAX_BYTES / 1048576) * 10) / 10 + " MB";
var form = document.getElementById("f");
var fileInput = document.getElementById("rc");
var button = document.getElementById("go");
var errorBox = document.getElementById("err");
var fields = {
  email: document.getElementById("em"),
  name: document.getElementById("nm"),
  amount: document.getElementById("am"),
};
function amountValue() {
  var text = fields.amount.value.replace(/[,\s₹]/g, "");
  return /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : NaN;
}
function fileProblem(file) {
  if (!file) {
    return "Attach your payment receipt.";
  } else if (!/^image\//.test(file.type) && file.type !== "application/pdf" && !/\.(pdf|png|jpe?g|webp|heic)$/i.test(file.name)) {
    return "The receipt must be an image or a PDF.";
  } else if (file.size > MAX_BYTES) {
    return "Your receipt is larger than " + MAX_TEXT + ". Please upload a smaller file.";
  } else if (!file.size) {
    return "That file is empty.";
  } else {
    return "";
  }
}
function sizeText(bytes) {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : Math.round((bytes / 1048576) * 10) / 10 + " MB";
}
function showFile() {
  var file = fileInput.files[0];
  var problem = file ? fileProblem(file) : "";
  document.getElementById("rcname").textContent = file ? file.name : "Attach your receipt";
  document.getElementById("rchint").textContent = problem || (file ? sizeText(file.size) + " · tap to change" : "A photo, screenshot or PDF");
  document.getElementById("dropbox").classList.toggle("bad", !!problem);
  document.getElementById("dropbox").classList.toggle("has", !!file && !problem);
}
fileInput.addEventListener("change", showFile);
// a field someone is fixing stops showing as wrong
form.addEventListener("input", function (event) {
  if (event.target.getAttribute("aria-invalid") === "true") {
    event.target.setAttribute("aria-invalid", "false");
    errorBox.textContent = "";
  }
});
function check() {
  var problems = [];
  function need(input, ok, text) {
    input.setAttribute("aria-invalid", String(!ok));
    if (!ok) {
      problems.push({ input: input, text: text });
    }
  }
  need(fields.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.value.trim()), "Enter a valid email address.");
  need(fields.name, fields.name.value.trim().length >= 2, "Enter your full name.");
  var amount = amountValue();
  need(fields.amount, amount > 0 && amount <= 10000000, "Enter the amount you paid, in rupees.");
  var fileText = fileProblem(fileInput.files[0]);
  document.getElementById("dropbox").classList.toggle("bad", !!fileText);
  if (fileText) {
    problems.push({ input: fileInput, text: fileText });
  }
  return problems;
}
form.addEventListener("submit", function (event) {
  event.preventDefault();
  errorBox.textContent = "";
  var problems = check();
  if (problems.length) {
    errorBox.textContent = problems[0].text;
    problems[0].input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Checking your receipt…";
  fetch("/api/payment", { method: "POST", body: new FormData(form) })
    .then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            // the email isn't on the invite list, or the amount isn't the one on the receipt
            var field = fields[body.field];
            if (field) {
              field.setAttribute("aria-invalid", "true");
              field.focus();
            }
            throw new Error(body.error || "Couldn't send your payment details. Try again.");
          }
        });
    })
    .then(function () {
      form.hidden = true;
      document.getElementById("donetxt").textContent =
        "Thanks, " +
        fields.name.value.trim().split(/\s+/)[0] +
        ". We've received your payment of ₹" +
        amountValue().toLocaleString("en-IN") +
        " and will check it soon.";
      document.getElementById("done").hidden = false;
      window.scrollTo(0, 0);
    })
    .catch(function (error) {
      button.disabled = false;
      button.textContent = "Submit";
      errorBox.textContent =
        error instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : error.message;
    });
});
