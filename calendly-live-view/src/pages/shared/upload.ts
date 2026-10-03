// File pickers on the public forms (onboarding, payment, booking's interview invite): what kind of file was chosen,
// its size for people, and shrinking a big photo before it is sent.
export const isImage = (file: File) => /^image\//.test(file.type) || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name);
export const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);
export function sizeText(bytes: number) {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : Math.round((bytes / 1048576) * 10) / 10 + " MB";
}
// A photo over max bytes, drawn smaller as a JPEG until it fits. A photo the browser can't open (HEIC outside Safari)
// is sent as it is, and the server answers if it is too big.
export async function shrink(file: File, max: number): Promise<Blob> {
  if (!isImage(file) || file.size <= max) {
    return file;
  }
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    return file;
  }
  let side = 2000;
  for (let i = 0; i < 4; i++, side = Math.round(side * 0.75)) {
    const scale = Math.min(1, side / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(function (resolve) {
      canvas.toBlob(resolve, "image/jpeg", 0.85);
    });
    if (blob && blob.size <= max) {
      return blob;
    }
  }
  return file;
}
// The name a shrunk photo is sent under: the original's, as a .jpg.
export const sentName = (file: File, sent: Blob) => (sent === file ? file.name : file.name.replace(/\.[^.]*$/, "") + ".jpg");
