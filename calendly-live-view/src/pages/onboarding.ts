// The public onboarding form (/onboarding): name, email, phone, technology, experience, whether that experience is genuine, a LinkedIn profile and the candidate's Aadhaar and
// PAN cards (each a photo or a PDF), sent as one multipart request to /api/onboarding. Phone photos are often several MB,
// so a photo bigger than the server's limit (the boot block) is shrunk to a JPEG first; a PDF can't be, and is only
// refused when too big. The same rules are checked again on the server.
import { isImage, isPdf, sentName, shrink, sizeText } from "./shared/upload";
const MAX_BYTES: number = JSON.parse(document.getElementById("boot")!.textContent).max;
const MAX_TEXT = Math.round((MAX_BYTES / 1048576) * 10) / 10 + " MB";
const form = document.getElementById("f") as HTMLFormElement;
const button = document.getElementById("go") as HTMLButtonElement;
const errorBox = document.getElementById("err") as HTMLElement;
const fields = {
  name: document.getElementById("nm") as HTMLInputElement,
  email: document.getElementById("em") as HTMLInputElement,
  phone: document.getElementById("ph") as HTMLInputElement,
  tech: document.getElementById("tc") as HTMLInputElement,
  experience: document.getElementById("yx") as HTMLSelectElement,
  genuine: document.getElementById("gn") as HTMLSelectElement,
  linkedin: document.getElementById("li") as HTMLInputElement,
};
// each card: its form field, the input's id and its name in messages
const CARDS = [
  { key: "aadhaar", id: "ad", label: "Aadhaar card" },
  { key: "pan", id: "pn", label: "PAN card" },
];
const inputOf = (id: string) => document.getElementById(id) as HTMLInputElement;
// What is wrong with a chosen file before it is sent. Big photos are fine here: they are shrunk on the way.
function fileProblem(file: File | undefined, label: string) {
  if (!file) {
    return "Add your " + label + ".";
  } else if (!isImage(file) && !isPdf(file)) {
    return "Your " + label + " must be a photo or a PDF.";
  } else if (!file.size) {
    return "That file is empty.";
  } else if (isPdf(file) && file.size > MAX_BYTES) {
    return "Your " + label + " file is larger than " + MAX_TEXT + ". Please upload a smaller file.";
  } else {
    return "";
  }
}
function showFile(card: (typeof CARDS)[number]) {
  const file = inputOf(card.id).files![0];
  const problem = file ? fileProblem(file, card.label) : "";
  document.getElementById(card.id + "name")!.textContent = file ? file.name : "Upload your " + card.label;
  document.getElementById(card.id + "hint")!.textContent = problem || (file ? sizeText(file.size) + " · tap to change" : "A photo or PDF");
  document.getElementById(card.id + "box")!.classList.toggle("bad", !!problem);
  document.getElementById(card.id + "box")!.classList.toggle("has", !!file && !problem);
}
CARDS.forEach(function (card) {
  inputOf(card.id).addEventListener("change", function () {
    showFile(card);
  });
});
// a field someone is fixing stops showing as wrong
function fixing(event: Event) {
  if ((event.target as HTMLElement).getAttribute("aria-invalid") === "true") {
    (event.target as HTMLElement).setAttribute("aria-invalid", "false");
    errorBox.textContent = "";
  }
}
form.addEventListener("input", fixing);
form.addEventListener("change", fixing);
function check() {
  const problems: { input: HTMLElement; text: string }[] = [];
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
  need(fields.tech, fields.tech.value.trim().length >= 2, "Tell us your technology.");
  need(fields.experience, !!fields.experience.value, "Choose your years of experience.");
  need(fields.genuine, !!fields.genuine.value, "Tell us whether your experience is genuine.");
  need(
    fields.linkedin,
    /^(https?:\/\/)?([a-z]{2,3}\.)?linkedin\.com\/\S+$/i.test(fields.linkedin.value.trim()),
    "Enter your LinkedIn profile link, like linkedin.com/in/your-name.",
  );
  CARDS.forEach(function (card) {
    const text = fileProblem(inputOf(card.id).files![0], card.label);
    document.getElementById(card.id + "box")!.classList.toggle("bad", !!text);
    if (text) {
      problems.push({ input: inputOf(card.id), text: text });
    }
  });
  return problems;
}
async function formData() {
  const data = new FormData(form);
  for (const card of CARDS) {
    const file = inputOf(card.id).files![0];
    const sent = await shrink(file, MAX_BYTES);
    data.set(card.key, sent, sentName(file, sent));
  }
  return data;
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
  formData()
    .then(function (body) {
      return fetch("/api/onboarding", { method: "POST", body: body });
    })
    .then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          if (!response.ok) {
            // the server refused a field: mark it
            const card = CARDS.find(function (c) {
              return c.key === body.field;
            });
            const field = card ? inputOf(card.id) : fields[body.field as keyof typeof fields];
            if (field) {
              field.setAttribute("aria-invalid", "true");
              if (card) {
                document.getElementById(card.id + "box")!.classList.add("bad");
              }
              field.focus();
            }
            throw new Error(body.error || "Couldn't send your details. Try again.");
          }
        });
    })
    .then(function () {
      form.hidden = true;
      document.getElementById("donetxt")!.textContent =
        "Thanks, " +
        fields.name.value.trim().split(/\s+/)[0] +
        ". We've received your details, and you can now book your slot. Always book with " +
        fields.email.value.trim() +
        ".";
      document.getElementById("done")!.hidden = false;
      window.scrollTo(0, 0);
    })
    .catch(function (error) {
      button.disabled = false;
      button.classList.remove("busy");
      button.textContent = "Submit";
      errorBox.textContent = error instanceof TypeError ? "Couldn't reach the server. Check your connection and try again." : error.message;
    });
});
