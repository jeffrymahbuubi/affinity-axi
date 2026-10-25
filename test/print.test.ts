// `print`: preset checks, the export and CMYK scripts, the offline preflight and exit codes,
// against the fake server. The area-export handler writes synthetic PDFs at the output path.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type Registry } from "../src/cli/router.js";
import { make as makePrint } from "../src/commands/print.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const PRESETS = ["PNG", "PDF (digital - high quality)", "PDF (press ready)", "PDF/X-1a:2003", "PDF/X-4"];

let server: FakeServer;
let root: string;
let desktop: string;
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-print-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const print = makePrint(fakeConnect());
const scriptCalls = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const exported = (): string[] => scriptCalls().filter((s) => s.includes("affinity-axi:area-export"));

function stubAll(presets: string[] = PRESETS): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify(presets));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
}

/** A PDF 1.4 file: all boxes (bleed carried by the MediaBox), an output intent, and a content stream. */
function pdf(content = "0 0 0 1 k\n10 10 100 100 re\nf\n", pdfx = "PDF/X-4"): Buffer {
  const body = deflateSync(Buffer.from(content, "latin1"));
  const parts = [
    "%PDF-1.4\n",
    `1 0 obj\n<</Type/Catalog/OutputIntents[<</Type/OutputIntent/OutputConditionIdentifier(FOGRA39)>>]>>\nendobj\n`,
    `7 0 obj\n<</GTS_PDFXVersion(${pdfx})>>\nendobj\n`,
    "2 0 obj\n<</Type/Page/MediaBox[0 0 436.77 612.45]/TrimBox[8.5 8.5 428.27 603.95]>>\nendobj\n",
    `4 0 obj\n<</Length ${body.length}/Filter/FlateDecode>>\nstream\n${body.toString("latin1")}\nendstream\nendobj\n`,
    "%%EOF\n",
  ];
  return Buffer.from(parts.join(""), "latin1");
}

function exportWrites(file: Buffer, path: string): void {
  server.onScript("affinity-axi:area-export", () => {
    writeFileSync(path, file);
    return JSON.stringify({ exported: path });
  });
}

