// Offline preflight of a PDF written by `print`: a pure byte scan (bytes plus
// expectations in, rows out) with honest `unknown`. No dependency beyond
// node:zlib.
//
// What the scan sees, from real Affinity 3.3.1 exports (see test/live/print-probe.js):
//   - PDF/X-1a and X-3 files are PDF 1.4 with plain page objects.
//   - PDF/X-4 and "PDF (press ready)" are PDF 1.6/1.7: the page, its boxes and the
//     output intent sit inside a Flate-compressed /ObjStm, so the scan inflates every
//     object stream first. Only when one cannot be inflated is a box check `unknown`.
//   - Colour lives in the page content stream (`k` is CMYK fill, `rg` is RGB fill),
//     which is inflated too (small streams only, never images, ICC profiles or XRef).
//   - "PDF (press ready)" carries bleed as MediaBox > TrimBox and has no BleedBox key;
//     the PDF/X presets export the trim area only (MediaBox = TrimBox).

import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";

export interface PreflightRow {
  check: string;
  status: "ok" | "warn" | "fail" | "unknown";
  note: string;
}

export interface PreflightWant {
  pdfx: boolean;
  bleed: boolean;
  cmyk: boolean;
}

const MAX_INFLATED = 32 * 1024 * 1024;
const CONTENT_STREAM_MAX = 2 * 1024 * 1024;
const EPS = 0.02;

interface Scan {
  text: string;
  content: string;
  hidden: boolean;
}

/** Raw bytes as text, plus every inflatable object stream, plus small content streams. */
function scan(bytes: Buffer): Scan {
  const raw = bytes.toString("latin1");
  const decoded: string[] = [];
  const content: string[] = [];
  let hidden = false;
  let budget = MAX_INFLATED;
  const re = />>\s*stream\r?\n/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const start = m.index + m[0].length;
    const objStart = Math.max(raw.lastIndexOf(" obj", m.index), raw.lastIndexOf("\nobj", m.index));
    const dict = raw.slice(objStart < 0 ? 0 : objStart, m.index + 2);
    const objStm = /\/Type\s*\/ObjStm/.test(dict);
    const skip = /\/Type\s*\/(XRef|Metadata)|\/Subtype\s*\/(Image|XML)|\/N\s+\d|\/Length1/.test(dict);
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    if (!objStm && (skip || !/\/FlateDecode/.test(dict) || end - start > CONTENT_STREAM_MAX)) continue;
    if (objStm && !/\/FlateDecode/.test(dict)) {
      hidden = true;
      continue;
    }
    try {
      const out = inflateSync(bytes.subarray(start, end), { maxOutputLength: Math.max(1, budget) });
      budget -= out.length;
      (objStm ? decoded : content).push(out.toString("latin1"));
    } catch {
      if (objStm) hidden = true;
    }
  }
  return { text: raw + "\n" + decoded.join("\n"), content: content.join("\n"), hidden };
}

type Box = [number, number, number, number];

