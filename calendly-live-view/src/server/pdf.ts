// A small PDF writer for the revenue report: pages of text, filled shapes and lines, nothing more. Text uses TrueType
// fonts embedded whole (src/fonts/pdf: static, subset copies of the site's Figtree and Instrument Serif, so ₹ prints and
// the report looks like the site); each character is written as its glyph number, with a ToUnicode map so the text can
// still be searched and copied. Coordinates are points from the top left of an A4 page.
import { deflateSync } from "node:zlib";

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

// What the writer needs from a TrueType file: its glyph for each character and how wide each glyph is.
export type Font = {
  name: string;
  data: Uint8Array;
  upm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  bbox: [number, number, number, number];
  widths: number[]; // per glyph, in font units
  glyphOf: Map<number, number>; // code point -> glyph
};

export function loadFont(name: string, data: Uint8Array): Font {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const at = 12 + i * 16;
    tables.set(String.fromCharCode(...data.subarray(at, at + 4)), v.getUint32(at + 8));
  }
  const t = (tag: string) => {
    const at = tables.get(tag);
    if (at === undefined) throw new Error("font " + name + " has no " + tag + " table");
    return at;
  };
  const head = t("head");
  const upm = v.getUint16(head + 18);
  const bbox: [number, number, number, number] = [
    v.getInt16(head + 36),
    v.getInt16(head + 38),
    v.getInt16(head + 40),
    v.getInt16(head + 42),
  ];
  const hhea = t("hhea");
  const longMetrics = v.getUint16(hhea + 34);
  const glyphs = v.getUint16(t("maxp") + 4);
  const hmtx = t("hmtx");
  const widths: number[] = [];
  for (let g = 0; g < glyphs; g++) widths.push(v.getUint16(hmtx + Math.min(g, longMetrics - 1) * 4));
  const os2 = tables.get("OS/2");
  const capHeight = os2 !== undefined && v.getUint16(os2) >= 2 ? v.getInt16(os2 + 88) : v.getInt16(hhea + 4);
  const post = tables.get("post");
  const italicAngle = post !== undefined ? v.getInt32(post + 4) / 65536 : 0;
  // the Unicode BMP character map (platform 3, encoding 1, format 4)
  const cmap = t("cmap");
  let sub = -1;
  for (let i = 0, n = v.getUint16(cmap + 2); i < n; i++) {
    const at = cmap + 4 + i * 8;
    if (v.getUint16(at) === 3 && v.getUint16(at + 2) === 1) sub = cmap + v.getUint32(at + 4);
  }
  if (sub < 0 || v.getUint16(sub) !== 4) throw new Error("font " + name + " has no Unicode character map");
  const segs = v.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const offsets = deltas + segs * 2;
  const glyphOf = new Map<number, number>();
  for (let s = 0; s < segs; s++) {
    const end = v.getUint16(ends + s * 2);
    const start = v.getUint16(starts + s * 2);
    const delta = v.getInt16(deltas + s * 2);
    const ro = v.getUint16(offsets + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g: number;
      if (!ro) g = (c + delta) & 0xffff;
      else {
        g = v.getUint16(offsets + s * 2 + ro + (c - start) * 2);
        if (g) g = (g + delta) & 0xffff;
      }
      if (g) glyphOf.set(c, g);
    }
  }
  return { name, data, upm, ascent: v.getInt16(hhea + 4), descent: v.getInt16(hhea + 6), capHeight, italicAngle, bbox, widths, glyphOf };
}

export type Rgb = string; // "#rrggbb"
const rgb = (c: Rgb) => [1, 3, 5].map((i) => +(parseInt(c.slice(i, i + 2), 16) / 255).toFixed(3)).join(" ");
const n = (x: number) => +x.toFixed(2);

