// The public enquiry form (/enquiry): name, email, phone, technology, experience and a resume (PDF or Word, under 1 MB),
// sent as one multipart request to /api/enquiry. The same rules are checked again on the server.
var MAX_BYTES = 1024 * 1024;
var form = document.getElementById("f");
var fileInput = document.getElementById("cv");
var button = document.getElementById("go");
var errorBox = document.getElementById("err");
var fields = {
  name: document.getElementById("nm"),
  email: document.getElementById("em"),
  phone: document.getElementById("ph"),
  tech: document.getElementById("tc"),
  experience: document.getElementById("yx"),
};
function fileProblem(file) {
  if (!file) {
    return "Add your resume.";
  } else if (!/\.(pdf|docx?)$/i.test(file.name)) {
    return "The resume must be a PDF or Word file.";
  } else if (file.size > MAX_BYTES) {
    return "The resume is " + (file.size / 1048576).toFixed(1) + " MB. It must be under 1 MB.";
  } else if (!file.size) {
    return "That file is empty.";
  } else {
    return "";
  }
}
function showFile() {
  var file = fileInput.files[0];
  var problem = file ? fileProblem(file) : "";
  document.getElementById("cvname").textContent = file ? file.name : "Choose your resume";
  document.getElementById("cvhint").textContent = problem || (file ? Math.max(1, Math.round(file.size / 1024)) + " KB · tap to change" : "PDF or Word, under 1 MB");
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
  need(fields.name, fields.name.value.trim().length >= 2, "Enter your full name.");
  need(fields.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.value.trim()), "Enter a valid email address.");
  var digits = fields.phone.value.replace(/\D/g, "");
  need(fields.phone, digits.length >= 10 && digits.length <= 15, "Enter a valid phone number.");
  need(fields.tech, fields.tech.value.trim().length >= 2, "Tell us the technology you're looking for.");
  need(fields.experience, !!fields.experience.value, "Choose your years of experience.");
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
  button.textContent = "Sending…";
  fetch("/api/enquiry", { method: "POST", body: new FormData(form) })
    .then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            throw new Error(body.error || "Couldn't send your enquiry. Try again.");
          }
        });
    })
    .then(function () {
      form.hidden = true;
      document.getElementById("donetxt").textContent =
        "Thanks, " + fields.name.value.trim().split(/\s+/)[0] + ". We've received your enquiry and will get back to you soon.";
      document.getElementById("done").hidden = false;
      window.scrollTo(0, 0);
    })
    .catch(function (error) {
      button.disabled = false;
      button.textContent = "Send enquiry";
      errorBox.textContent =
        error instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : error.message;
    });
});