function boxOf(text: string, key: string): Box | null {
  const m = new RegExp(`/${key}\\s*\\[\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s*\\]`).exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

const same = (a: Box, b: Box): boolean => a.every((v, i) => Math.abs(v - b[i]!) < EPS);
const fmt = (b: Box): string => `[${b.map((v) => Math.round(v * 100) / 100).join(" ")}]`;
const mm = (pt: number): string => `${Math.round((pt / 72) * 25.4 * 100) / 100} mm`;

function absent(hidden: boolean, status: "fail" | "warn", note: string): { status: PreflightRow["status"]; note: string } {
  return hidden
    ? { status: "unknown", note: `${note} not seen, and some compressed objects could not be read` }
    : { status, note: `${note} not found` };
}

/** Largest gap between the MediaBox and the TrimBox on any side, in pt. */
function marginOf(media: Box, trim: Box): number {
  return Math.max(trim[0] - media[0], trim[1] - media[1], media[2] - trim[2], media[3] - trim[3]);
}

export function preflightPdf(bytes: Buffer, want: PreflightWant): PreflightRow[] {
  const head = bytes.subarray(0, 1024).toString("latin1");
  const ver = /%PDF-(\d\.\d)/.exec(head);
  if (!ver) return [{ check: "pdf-header", status: "fail", note: "no %PDF- header in the first 1024 bytes: not a PDF" }];
  const rows: PreflightRow[] = [{ check: "pdf-header", status: "ok", note: `PDF ${ver[1]}` }];
  const s = scan(bytes);
  const t = s.text;

  if (want.pdfx) {
    const v = /\/GTS_PDFXVersion\s*\(([^)]*)\)/.exec(t);
    if (v) rows.push({ check: "pdfx-version", status: "ok", note: v[1]! });
    else rows.push({ check: "pdfx-version", ...absent(s.hidden, "fail", "/GTS_PDFXVersion") });
  }

  if (/\/OutputIntents?\b/.test(t)) {
    const c = /\/OutputConditionIdentifier\s*\(((?:[^()\\]|\\.|\([^)]*\))*)\)/.exec(t);
    rows.push({ check: "output-intent", status: "ok", note: c ? c[1]!.replace(/\\(.)/g, "$1") : "present" });
  } else rows.push({ check: "output-intent", ...absent(s.hidden, want.pdfx ? "fail" : "warn", "/OutputIntents") });

  const media = boxOf(t, "MediaBox");
  const trim = boxOf(t, "TrimBox");
  const bleed = boxOf(t, "BleedBox");
  rows.push(trim ? { check: "trim-box", status: "ok", note: fmt(trim) } : { check: "trim-box", ...absent(s.hidden, want.pdfx ? "fail" : "warn", "/TrimBox") });

  if (!want.bleed) rows.push({ check: "bleed-box", status: "ok", note: "bleed not requested" });
  else if (bleed && trim) {
    if (same(bleed, trim)) rows.push({ check: "bleed-box", status: "warn", note: `BleedBox equals TrimBox ${fmt(trim)}: the file carries no bleed` });
    else rows.push({ check: "bleed-box", status: "ok", note: `BleedBox ${fmt(bleed)} reaches ${mm(marginOf(bleed, trim))} past the trim` });
  } else if (media && trim) {
    const m = marginOf(media, trim);
    if (m > EPS) rows.push({ check: "bleed-box", status: "ok", note: `no BleedBox key; the MediaBox reaches ${mm(m)} past the trim, which is the bleed` });
    else rows.push({ check: "bleed-box", status: "warn", note: `MediaBox equals TrimBox ${fmt(trim)}: the file carries no bleed` });
  } else rows.push({ check: "bleed-box", ...absent(s.hidden, "warn", "/BleedBox and /TrimBox") });

  const cmykHit = /\/DeviceCMYK\b/.test(t + s.content) || /(?:^|\s)(?:[\d.]+\s+){4}[kK](?=\s|$)/m.test(s.content);
  const rgbHit = /\/DeviceRGB\b/.test(t + s.content) || /(?:^|\s)(?:[\d.]+\s+){3}(?:rg|RG)(?=\s|$)/m.test(s.content);
  if (!want.cmyk) rows.push({ check: "cmyk", status: "ok", note: `not requested (${cmykHit ? "CMYK" : "no CMYK"}${rgbHit ? ", RGB" : ""} seen)` });
  else if (cmykHit && !rgbHit) rows.push({ check: "cmyk", status: "ok", note: "CMYK colour, no RGB" });
  else if (cmykHit && rgbHit) rows.push({ check: "cmyk", status: "warn", note: "both CMYK and RGB colour are used" });
  else if (rgbHit) rows.push({ check: "cmyk", status: "fail", note: "RGB colour and no CMYK: convert the document (print --cmyk) or build it with axiPrintDoc({cmyk: true})" });
  else rows.push({ check: "cmyk", status: "unknown", note: "no colour operators found (empty page, or content streams not readable)" });

  if (/\/Type\s*\/Font(?![A-Za-z])/.test(t) || /\/BaseFont\b/.test(t)) {
    const embedded = /\/FontFile[23]?\b/.test(t);
    rows.push(embedded ? { check: "fonts-embedded", status: "ok", note: "font programs found" } : { check: "fonts-embedded", ...absent(s.hidden, "fail", "/FontFile") });
  } else rows.push({ check: "fonts-embedded", status: "ok", note: "no fonts used" });

  const pages = (t.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  if (pages > 0) rows.push({ check: "page-count", status: "ok", note: String(pages) });
  else rows.push({ check: "page-count", status: s.hidden ? "unknown" : "fail", note: s.hidden ? "page objects are in compressed streams that could not be read" : "no /Type /Page object found" });
  return rows;
}

function run(tool: string, args: string[]): string | null {
  try {
    return execFileSync(tool, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** Extra rows from exiftool, pdfinfo or qpdf, whichever is first on PATH. Null when none is. */
export function externalPdfInfo(file: string): { tool: string; rows: PreflightRow[] } | null {
  const ex = run("exiftool", ["-j", "-PDFVersion", "-PageCount", "-Producer", file]);
  if (ex !== null) {
    try {
      const r = (JSON.parse(ex) as Array<Record<string, unknown>>)[0] ?? {};
      const rows: PreflightRow[] = [];
      if (r["PDFVersion"] !== undefined) rows.push({ check: "tool-pdf-version", status: "ok", note: `${String(r["PDFVersion"])} (exiftool)` });
      if (r["PageCount"] !== undefined) rows.push({ check: "tool-page-count", status: "ok", note: `${String(r["PageCount"])} (exiftool)` });
      if (r["Producer"] !== undefined) rows.push({ check: "tool-producer", status: "ok", note: String(r["Producer"]) });
      return { tool: "exiftool", rows };
    } catch {
      // fall through to the next tool
    }
  }
  const pi = run("pdfinfo", [file]);
  if (pi !== null) {
    const rows: PreflightRow[] = [];
    const v = /PDF version:\s*(\S+)/.exec(pi);
    const p = /Pages:\s*(\d+)/.exec(pi);
    if (v) rows.push({ check: "tool-pdf-version", status: "ok", note: `${v[1]} (pdfinfo)` });
    if (p) rows.push({ check: "tool-page-count", status: "ok", note: `${p[1]} (pdfinfo)` });
    return { tool: "pdfinfo", rows };
  }
  const q = run("qpdf", ["--check", file]);
  if (q !== null) return { tool: "qpdf", rows: [{ check: "tool-structure", status: "ok", note: "qpdf --check found no errors" }] };
  return null;
}
