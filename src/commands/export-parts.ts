// Helpers behind `export`: area planning, target resolution, the export
// report, script running and manifest recording. Moved out of export.ts so
// that file stays under the line cap; behaviour is unchanged.

import { readFileSync } from "node:fs";
import type { Parsed } from "../cli/args.js";
import { altFor, ALT_TEXT_CHARS, type AltArea } from "../affinity/alt-text.js";
import { LIST_ARTBOARDS, uniqueSafeNames, type AreaSpec } from "../affinity/export-area.js";
import { formatChange, type Attempt } from "../affinity/export-budget.js";
import { INSPECT } from "../affinity/inspect-script.js";
import { readManifest, writeManifest } from "../affinity/manifest.js";
import type { Inventory } from "../affinity/manifest-types.js";
import { classify, resultText } from "../affinity/result.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList } from "../output/toon.js";
import type { AffinityClient, DocInfo, ToolResult } from "../mcp/types.js";
import { callJson } from "./run.js";

export const BIN = "affinity-axi";

export interface Plan {
  mode: "whole" | "spread" | "selection" | "artboard" | "all";
  artboard?: string;
  /** 0-based spread index (same convention as `render --spread`). */
  spread: number;
}

/** Validates the area flags and the {name} placeholder before any connection. */
export function planArea(parsed: Parsed, rawPath: string): Plan {
  const f = parsed.flags;
  const artboard = typeof f["artboard"] === "string" ? f["artboard"] : undefined;
  const all = f["all-artboards"] === true;
  const selection = f["selection"] === true;
  const spreadRaw = typeof f["spread"] === "string" ? f["spread"] : undefined;
  if ([artboard !== undefined, all, selection].filter(Boolean).length > 1) {
    throw new UsageError("--artboard, --all-artboards and --selection are mutually exclusive", "pick one export area");
  }
  if (artboard !== undefined && artboard.trim() === "") {
    throw new UsageError("--artboard needs a name", "pass the artboard name, or use --all-artboards with {name} in the path");
  }
  if (spreadRaw !== undefined && !/^\d+$/.test(spreadRaw)) {
    throw new UsageError(`invalid --spread '${spreadRaw}'`, "use a spread index starting at 0, e.g. --spread 0");
  }
  if (selection && spreadRaw !== undefined) {
    throw new UsageError("--selection cannot be combined with --spread", "the selection decides the area");
  }
  const spread = spreadRaw === undefined ? 0 : Number(spreadRaw);
  const hasName = rawPath.includes("{name}");
  if (all && !hasName) {
    throw new UsageError("--all-artboards needs {name} in the path", "e.g. export current PNG ~/Desktop/out/{name}.png --all-artboards");
  }
  if (hasName && !all && artboard === undefined) {
    throw new UsageError("{name} in the path needs --all-artboards or --artboard", "remove {name} or add an artboard flag");
  }
  if (all) return { mode: "all", spread };
  if (artboard !== undefined) return { mode: "artboard", artboard, spread };
  if (selection) return { mode: "selection", spread };
  return { mode: spreadRaw !== undefined ? "spread" : "whole", spread };
}

export interface Target {
  /** Artboard name, or "" when the area is not an artboard. */
  name: string;
  path: string;
  area: AreaSpec | null;
}

/** A written file as reported: bytes and size from disk, plus what a budget or the alt stub added. */
export interface Written extends Target {
  bytes: number;
  size: string;
  /** Final preset when a budget stepped it. */
  preset?: string;
  attempts?: Attempt[];
  fit?: boolean;
  alt?: string;
}

export const ALT_NONE = "(none; add one)";
export const ALT_UNAVAILABLE = "(unavailable; read the text with inspect)";
export const altText = (w: Written): string => (w.alt === undefined ? ALT_UNAVAILABLE : w.alt === "" ? ALT_NONE : w.alt);

/** The inventory area a target's alt text comes from (a selection reads the whole inventory). */
export function altArea(plan: Plan, t: Target): AltArea {
  if (plan.mode === "artboard" || plan.mode === "all") return { kind: "artboard", name: t.name };
  return plan.mode === "selection" ? { kind: "all" } : { kind: "spread", spread: plan.spread };
}

/** One inventory call, then an alt stub per target ("" = no text). Best effort: null when it fails, the files are already written. */
export async function altStubs(client: AffinityClient, uuid: string, plan: Plan, targets: Target[]): Promise<Array<string | null>> {
  try {
    const inv = await callJson<Inventory>(client, INSPECT(uuid, { textChars: ALT_TEXT_CHARS }), "reading text for alt", { timeoutMs: 120000 });
    return targets.map((t) => altFor(inv, altArea(plan, t)));
  } catch {
    return targets.map(() => null);
  }
}

