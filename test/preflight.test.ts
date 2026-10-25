// preflightPdf and externalPdfInfo on synthetic PDFs built here (no Affinity, no real export).

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { externalPdfInfo, preflightPdf, type PreflightRow } from "../src/affinity/preflight.js";

const WANT = { pdfx: true, bleed: true, cmyk: true };

function stream(dict: string, body: Buffer | string): string {
  const b = Buffer.isBuffer(body) ? body.toString("latin1") : body;
  return `<<${dict}>>\nstream\n${b}\nendstream\n`;
}

interface Spec {
  version?: string;
  media?: string;
  trim?: string | null;
  bleed?: string | null;
  pdfx?: string | null;
  intent?: boolean;
  content?: string;
  fonts?: "embedded" | "bare" | "none";
  objstm?: "good" | "garbage" | "none";
}

/** A tiny but structurally honest PDF: header, page, catalog, content stream, optional object stream. */
function pdf(s: Spec = {}): Buffer {
  const boxes = (): string =>
    `/MediaBox[${s.media ?? "0 0 436.77 612.45"}]` +
    (s.trim === null ? "" : `/TrimBox[${s.trim ?? "8.5 8.5 428.26 603.94"}]`) +
    (s.bleed ? `/BleedBox[${s.bleed}]` : "");
  const page = `<</Type/Page/Parent 3 0 R/Contents 4 0 R${s.fonts && s.fonts !== "none" ? "/Resources<</Font<</F1 6 0 R>>>>" : ""}${boxes()}>>`;
  const parts: string[] = [`%PDF-${s.version ?? "1.4"}\n`];
  const info = s.pdfx === null ? "" : `/GTS_PDFXVersion(${s.pdfx ?? "PDF/X-4"})`;
  const catalog = `<</Type/Catalog/Pages 3 0 R${s.intent === false ? "" : "/OutputIntents[<</Type/OutputIntent/S/GTS_PDFX/OutputConditionIdentifier(FOGRA39)>>]"}>>`;
  parts.push(`1 0 obj\n${catalog}\nendobj\n`, `7 0 obj\n<<${info}>>\nendobj\n`, `3 0 obj\n<</Type/Pages/Count 1/Kids[2 0 R]>>\nendobj\n`);
  const content = deflateSync(Buffer.from(s.content ?? "0 0 0 1 k\n10 10 100 100 re\nf\n", "latin1"));
  parts.push(`4 0 obj\n${stream(`/Length ${content.length}/Filter/FlateDecode`, content)}endobj\n`);
  if (s.fonts === "embedded") parts.push(`6 0 obj\n<</Type/Font/BaseFont/Helvetica/FontDescriptor<</FontFile2 9 0 R>>>>\nendobj\n`);
  if (s.fonts === "bare") parts.push(`6 0 obj\n<</Type/Font/BaseFont/Helvetica>>\nendobj\n`);
  if (s.objstm === "good") {
    const body = deflateSync(Buffer.from(`2 0 ${page}`, "latin1"));
    parts.push(`5 0 obj\n${stream(`/Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length ${body.length}`, body)}endobj\n`);
  } else if (s.objstm === "garbage") {
    parts.push(`5 0 obj\n${stream("/Type/ObjStm/N 1/First 4/Filter/FlateDecode/Length 9", "NOT-FLATE")}endobj\n`);
  } else {
    parts.push(`2 0 obj\n${page}\nendobj\n`);
  }
  parts.push("trailer\n<</Root 1 0 R>>\n%%EOF\n");
  return Buffer.from(parts.join(""), "latin1");
}

const row = (rows: PreflightRow[], check: string): PreflightRow => {
  const r = rows.find((x) => x.check === check);
  if (!r) throw new Error(`no row ${check} in ${rows.map((x) => x.check).join(",")}`);
  return r;
};

