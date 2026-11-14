// `fill --export`: the per-record export (whole document or one file per artboard), the optional
// `--max-kb` ladder (same steps as `export --max-kb`, src/affinity/export-budget.ts) and the manifest
// entries. Split out of fill.ts to keep that file under the size limit.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { EXPORT_AREA, imageSize, LIST_ARTBOARDS, uniqueSafeNames, type AreaSpec } from "../affinity/export-area.js";
import { fitBudget, noFitMessage, scaledDim, type Step } from "../affinity/export-budget.js";
import { readManifest, writeManifest } from "../affinity/manifest.js";
import type { BrandKit } from "../affinity/brand.js";
import type { BrandRef } from "../affinity/manifest-types.js";
import { finalizeFile, metadataNote, type MetaOutcome } from "../affinity/metadata.js";
import { shown } from "../affinity/paths.js";
import { classify, resultText } from "../affinity/result.js";
import { EXPORT } from "../affinity/scripts.js";
import { AxiError } from "../output/errors.js";
import type { AffinityClient } from "../mcp/types.js";
import { callJson } from "./run.js";
import { FatalRecord } from "./fill-parts.js";

/** What the export of one record needs from the run context. */
export interface ExportCtx {
  client: AffinityClient;
  outDir: string;
  timeoutMs: number;
  preset: string | undefined;
  ext: string | undefined;
  allBoards: boolean;
  brand: { kit: BrandKit; ref: BrandRef } | undefined;
  /** `--max-kb`: the budget in KB and bytes and the steps to try (set once the live preset list is known). */
  budget: { kb: number; bytes: number; steps: Step[] } | undefined;
}

/** One exported file for the record's manifest. */
export interface ExportEntry {
  path: string;
  preset: string;
  size: string;
  requested?: string;
  attempts?: number;
}

export interface ExportResult {
  files: string[];
  entries: ExportEntry[];
  /** The "exported ..." row note. */
  summary: string;
  /** The metadata note (strip / credit), when there is one. */
  metaNote: string | null;
  /** Set when a file could not be brought under the budget: the text that ends the row note. */
  miss: string | null;
}

const kbOf = (bytes: number): string => (bytes / 1024).toFixed(1);

