// The interview invite on the details step: a screenshot or PDF of the company's invite email or message. A phone photo
// bigger than the server's limit (the boot block) is shrunk to a JPEG before sending; a PDF can't be, and is refused
// here when too big. The server checks the file again and reads the HR's email and phone number from it.
import { el } from "../shared/dom";
import { boot, state } from "./app";

const MAX_BYTES: number = boot.inviteMax;
const MAX_TEXT = Math.round((MAX_BYTES / 1048576) * 10) / 10 + " MB";
export const INVITE_NEEDED = "Add a screenshot or PDF of your interview invite.";
const isImage = (file: File) => /^image\//.test(file.type) || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name);
const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
// What is wrong with the chosen file before it is sent ("" when nothing). Big photos are fine: they are shrunk.
export function inviteProblem(file: File | null | undefined) {
  if (!file) {
    return INVITE_NEEDED;
  } else if (!isImage(file) && !isPdf(file)) {
    return "The invite must be a screenshot, a photo or a PDF.";
  } else if (!file.size) {
    return "That file is empty.";
  } else if (isPdf(file) && file.size > MAX_BYTES) {
    return "Your invite file is larger than " + MAX_TEXT + ". Please upload a screenshot instead.";
  }
  return "";
}
function sizeText(bytes: number) {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : Math.round((bytes / 1048576) * 10) / 10 + " MB";
}
// The upload box: the real file input covers it, invisible, so the whole box is what people tap.
export function inviteField() {
  const file = state.invite || null;
  const error = state.fieldErr.invite;
  const name = el("b", { text: file ? file.name : "Upload a screenshot of your invite" });
  const hint = el("small", {
    id: "finvh",
    text: file ? sizeText(file.size) + " · tap to change" : "The email or message the company sent you, as a screenshot or PDF",
  });
  const box = el("label", { class: "inv" + (error ? " bad" : file ? " has" : ""), for: "finv" }, [
    el("span", {
      class: "inv-i",
      "aria-hidden": "true",
      html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
    }),
    el("span", { class: "inv-t" }, [name, hint]),
  ]);
  const input = el("input", {
    id: "finv",
    name: "invite",
    type: "file",
    accept: "image/*,.pdf,application/pdf",
    required: true,
    "aria-invalid": error ? "true" : null,
    "aria-describedby": error ? "finve" : "finvh",
  });
  input.addEventListener("change", function () {
    const chosen = input.files && input.files[0];
    if (!chosen) {
      return;
    }
    state.invite = chosen;
    const problem = inviteProblem(chosen);
    name.textContent = chosen.name;
    hint.textContent = sizeText(chosen.size) + " · tap to change";
    box.classList.toggle("bad", !!problem);
    box.classList.toggle("has", !problem);
    if (problem) {
      state.fieldErr.invite = problem;
    } else {
      delete state.fieldErr.invite;
    }
    input.setAttribute("aria-invalid", problem ? "true" : "false");
    input.setAttribute("aria-describedby", problem ? "finve" : "finvh");
    const old = document.getElementById("finve");
    if (old) {
      old.remove();
    }
    if (problem) {
      box.after(el("div", { class: "ferr", id: "finve", text: problem }));
    }
  });
  box.insertBefore(input, box.firstChild);
  return el("div", { class: "f" }, [
    el("label", { for: "finv" }, ["Interview invite *"]),
    box,
    error ? el("div", { class: "ferr", id: "finve", text: error }) : null,
  ]);
}
// A photo over the limit, drawn smaller as a JPEG until it fits. A photo the browser can't open (HEIC outside Safari)
// is sent as it is, and the server answers if it is too big.
async function shrink(file: File): Promise<Blob> {
  if (!isImage(file) || file.size <= MAX_BYTES) {
    return file;
  }
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    return file;
  }
  let side = 2400;
  for (let i = 0; i < 4; i++, side = Math.round(side * 0.75)) {
    const scale = Math.min(1, side / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", 0.88);
    });
    if (blob && blob.size <= MAX_BYTES) {
      return blob;
    }
  }
  return file;
}
// The booking as a multipart form: the fields, and the invite (shrunk when it is a big photo).
export async function bookingForm(fields: Record<string, string | number>, file: File) {
  const data = new FormData();
  for (const key in fields) {
    data.set(key, String(fields[key]));
  }
  const sent = await shrink(file);
  data.set("invite", sent, sent === file ? file.name : file.name.replace(/\.[^.]*$/, "") + ".jpg");
  return data;
}