/** The TOON report: the plain export lines, plus attempts when a budget ran and an alt line unless --no-alt. */
export function report(uuid: string, plan: Plan, preset: string, written: Written[], tags: Array<[string, string]>, kb: number | null, wantAlt: boolean): string {
  const notes = (ws: Written[]): Array<[string, string]> => {
    const change = ws.map((w) => formatChange(preset, w.preset ?? preset)).find((n) => n !== null);
    return change ? [["note", change]] : [];
  };
  const help = wantAlt && written.some((w) => w.alt !== undefined) ? [helpBlock(["edit the alt text before publishing"])] : [];
  const tried = (w: Written, extra: Record<string, unknown>): Array<Record<string, unknown>> => (w.attempts ?? []).map((a) => ({ ...extra, ...a }));
  if (plan.mode === "all") {
    const head: Array<[string, string | number]> = [["doc", uuid], ["preset", preset], ...(kb !== null ? ([["budget_kb", kb]] as Array<[string, number]>) : [])];
    const cols = ["artboard", "path", ...(kb !== null ? ["preset"] : []), "bytes", "size", ...(wantAlt ? ["alt"] : [])];
    const rows = written.map((w) => ({ artboard: w.name, path: w.path, preset: w.preset, bytes: w.bytes, size: w.size, alt: altText(w) }));
    const parts = [emitKV(head)];
    if (kb !== null) parts.push(emitList("attempts", written.flatMap((w) => tried(w, { artboard: w.name })), ["artboard", "preset", "size", "bytes", "fit"]));
    parts.push(emitList("exports", rows, cols));
    if (tags.length > 0 || notes(written).length > 0) parts.push(emitKV([...tags, ...notes(written)]));
    return [...parts, ...help].join("\n");
  }
  const only = written[0]!;
  const final = only.preset ?? preset;
  const head: Array<[string, string | number]> = [["export", only.path], ["doc", uuid], ["preset", final]];
  if (final !== preset) head.push(["requested", preset]);
  if (only.name !== "") head.push(["artboard", only.name]);
  if (kb !== null) head.push(["budget_kb", kb]);
  const tail: Array<[string, string | number]> = [["bytes", only.bytes]];
  if (only.size !== "") tail.push(["size", only.size]);
  const parts = [emitKV(head)];
  if (kb !== null) parts.push(emitList("attempts", tried(only, {}), ["preset", "size", "bytes", "fit"]));
  parts.push(emitKV([...tail, ...tags, ...notes(written), ...(wantAlt ? ([["alt", altText(only)]] as Array<[string, string]>) : [])]));
  return [...parts, ...help].join("\n");
}

export function failure(result: ToolResult, what: string): AxiError {
  const first = resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure";
  return new AxiError(`${what}: ${first}`, `check the path is writable and the preset suits this document; list presets with '${BIN} presets'`);
}

export async function runScript(client: AffinityClient, script: string, what: string): Promise<string> {
  const result = await client.callTool("execute_script", { script });
  if (classify(result).kind !== "ok") throw failure(result, what);
  return resultText(result);
}

export function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new AxiError(`export reported success but ${path} was not written`, "check the folder exists and retry");
  }
}

/** Resolves the artboard targets of a plan against the document's real artboard list. */
export async function artboardTargets(client: AffinityClient, doc: DocInfo, plan: Plan, template: string): Promise<Target[]> {
  const out = await runScript(client, LIST_ARTBOARDS(doc.uuid, plan.spread), "listing artboards failed");
  let boards: Array<{ index: number; name: string }>;
  try {
    boards = (JSON.parse(out.trim().split("\n").pop() ?? "") as { artboards: typeof boards }).artboards;
  } catch {
    throw new AxiError("could not read the artboard list from Affinity", "retry; check the document with 'affinity-axi render'");
  }
  if (!Array.isArray(boards) || boards.length === 0) {
    throw new UsageError(
      `document ${doc.uuid} has no artboards on spread ${plan.spread}`,
      "add artboards in the script (doc.addRectangularArtboard) or export without an artboard flag",
    );
  }
  const names = boards.map((b) => b.name);
  const safe = uniqueSafeNames(names);
  const at = (i: number): Target => ({
    name: names[i]!,
    path: template.split("{name}").join(safe[i]!),
    area: { kind: "artboard", spread: plan.spread, index: boards[i]!.index },
  });
  if (plan.mode === "all") return boards.map((_, i) => at(i));
  const want = plan.artboard ?? "";
  let hits = names.flatMap((n, i) => (n === want ? [i] : []));
  if (hits.length === 0) hits = names.flatMap((n, i) => (n.toLowerCase() === want.toLowerCase() ? [i] : []));
  if (hits.length !== 1) {
    const why = hits.length === 0 ? `no artboard named '${want}'` : `artboard name '${want}' is ambiguous (${hits.length} matches)`;
    throw new UsageError(`${why} on spread ${plan.spread}`, `artboards: ${names.join(", ")}`);
  }
  return [at(hits[0]!)];
}

/**
 * Appends each written file to `exports` in the document's manifest. Only a
 * saved document that already has a manifest is recorded; best effort and
 * silent, so stdout never changes. Touches no other manifest field.
 */
export function recordExports(
  doc: DocInfo,
  plan: Plan,
  preset: string,
  written: Written[],
  aiGenerated: boolean,
): void {
  if (!doc.path) return;
  try {
    const m = readManifest(doc.path);
    if (!m) return;
    const now = new Date().toISOString();
    const areaOf = (w: { name: string }): string =>
      plan.mode === "spread" ? `spread:${plan.spread}` : plan.mode === "artboard" || plan.mode === "all" ? `artboard:${w.name}` : plan.mode;
    m.exports = [
      ...(m.exports ?? []),
      ...written.map((w) => ({
        time: now,
        path: w.path,
        preset: w.preset ?? preset,
        area: areaOf(w),
        size: w.size,
        bytes: w.bytes,
        aiGenerated,
        ...(w.alt !== undefined ? { alt: w.alt } : {}),
        ...(w.preset !== undefined && w.preset !== preset ? { requested: preset } : {}),
        ...(w.attempts !== undefined ? { attempts: w.attempts.length } : {}),
      })),
    ];
    writeManifest(doc.path, m);
  } catch {
    // the export itself succeeded; a manifest problem must not fail it
  }
}