export class Pdf {
  private pages: string[] = [];
  private fonts: Font[] = [];
  private used = new Map<Font, Map<number, number>>(); // glyph -> code point, for ToUnicode
  private ops: string[] = [];
  constructor(private background = "") {
    this.addPage();
  }
  addPage() {
    if (this.ops.length || this.pages.length) this.pages.push(this.ops.join("\n"));
    this.ops = [];
    if (this.background) this.rect(0, 0, PAGE_W, PAGE_H, this.background);
  }
  private fontId(f: Font) {
    if (!this.fonts.includes(f)) this.fonts.push(f);
    return "F" + this.fonts.indexOf(f);
  }
  width(text: string, f: Font, size: number, spacing = 0) {
    let w = 0;
    for (const ch of text) w += f.widths[f.glyphOf.get(ch.codePointAt(0)!) ?? 0] + spacing * (f.upm / size);
    return (w / f.upm) * size;
  }
  // x, y: the start of the text's baseline. align moves x to the text's centre or end.
  text(
    text: string,
    x: number,
    y: number,
    f: Font,
    size: number,
    color: Rgb,
    o: { align?: "left" | "center" | "right"; spacing?: number } = {},
  ) {
    const w = this.width(text, f, size, o.spacing ?? 0);
    const left = o.align === "right" ? x - w : o.align === "center" ? x - w / 2 : x;
    const used = this.used.get(f) ?? new Map<number, number>();
    this.used.set(f, used);
    let hex = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      const g = f.glyphOf.get(cp) ?? 0;
      if (g) used.set(g, cp);
      hex += g.toString(16).padStart(4, "0");
    }
    this.ops.push(
      `BT /${this.fontId(f)} ${n(size)} Tf ${n(o.spacing ?? 0)} Tc ${rgb(color)} rg ${n(left)} ${n(PAGE_H - y)} Td <${hex}> Tj ET`,
    );
    return w;
  }
  // Breaks text into lines no wider than width.
  wrap(text: string, f: Font, size: number, width: number) {
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = line ? line + " " + word : word;
      if (line && this.width(next, f, size) > width) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  rect(x: number, y: number, w: number, h: number, fill: Rgb, o: { radius?: number; stroke?: Rgb; lineWidth?: number } = {}) {
    const r = Math.min(o.radius ?? 0, w / 2, h / 2);
    const [x0, y0, x1, y1] = [x, PAGE_H - y - h, x + w, PAGE_H - y];
    let path: string;
    if (!r) path = `${n(x0)} ${n(y0)} ${n(w)} ${n(h)} re`;
    else {
      const k = r * 0.4477; // 1 - 0.5523: the control point of a quarter circle
      path = [
        `${n(x0 + r)} ${n(y0)} m`,
        `${n(x1 - r)} ${n(y0)} l`,
        `${n(x1 - k)} ${n(y0)} ${n(x1)} ${n(y0 + k)} ${n(x1)} ${n(y0 + r)} c`,
        `${n(x1)} ${n(y1 - r)} l`,
        `${n(x1)} ${n(y1 - k)} ${n(x1 - k)} ${n(y1)} ${n(x1 - r)} ${n(y1)} c`,
        `${n(x0 + r)} ${n(y1)} l`,
        `${n(x0 + k)} ${n(y1)} ${n(x0)} ${n(y1 - k)} ${n(x0)} ${n(y1 - r)} c`,
        `${n(x0)} ${n(y0 + r)} l`,
        `${n(x0)} ${n(y0 + k)} ${n(x0 + k)} ${n(y0)} ${n(x0 + r)} ${n(y0)} c h`,
      ].join(" ");
    }
    const paint = fill && o.stroke ? "B" : o.stroke ? "S" : "f";
    this.ops.push(
      `${fill ? rgb(fill) + " rg " : ""}${o.stroke ? rgb(o.stroke) + " RG " + n(o.lineWidth ?? 0.75) + " w " : ""}${path} ${paint}`,
    );
  }
  line(x0: number, y0: number, x1: number, y1: number, color: Rgb, width = 0.75, round = false) {
    this.ops.push(`${rgb(color)} RG ${n(width)} w ${round ? 1 : 0} J ${n(x0)} ${n(PAGE_H - y0)} m ${n(x1)} ${n(PAGE_H - y1)} l S 0 J`);
  }
  polygon(points: [number, number][], fill: Rgb) {
    const [first, ...rest] = points;
    this.ops.push(
      `${rgb(fill)} rg ${n(first[0])} ${n(PAGE_H - first[1])} m ${rest.map(([x, y]) => n(x) + " " + n(PAGE_H - y) + " l").join(" ")} h f`,
    );
  }
  // The finished file.
  build(title: string) {
    this.pages.push(this.ops.join("\n"));
    this.ops = [];
    const objs: (string | Uint8Array)[] = [];
    const add = (body: string | Uint8Array) => (objs.push(body), objs.length);
    const stream = (dict: string, data: Uint8Array | string) => {
      const raw = typeof data === "string" ? Buffer.from(data, "latin1") : data;
      const z = deflateSync(raw);
      return Buffer.concat([
        Buffer.from(`<< ${dict} /Filter /FlateDecode /Length ${z.length} >>\nstream\n`, "latin1"),
        z,
        Buffer.from("\nendstream"),
      ]);
    };
    const catalog = add("");
    const pagesId = add("");
    const fontRefs = this.fonts.map((f, i) => {
      const scale = 1000 / f.upm;
      const file = add(stream(`/Length1 ${f.data.length}`, f.data));
      const desc = add(
        `<< /Type /FontDescriptor /FontName /${f.name} /Flags ${f.italicAngle ? 96 : 32} /FontBBox [${f.bbox.map((x) => Math.round(x * scale)).join(" ")}] ` +
          `/ItalicAngle ${f.italicAngle} /Ascent ${Math.round(f.ascent * scale)} /Descent ${Math.round(f.descent * scale)} ` +
          `/CapHeight ${Math.round(f.capHeight * scale)} /StemV 80 /FontFile2 ${file} 0 R >>`,
      );
      const cid = add(
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
          `/FontDescriptor ${desc} 0 R /CIDToGIDMap /Identity /W [0 [${f.widths.map((w) => Math.round(w * scale)).join(" ")}]] >>`,
      );
      const used = [...(this.used.get(f) ?? new Map<number, number>())].sort((a, b) => a[0] - b[0]);
      const hex4 = (x: number) => x.toString(16).padStart(4, "0");
      const chunks: string[] = [];
      for (let j = 0; j < used.length; j += 100) {
        const part = used.slice(j, j + 100);
        chunks.push(part.length + " beginbfchar\n" + part.map(([g, cp]) => `<${hex4(g)}> <${hex4(cp)}>`).join("\n") + "\nendbfchar");
      }
      const cmap =
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def " +
        "/CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange\n" +
        chunks.join("\n") +
        "\nendcmap CMapName currentdict /CMap defineresource pop end end";
      const toUnicode = add(stream("", cmap));
      const font = add(
        `<< /Type /Font /Subtype /Type0 /BaseFont /${f.name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
      );
      return `/F${i} ${font} 0 R`;
    });
    const resources = `<< /Font << ${fontRefs.join(" ")} >> >>`;
    const kids = this.pages.map((ops) => {
      const content = add(stream("", ops));
      return add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${content} 0 R >>`,
      );
    });
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + " 0 R").join(" ")}] /Count ${kids.length} >>`;
    // the title in UTF-16 with a byte order mark, so any character shows in the reader's title bar
    const utf16 = Buffer.from("﻿" + title, "utf16le")
      .swap16()
      .toString("hex");
    const info = add(`<< /Title <${utf16}> /Producer (Hi-Techie) >>`);
    const parts: Buffer[] = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let at = parts[0].length;
    const offsets: number[] = [];
    objs.forEach((body, i) => {
      const chunk = Buffer.concat([
        Buffer.from(`${i + 1} 0 obj\n`, "latin1"),
        typeof body === "string" ? Buffer.from(body, "latin1") : body,
        Buffer.from("\nendobj\n", "latin1"),
      ]);
      offsets.push(at);
      parts.push(chunk);
      at += chunk.length;
    });
    const xref =
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("") +
      `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(Buffer.from(xref, "latin1"));
    return Buffer.concat(parts);
  }
}