/** Exports the open document: the whole document, or one file per artboard. Returns the files written. */
export async function exportDoc(c: ExportCtx, uuid: string, key: string): Promise<ExportResult> {
  const preset = c.preset!;
  const run = async (script: string, what: string): Promise<void> => {
    let result;
    try {
      result = await c.client.callTool("execute_script", { script }, { timeoutMs: c.timeoutMs });
    } catch (err) {
      throw new FatalRecord(`${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (classify(result).kind !== "ok") {
      throw new AxiError(`${what}: ${resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure"}`, "check the preset suits this document");
    }
  };
  const written = (path: string): void => {
    if (!existsSync(path)) throw new AxiError(`export reported success but ${shown(path)} was not written`, "check the folder and preset");
  };
  const targets: Array<{ path: string; area: AreaSpec | null }> = [];
  if (!c.allBoards) {
    targets.push({ path: join(c.outDir, `${key}.${c.ext}`), area: null });
  } else {
    let listed: { artboards: Array<{ index: number; name: string }> };
    try {
      listed = await callJson<{ artboards: Array<{ index: number; name: string }> }>(c.client, LIST_ARTBOARDS(uuid, 0), "listing artboards", { timeoutMs: c.timeoutMs });
    } catch (err) {
      throw new FatalRecord(err instanceof Error ? err.message : String(err), uuid);
    }
    if (listed.artboards.length === 0) throw new AxiError("the template has no artboards on spread 0", "export without --all-artboards");
    const safe = uniqueSafeNames(listed.artboards.map((b) => b.name));
    listed.artboards.forEach((b, i) => {
      targets.push({ path: join(c.outDir, `${key}-${safe[i]}.${c.ext}`), area: { kind: "artboard", spread: 0, index: b.index } });
    });
  }

  const budget = c.budget;
  const outcomes: MetaOutcome[] = [];
  const entries: ExportEntry[] = [];
  const attemptsOf: number[] = [];
  const bytesOf: number[] = [];
  const missed: string[] = [];
  for (const t of targets) {
    const what = `export of ${basename(t.path)} failed`;
    await run(t.area === null ? EXPORT(uuid, preset, t.path) : EXPORT_AREA(uuid, preset, t.path, t.area, null), what);
    written(t.path);
    if (!budget) {
      outcomes.push(finalizeFile(t.path, { credit: c.brand?.kit.credit }));
      entries.push({ path: t.path, preset, size: "" });
      continue;
    }
    // The SDK takes an absolute pixel size, so later steps are scaled from the natural size of the first file.
    const natural = imageSize(readFileSync(t.path));
    if (!natural) throw new AxiError(`cannot read the pixel size of ${shown(t.path)}`, "size and budget flags support PNG, JPEG and WebP presets only");
    let outcome: MetaOutcome | undefined;
    const fitted = await fitBudget(budget.steps, budget.bytes, async (s) => {
      if (s !== budget.steps[0]) {
        await run(EXPORT_AREA(uuid, s.preset, t.path, t.area, s.scale === 1 ? null : scaledDim(natural, s.scale)), what);
        written(t.path);
      }
      outcome = finalizeFile(t.path, { credit: c.brand?.kit.credit }); // the metadata pass first, so the verdict measures the final file
      const buf = readFileSync(t.path);
      const dim = imageSize(buf);
      return { bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
    });
    const last = fitted.attempts[fitted.attempts.length - 1]!;
    outcomes.push(outcome!);
    attemptsOf.push(fitted.attempts.length);
    bytesOf.push(last.bytes);
    entries.push({ path: t.path, preset: last.preset, size: last.size, ...(last.preset !== preset ? { requested: preset } : {}), attempts: fitted.attempts.length });
    if (!fitted.fit) missed.push(noFitMessage(basename(t.path), budget.kb, last));
  }

  const files = targets.map((t) => t.path);
  let summary: string;
  if (!budget) {
    summary = files.length === 1 ? `exported ${basename(files[0]!)}` : `exported ${files.length} files`;
  } else if (files.length === 1) {
    const e = entries[0]!;
    const kb = kbOf(bytesOf[0]!);
    summary = attemptsOf[0] === 1 ? `exported ${basename(e.path)} (${kb} KB)` : `exported ${basename(e.path)} (${kb} KB at ${e.preset} ${e.size}, ${attemptsOf[0]} attempts)`;
  } else {
    const stepped = attemptsOf.filter((n) => n > 1).length;
    summary = `exported ${files.length} files (largest ${kbOf(Math.max(...bytesOf))} KB${stepped > 0 ? `, ${stepped} stepped down` : ""})`;
  }
  const miss = missed.length === 0 ? null : `${missed[0]}${missed.length > 1 ? ` (and ${missed.length - 1} more)` : ""}`;
  return { files, entries, summary, metaNote: metadataNote(outcomes), miss };
}

/** Appends the exports to the saved file's manifest. Best effort: the files already exist. */
export function recordExports(c: ExportCtx, afPath: string, entries: ExportEntry[]): void {
  try {
    const m = readManifest(afPath);
    if (!m) return;
    const time = new Date().toISOString();
    m.exports = [
      ...(m.exports ?? []),
      ...entries.map((e) => ({
        time,
        path: e.path,
        preset: e.preset,
        area: c.allBoards ? "all-artboards" : "whole",
        size: e.size,
        bytes: statSync(e.path).size,
        aiGenerated: false,
        ...(e.requested !== undefined ? { requested: e.requested } : {}),
        ...(e.attempts !== undefined ? { attempts: e.attempts } : {}),
      })),
    ];
    writeManifest(afPath, m);
  } catch {
    // the export itself succeeded
  }
}
