// The public enquiry form (/enquiry): name, email, phone, technology, experience and a resume (PDF or Word, 200 KB at most),
// sent as one multipart request to /api/enquiry. The same rules are checked again on the server.
const MAX_BYTES = 200 * 1024;
const form = document.getElementById("f") as HTMLFormElement;
const fileInput = document.getElementById("cv") as HTMLInputElement;
const button = document.getElementById("go") as HTMLButtonElement;
const errorBox = document.getElementById("err") as HTMLElement;
const fields = {
  name: document.getElementById("nm") as HTMLInputElement,
  email: document.getElementById("em") as HTMLInputElement,
  phone: document.getElementById("ph") as HTMLInputElement,
  tech: document.getElementById("tc") as HTMLInputElement,
  experience: document.getElementById("yx") as HTMLSelectElement,
};
function fileProblem(file: File | undefined) {
  if (!file) {
    return "Add your resume.";
  } else if (!/\.(pdf|docx?)$/i.test(file.name)) {
    return "The resume must be a PDF or Word file.";
  } else if (file.size > MAX_BYTES) {
    return "Your resume is larger than 200 KB. Please upload a smaller file.";
  } else if (!file.size) {
    return "That file is empty.";
  } else {
    return "";
  }
}
function showFile() {
  const file = fileInput.files![0];
  const problem = file ? fileProblem(file) : "";
  document.getElementById("cvname")!.textContent = file ? file.name : "Choose your resume";
  document.getElementById("cvhint")!.textContent =
    problem || (file ? Math.max(1, Math.round(file.size / 1024)) + " KB · tap to change" : "PDF or Word");
  document.getElementById("dropbox")!.classList.toggle("bad", !!problem);
  document.getElementById("dropbox")!.classList.toggle("has", !!file && !problem);
}
fileInput.addEventListener("change", showFile);
// a field someone is fixing stops showing as wrong
form.addEventListener("input", function (event) {
  if ((event.target as HTMLElement).getAttribute("aria-invalid") === "true") {
    (event.target as HTMLElement).setAttribute("aria-invalid", "false");
    errorBox.textContent = "";
  }
});
function check() {
  const problems = [];
  function need(input: HTMLElement, ok: boolean, text: string) {
    input.setAttribute("aria-invalid", String(!ok));
    if (!ok) {
      problems.push({ input: input, text: text });
    }
  }
  need(fields.name, fields.name.value.trim().length >= 2, "Enter your full name.");
  need(fields.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.value.trim()), "Enter a valid email address.");
  const digits = fields.phone.value.replace(/\D/g, "");
  need(fields.phone, digits.length >= 10 && digits.length <= 15, "Enter a valid phone number.");
  need(fields.tech, fields.tech.value.trim().length >= 2, "Tell us the technology you're looking for.");
  need(fields.experience, !!fields.experience.value, "Choose your years of experience.");
  const fileText = fileProblem(fileInput.files![0]);
  document.getElementById("dropbox")!.classList.toggle("bad", !!fileText);
  if (fileText) {
    problems.push({ input: fileInput, text: fileText });
  }
  return problems;
}
form.addEventListener("submit", function (event) {
  event.preventDefault();
  errorBox.textContent = "";
  const problems = check();
  if (problems.length) {
    errorBox.textContent = problems[0].text;
    problems[0].input.focus();
    return;
  }
  button.disabled = true;
  button.classList.add("busy");
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
      document.getElementById("donetxt")!.textContent =
        "Thanks, " + fields.name.value.trim().split(/\s+/)[0] + ". We've received your enquiry and will get back to you soon.";
      document.getElementById("done")!.hidden = false;
      window.scrollTo(0, 0);
    })
    .catch(function (error) {
      button.disabled = false;
      button.classList.remove("busy");
      button.textContent = "Send enquiry";
      errorBox.textContent = error instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : error.message;
    });
});
