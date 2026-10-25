// `print <doc> --out <file.pdf>`: export a press PDF with a PDF preset
// (default PDF/X-4) and preflight the written file offline.
//
// Print-specific facts live in the document, not in the export call:
// FileExportOptions has only createWithPresetName, so bleed is set when the
// document is created (axiPrintDoc) and CMYK either there or here (--cmyk runs
// doc.format = CMYKA8 on the open document). Measured on Affinity 3.3.1: the
// PDF/X presets export the trim area only; "PDF (press ready)" keeps the bleed
// (MediaBox = trim + bleed). Crop marks are proof-sheet geometry (axiPrintSheet).

import { readFileSync } from "node:fs";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { EXPORT_AREA, LIST_ARTBOARDS, type AreaSpec } from "../affinity/export-area.js";
import { readManifest, writeManifest } from "../affinity/manifest.js";
import { externalPdfInfo, preflightPdf, type PreflightRow } from "../affinity/preflight.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, LIST_DOCUMENTS, LIST_PRESETS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, emitKV, emitList, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const DEFAULT_PRESET = "PDF/X-4";
const USAGE = `usage: ${BIN} print <doc> --out <file.pdf under Desktop> [--preset "${DEFAULT_PRESET}"] [--artboard <name>] [--cmyk]`;
const MARKS_NOTE = "crop marks are drawn by axiPrintSheet for proofs; press PDFs carry bleed boxes, not marks";

/** Converts the open document to CMYK; logs {"format": "..."} as read back. */
function CONVERT_CMYK(docUuid: string): string {
  return [
    "/* affinity-axi:print-cmyk */",
    "const { Document } = require('/document.js');",
    "const { RasterFormat } = require('/rasterobject.js');",
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    "const doc = Document.all.find((d) => String(d.sessionUuid) === targetUuid);",
    "if (!doc) { throw new Error('No document with that Uuid exists.'); }",
    "doc.format = RasterFormat.CMYKA8;",
    "console.log(JSON.stringify({ format: String(doc.format) }));",
  ].join("\n");
}

function urlFlag(parsed: Parsed): string | undefined {
  const u = parsed.flags["url"];
  return typeof u === "string" ? u : undefined;
}

async function runScript(client: AffinityClient, script: string, what: string): Promise<string> {
  const result = await client.callTool("execute_script", { script });
  if (classify(result).kind !== "ok") {
    const first = resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure";
    throw new AxiError(`${what}: ${first}`, `check the path is writable and the preset suits this document; list presets with '${BIN} presets'`);
  }
  return resultText(result);
}

/** Resolves --artboard / --spread to an export area; null exports the whole document. */
async function areaFor(client: AffinityClient, doc: DocInfo, artboard: string | undefined, spread: number | undefined): Promise<AreaSpec | null> {
  if (artboard === undefined) return spread === undefined ? null : { kind: "spread", spread };
  const at = spread ?? 0;
  const out = await runScript(client, LIST_ARTBOARDS(doc.uuid, at), "listing artboards failed");
  let boards: Array<{ index: number; name: string }>;
  try {
    boards = (JSON.parse(out.trim().split("\n").pop() ?? "") as { artboards: typeof boards }).artboards;
  } catch {
    throw new AxiError("could not read the artboard list from Affinity", "retry; check the document with 'affinity-axi render'");
  }
  const names = boards.map((b) => b.name);
  let hits = names.flatMap((n, i) => (n === artboard ? [i] : []));
  if (hits.length === 0) hits = names.flatMap((n, i) => (n.toLowerCase() === artboard.toLowerCase() ? [i] : []));
  if (hits.length !== 1) {
    const why = hits.length === 0 ? `no artboard named '${artboard}'` : `artboard name '${artboard}' is ambiguous (${hits.length} matches)`;
    throw new UsageError(`${why} on spread ${at}`, `artboards: ${names.join(", ") || "none"}`);
  }
  return { kind: "artboard", spread: at, index: boards[hits[0]!]!.index };
}

