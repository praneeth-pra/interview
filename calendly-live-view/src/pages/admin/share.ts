// Phones and tablets that can share files get downloads through the share sheet (Save Image, Save to Files, Mail,
// WhatsApp...): on an iPhone, and above all in the home-screen app, a download opens a file viewer with no way to save
// or send it and no way back to the page. Desktops keep the plain download.
export function sharesFiles(type: string) {
  try {
    const probe = new File([""], "probe", { type: type });
    return matchMedia("(pointer: coarse)").matches && !!navigator.canShare && navigator.canShare({ files: [probe] });
  } catch (e) {
    return false;
  }
}
// On such a phone, a download link opens the share sheet with its file instead of leaving the page. Safari only opens
// the sheet straight from the tap, so the file is fetched as soon as the link is made; a tap before it has arrived
// shares it once it does. The file keeps the name the server gives the download.
export function shareOnTap(link: HTMLAnchorElement, type: string, title: string) {
  if (!sharesFiles(type)) {
    return;
  }
  let file: File | null = null;
  const ready = fetch(link.href, { credentials: "same-origin" })
    .then(function (r) {
      return r.ok ? r.blob().then((blob) => new File([blob], savedName(r.headers.get("Content-Disposition")), { type: blob.type })) : null;
    })
    .then(function (got) {
      file = got;
      return got;
    })
    .catch(function () {
      return null;
    });
  link.addEventListener("click", function (event) {
    event.preventDefault();
    (file ? Promise.resolve(file) : ready).then(function (got) {
      if (got) {
        navigator.share({ files: [got], title: title }).catch(function () {
          // closed without sharing
        });
      }
    });
  });
}
function savedName(disposition: string | null) {
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition || "");
  try {
    return utf8 ? decodeURIComponent(utf8[1]) : "download";
  } catch (e) {
    return "download";
  }
}