describe("preflightPdf", () => {
  it("a PDF 1.4 file with every box, an intent, CMYK and embedded fonts is all ok", () => {
    const rows = preflightPdf(pdf({ bleed: "0 0 436.77 612.45", fonts: "embedded" }), WANT);
    expect(rows.map((r) => r.check)).toEqual(["pdf-header", "pdfx-version", "output-intent", "trim-box", "bleed-box", "cmyk", "fonts-embedded", "page-count"]);
    expect(rows.filter((r) => r.status !== "ok")).toEqual([]);
    expect(row(rows, "pdf-header").note).toBe("PDF 1.4");
    expect(row(rows, "pdfx-version").note).toBe("PDF/X-4");
    expect(row(rows, "output-intent").note).toBe("FOGRA39");
    expect(row(rows, "bleed-box").note).toContain("3 mm");
    expect(row(rows, "page-count").note).toBe("1");
  });

  it("no %PDF header is a single failing pdf-header row", () => {
    const rows = preflightPdf(Buffer.from("PK\u0003\u0004 not a pdf"), WANT);
    expect(rows).toEqual([{ check: "pdf-header", status: "fail", note: expect.stringContaining("not a PDF") }]);
  });

  it("RGB colour and no CMYK fails the cmyk check when CMYK is wanted, and passes when it is not", () => {
    const rgb = pdf({ content: "0.2 0.4 0.8 rg\n0 0 50 50 re\nf\n" });
    expect(row(preflightPdf(rgb, WANT), "cmyk").status).toBe("fail");
    expect(row(preflightPdf(rgb, { ...WANT, cmyk: false }), "cmyk").status).toBe("ok");
    const dev = pdf({ content: "/DeviceRGB cs\n" });
    expect(row(preflightPdf(dev, WANT), "cmyk").status).toBe("fail");
  });

  it("both CMYK and RGB colour warns; no colour operator at all is unknown", () => {
    expect(row(preflightPdf(pdf({ content: "0 0 0 1 k\n0.1 0.2 0.3 rg\n" }), WANT), "cmyk").status).toBe("warn");
    expect(row(preflightPdf(pdf({ content: "q Q\n" }), WANT), "cmyk").status).toBe("unknown");
  });

  it("a TrimBox equal to the BleedBox warns when bleed was asked for, and is fine when it was not", () => {
    const flat = pdf({ media: "0 0 400 500", trim: "0 0 400 500", bleed: "0 0 400 500" });
    expect(row(preflightPdf(flat, WANT), "bleed-box").status).toBe("warn");
    expect(row(preflightPdf(flat, { ...WANT, bleed: false }), "bleed-box").status).toBe("ok");
  });

  it("with no BleedBox key, a MediaBox past the trim is the bleed (ok) and a MediaBox equal to the trim is not (warn)", () => {
    const press = pdf({ media: "0 0 436.77 612.45", trim: "8.5 8.5 428.27 603.95" });
    const r = row(preflightPdf(press, WANT), "bleed-box");
    expect(r.status).toBe("ok");
    expect(r.note).toContain("no BleedBox key");
    const trimOnly = pdf({ media: "0 0 419.76 595.44", trim: "0 0 419.76 595.44" });
    const w = row(preflightPdf(trimOnly, WANT), "bleed-box");
    expect(w.status).toBe("warn");
    expect(w.note).toContain("no bleed");
  });

  it("reads boxes, intent and page out of a compressed object stream", () => {
    const rows = preflightPdf(pdf({ version: "1.6", objstm: "good" }), WANT);
    expect(row(rows, "trim-box")).toMatchObject({ status: "ok", note: "[8.5 8.5 428.26 603.94]" });
    expect(row(rows, "bleed-box").status).toBe("ok");
    expect(row(rows, "page-count").note).toBe("1");
  });

  it("a 1.6 file whose object stream cannot be read reports unknown, never fail, for what it cannot see", () => {
    const rows = preflightPdf(pdf({ version: "1.6", objstm: "garbage", intent: false, pdfx: null }), WANT);
    for (const c of ["pdfx-version", "output-intent", "trim-box", "bleed-box", "page-count"]) expect(row(rows, c).status).toBe("unknown");
    expect(rows.some((r) => r.status === "fail")).toBe(false);
  });

  it("without hidden objects a missing key is a real finding: PDF/X without a version or intent fails", () => {
    const rows = preflightPdf(pdf({ pdfx: null, intent: false, trim: null }), WANT);
    expect(row(rows, "pdfx-version").status).toBe("fail");
    expect(row(rows, "output-intent").status).toBe("fail");
    expect(row(rows, "trim-box").status).toBe("fail");
    const plain = preflightPdf(pdf({ pdfx: null, intent: false, trim: null }), { pdfx: false, bleed: false, cmyk: false });
    expect(plain.some((r) => r.check === "pdfx-version")).toBe(false);
    expect(row(plain, "output-intent").status).toBe("warn");
    expect(row(plain, "trim-box").status).toBe("warn");
  });

  it("fonts: used and embedded is ok, used and bare fails, none is ok", () => {
    expect(row(preflightPdf(pdf({ fonts: "embedded" }), WANT), "fonts-embedded").status).toBe("ok");
    expect(row(preflightPdf(pdf({ fonts: "bare" }), WANT), "fonts-embedded").status).toBe("fail");
    expect(row(preflightPdf(pdf({ fonts: "none" }), WANT), "fonts-embedded").note).toBe("no fonts used");
  });
});

describe("externalPdfInfo", () => {
  const dirs: string[] = [];
  const oldPath = process.env["PATH"];
  afterEach(() => {
    process.env["PATH"] = oldPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is null when none of exiftool, pdfinfo and qpdf is on PATH", () => {
    const empty = mkdtempSync(join(tmpdir(), "axi-pf-"));
    dirs.push(empty);
    process.env["PATH"] = empty;
    expect(externalPdfInfo(join(empty, "x.pdf"))).toBeNull();
  });

  it("reads PDFVersion and PageCount from exiftool when it is on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "axi-pf-"));
    dirs.push(dir);
    const tool = join(dir, "exiftool");
    writeFileSync(tool, `#!/bin/sh\necho '[{"SourceFile":"x","PDFVersion":"1.6","PageCount":3,"Producer":"Test"}]'\n`);
    chmodSync(tool, 0o755);
    process.env["PATH"] = dir;
    const r = externalPdfInfo(join(dir, "x.pdf"));
    expect(r?.tool).toBe("exiftool");
    expect(r?.rows.map((x) => `${x.check}=${x.note}`)).toEqual(["tool-pdf-version=1.6 (exiftool)", "tool-page-count=3 (exiftool)", "tool-producer=Test"]);
  });
});