describe("print", () => {
  it("exports with the default preset and reports an all-ok preflight with exit 0", async () => {
    stubAll();
    const out = join(desktop, "flyer.pdf");
    exportWrites(pdf(), out);
    const r = await runCommand(print, ["current", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("preset: PDF/X-4");
    expect(r.stdout).toContain(`file: ${out}`);
    expect(r.stdout).toMatch(/bytes: \d+/);
    expect(r.stdout).toContain("preflight[");
    expect(r.stdout).toContain("{check,status,note}:");
    for (const check of ["pdf-header", "pdfx-version", "output-intent", "trim-box", "bleed-box", "cmyk", "fonts-embedded", "page-count"]) {
      expect(r.stdout).toMatch(new RegExp(`\\n  ${check},ok,`));
    }
    expect(r.stdout).not.toMatch(/,(warn|fail|unknown),/);
    expect(r.stdout).toContain("note: crop marks are drawn by axiPrintSheet for proofs; press PDFs carry bleed boxes, not marks");
    expect(r.stdout).toContain("help[");
    const sent = exported()[0]!;
    expect(sent).toContain(JSON.stringify(FIXTURE_UUID));
    expect(sent).toContain(JSON.stringify("PDF/X-4"));
    expect(sent).toContain(JSON.stringify(out));
    expect(sent).toContain("const area = null;");
  });

  it("an unknown PDF preset is a usage error after list-presets, listing the PDF presets, with no export", async () => {
    stubAll();
    const r = await runCommand(print, ["current", "--out", join(desktop, "x.pdf"), "--preset", "PDF/X-9"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("unknown export preset 'PDF/X-9'");
    expect(r.stdout).toContain("PDF presets: PDF (digital - high quality), PDF (press ready), PDF/X-1a:2003, PDF/X-4");
    expect(scriptCalls().some((s) => s.includes("affinity-axi:list-presets"))).toBe(true);
    expect(exported()).toHaveLength(0);
  });

  it("a non-PDF preset is a usage error before connecting", async () => {
    stubAll();
    const r = await runCommand(print, ["current", "--out", join(desktop, "x.pdf"), "--preset", "PNG"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("is not a PDF preset");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--out is required and must be a .pdf, both before connecting", async () => {
    const none = await runCommand(print, ["current"]);
    expect(none.code).toBe(2);
    expect(none.stdout).toContain("--out is required");
    const bad = await runCommand(print, ["current", "--out", join(desktop, "x.png")]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("must be a .pdf path");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--cmyk converts the document to CMYKA8 before the export and reports the format read back", async () => {
    stubAll();
    const out = join(desktop, "flyer.pdf");
    server.onScript("affinity-axi:print-cmyk", JSON.stringify({ format: "CMYKA8" }));
    exportWrites(pdf(), out);
    const r = await runCommand(print, ["current", "--out", out, "--cmyk", "--preset", "PDF (press ready)"]);
    expect(r.code).toBe(0);
    const calls = scriptCalls();
    const at = calls.findIndex((s) => s.includes("affinity-axi:print-cmyk"));
    const ex = calls.findIndex((s) => s.includes("affinity-axi:area-export"));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(ex);
    expect(calls[at]).toContain("doc.format = RasterFormat.CMYKA8");
    expect(calls[at]).toContain(JSON.stringify(FIXTURE_UUID));
    expect(r.stdout).toContain("format: CMYKA8");
    expect(r.stdout).toContain("--cmyk changed the open document");
  });

  it("a conversion that does not read back as CMYKA8 is said in the output", async () => {
    stubAll();
    const out = join(desktop, "flyer.pdf");
    server.onScript("affinity-axi:print-cmyk", JSON.stringify({ format: "RGBA8" }));
    exportWrites(pdf(), out);
    const r = await runCommand(print, ["current", "--out", out, "--cmyk"]);
    expect(r.stdout).toContain("format: RGBA8");
    expect(r.stdout).toContain("the CMYK conversion did not apply");
  });

  it("a failing preflight row exits 1 and still prints the table", async () => {
    stubAll();
    const out = join(desktop, "rgb.pdf");
    server.onScript("affinity-axi:print-cmyk", JSON.stringify({ format: "CMYKA8" }));
    exportWrites(pdf("0.2 0.4 0.8 rg\n0 0 50 50 re\nf\n"), out);
    const r = await runCommand(print, ["current", "--out", out, "--cmyk"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\n {2}cmyk,fail,/);
  });

  it("a file with no bleed warns, exits 0 and points at the press-ready preset", async () => {
    stubAll();
    const out = join(desktop, "flat.pdf");
    const flat = pdf().toString("latin1").replace("/MediaBox[0 0 436.77 612.45]/TrimBox[8.5 8.5 428.27 603.95]", "/MediaBox[0 0 419.76 595.44]/TrimBox[0 0 419.76 595.44]");
    exportWrites(Buffer.from(flat, "latin1"), out);
    const r = await runCommand(print, ["current", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\n {2}bleed-box,warn,/);
    expect(r.stdout).toContain('--preset "PDF (press ready)"');
  });

  it("an output path outside the Desktop folder exits 2 after app-info and never exports", async () => {
    stubAll();
    const r = await runCommand(print, ["current", "--out", join(root, "elsewhere", "x.pdf")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(scriptCalls().some((s) => s.includes("affinity-axi:app-info"))).toBe(true);
    expect(exported()).toHaveLength(0);
  });

  it("an output path in a hidden folder exits 2 before app-info", async () => {
    stubAll();
    const r = await runCommand(print, ["current", "--out", join(desktop, ".proofs", "a.pdf")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("output path is inside a hidden folder or file ('.proofs')");
    expect(server.sessionsOpened()).toBe(0);
    expect(exported()).toHaveLength(0);
  });

  it("an export that writes no file exits 1", async () => {
    stubAll();
    server.onScript("affinity-axi:area-export", "{}");
    const r = await runCommand(print, ["current", "--out", join(desktop, "ghost.pdf")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("was not written");
  });

  it("an export error from the app exits 1 with its message", async () => {
    stubAll();
    server.onScript("affinity-axi:area-export", "ERROR: could not write file\n");
    const r = await runCommand(print, ["current", "--out", join(desktop, "x.pdf")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export failed: ERROR: could not write file");
  });

  it("--artboard resolves the name to its index and exports that area", async () => {
    stubAll();
    server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: [{ index: 0, name: "front" }, { index: 1, name: "back" }] }));
    const out = join(desktop, "back.pdf");
    exportWrites(pdf(), out);
    const r = await runCommand(print, ["current", "--out", out, "--artboard", "BACK"]);
    expect(r.code).toBe(0);
    expect(exported()[0]).toContain('"kind":"artboard","spread":0,"index":1');
    const missing = await runCommand(print, ["current", "--out", out, "--artboard", "side"]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("no artboard named 'side'");
    expect(missing.stdout).toContain("artboards: front, back");
  });

  describe("PDF author metadata", () => {
    const origPath = process.env["PATH"];
    afterEach(() => {
      process.env["PATH"] = origPath;
    });

    /** PATH with only a fake exiftool answering `-j` with the given JSON (sbin dirs are kept off PATH so no real tool answers). */
    function fakeExiftool(json: string): void {
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const file = join(bin, "exiftool");
      writeFileSync(file, `#!/bin/sh\necho '${json}'\n`);
      chmodSync(file, 0o755);
      process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    }

    it("warns with an author-metadata row and a note when exiftool reports Author, without changing the exit code", async () => {
      stubAll();
      fakeExiftool('[{"SourceFile":"x","PDFVersion":"1.6","Author":"account-handle","Creator":"account-handle"}]');
      const out = join(desktop, "flyer.pdf");
      exportWrites(pdf(), out);
      const r = await runCommand(print, ["current", "--out", out]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('author-metadata,warn,"Author/Creator ""account-handle"" written by Affinity; PDF metadata is not stripped (see the guide)"');
      expect(r.stdout).toContain("PDF Author/Creator come from Affinity and are not stripped; a PDF rewrite tool (qpdf) is needed");
    });

    it("adds no row when exiftool reports no Author or Creator", async () => {
      stubAll();
      fakeExiftool('[{"SourceFile":"x","PDFVersion":"1.6"}]');
      const out = join(desktop, "flyer.pdf");
      exportWrites(pdf(), out);
      const r = await runCommand(print, ["current", "--out", out]);
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain("author-metadata");
      expect(r.stdout).not.toContain("PDF rewrite tool");
    });
  });

  it("--help makes zero connections and lists flags and examples", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      const reg: Registry = { tool: "affinity-axi", root: print, rootHelp: () => "root", commands: { print }, aliases: {} };
      code = await dispatch(reg, ["print", "--help"]);
    } finally {
      process.stdout.write = write;
    }
    const out = chunks.join("");
    expect(code).toBe(0);
    expect(out).toContain("flags[");
    expect(out).toContain("--out");
    expect(out).toContain("--cmyk");
    expect(out).toMatch(/examples\[3\]:/);
    expect(server.sessionsOpened()).toBe(0);
    expect(server.calls).toHaveLength(0);
  });
});