/** Appends the PDF to `exports` in the document's manifest; best effort and silent. */
function recordExport(doc: DocInfo, preset: string, file: string, bytes: number, area: AreaSpec | null): void {
  if (!doc.path) return;
  try {
    const m = readManifest(doc.path);
    if (!m) return;
    const label = area === null ? "whole" : area.kind === "artboard" ? `artboard:${area.index}` : area.kind === "spread" ? `spread:${area.spread}` : area.kind;
    m.exports = [...(m.exports ?? []), { time: new Date().toISOString(), path: file, preset, area: label, size: "", bytes, aiGenerated: false }];
    writeManifest(doc.path, m);
  } catch {
    // the export itself succeeded; a manifest problem must not fail it
  }
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "print",
      summary: "Export a press PDF (default PDF/X-4) and preflight it offline: boxes, bleed, colour, fonts",
      args: [{ name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" }],
      flags: [
        { name: "out", type: "string", description: "output .pdf path inside the Desktop folder (required)" },
        { name: "preset", type: "string", default: DEFAULT_PRESET, description: `a PDF export preset (see: ${BIN} presets); PDF/X presets export the trim area only, 'PDF (press ready)' keeps the bleed` },
        { name: "artboard", type: "string", description: "export one artboard by name instead of the whole document" },
        { name: "spread", type: "string", description: "spread index from 0: the spread to export, or the spread holding --artboard" },
        { name: "cmyk", type: "boolean", description: "convert the open document to CMYK (doc.format = CMYKA8) before exporting; the document is changed" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        `${BIN} print current --out ~/Desktop/flyer.pdf`,
        `${BIN} print 3F2A9C1B --out ~/Desktop/flyer.pdf --preset "PDF (press ready)" --cmyk`,
        `${BIN} print current --out ~/Desktop/out/card.pdf --artboard card`,
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const ref = parsed.positionals[0]!;
      const rawOut = parsed.flags["out"];
      if (typeof rawOut !== "string" || rawOut.trim() === "") throw new UsageError("--out is required", USAGE);
      if (!rawOut.toLowerCase().endsWith(".pdf")) throw new UsageError(`--out must be a .pdf path, got '${rawOut}'`, USAGE);
      const out = userPath(rawOut);
      requireVisible(out, "output path");
      const preset = String(parsed.flags["preset"] ?? DEFAULT_PRESET);
      if (!/^pdf/i.test(preset)) {
        throw new UsageError(`preset '${preset}' is not a PDF preset`, `print writes PDFs; use '${DEFAULT_PRESET}', 'PDF/X-1a:2003' or 'PDF (press ready)', or '${BIN} export' for other formats`);
      }
      const spreadRaw = parsed.flags["spread"];
      if (spreadRaw !== undefined && !/^\d+$/.test(String(spreadRaw))) {
        throw new UsageError(`invalid --spread '${String(spreadRaw)}'`, "use a spread index starting at 0, e.g. --spread 0");
      }
      const spread = spreadRaw === undefined ? undefined : Number(spreadRaw);
      const artboard = typeof parsed.flags["artboard"] === "string" ? parsed.flags["artboard"] : undefined;
      if (artboard !== undefined && artboard.trim() === "") throw new UsageError("--artboard needs a name", "pass the artboard name, or drop the flag to export the whole document");
      const cmyk = parsed.flags["cmyk"] === true;

      const client = await connect({ url: urlFlag(parsed) });
      let doc: DocInfo;
      let area: AreaSpec | null;
      let format: string | undefined;
      try {
        const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
        if (!presets.includes(preset)) {
          const pdf = presets.filter((p) => /^pdf/i.test(p));
          throw new UsageError(`unknown export preset '${preset}'`, `PDF presets: ${pdf.join(", ") || "none found"}`);
        }
        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, out, "output path", "write-file");
        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(client, LIST_DOCUMENTS, "listing documents");
        doc = resolveDocRef(ref, listing.documents, listing.current);
        area = await areaFor(client, doc, artboard, spread);
        if (cmyk) {
          const reply = await runScript(client, CONVERT_CMYK(doc.uuid), "converting the document to CMYK failed");
          try {
            format = (JSON.parse(reply.trim().split("\n").pop() ?? "") as { format?: string }).format;
          } catch {
            format = undefined;
          }
        }
        await runScript(client, EXPORT_AREA(doc.uuid, preset, out, area, null), "export failed");
      } finally {
        client.close();
      }

      let bytes: Buffer;
      try {
        bytes = readFileSync(out);
      } catch {
        throw new AxiError(`export reported success but ${out} was not written`, "check the folder exists and retry");
      }
      recordExport(doc, preset, out, bytes.length, area);

      const rows: PreflightRow[] = preflightPdf(bytes, { pdfx: /PDF\/X/i.test(preset), bleed: true, cmyk });
      const external = externalPdfInfo(out);
      if (external) rows.push(...external.rows);
      const notes: string[] = [];
      if (!external) notes.push("exiftool, pdfinfo and qpdf were not found on PATH: byte scan only");
      if (cmyk && format !== undefined && format !== "CMYKA8") notes.push(`the document format reads back as ${format}, so the CMYK conversion did not apply`);
      if (cmyk) notes.push("--cmyk changed the open document; save or undo it");
      if (rows.some((r) => r.check === "bleed-box" && r.status === "warn")) {
        notes.push('PDF/X presets export the trim area only: for bleed, build the document with axiPrintDoc({bleed}) and export with --preset "PDF (press ready)"');
      }

      const kv: Array<[string, string | number]> = [
        ["doc", doc.uuid],
        ["preset", preset],
        ["file", out],
        ["bytes", bytes.length],
      ];
      if (cmyk) kv.push(["format", format ?? "unknown"]);
      const failed = rows.some((r) => r.status === "fail");
      print(
        [
          emitKV(kv),
          emitList("preflight", rows as unknown as Array<Record<string, unknown>>, ["check", "status", "note"]),
          emitKV([["note", MARKS_NOTE]]),
          ...(notes.length > 0 ? [emitBlock("notes", notes)] : []),
          helpBlock([`${BIN} export ${doc.uuid.slice(0, 8)} PNG <path-under-Desktop>   # a raster proof`, `${BIN} presets   # all export presets`]),
        ].join("\n"),
      );
      return failed ? 1 : 0;
    },
  };
}
