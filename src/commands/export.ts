// `export <doc> <preset> <path>` and `presets`, plus export area
// (artboard, all artboards, selection, spread), pixel size and embedded AI
// metadata for generative documents.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { altFor, ALT_TEXT_CHARS, NO_ALT_FLAG, type AltArea } from "../affinity/alt-text.js";
import { resolveDocRef } from "../affinity/docref.js";
import { describeAi, embedAiMetadata, exiftoolAvailable, sourceTypeFor } from "../affinity/exif.js";
import {
  EXPORT_AREA,
  LIST_ARTBOARDS,
  imageKind,
  imageSize,
  parseSizeFlags,
  targetSize,
  uniqueSafeNames,
  type AreaSpec,
} from "../affinity/export-area.js";
import {
  budgetFor,
  fitBudget,
  formatChange,
  ladderFor,
  MAX_KB_FLAG,
  MIN_SCALE_FLAG,
  noFitMessage,
  NO_FIT_SUGGESTION,
  scaledDim,
  type Attempt,
} from "../affinity/export-budget.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { INSPECT } from "../affinity/inspect-script.js";
import { readManifest, writeManifest } from "../affinity/manifest.js";
import type { Inventory } from "../affinity/manifest-types.js";
import { recordsFor, writeSidecar } from "../affinity/provenance.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, EXPORT, LIST_DOCUMENTS, LIST_PRESETS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn, DocInfo, ToolResult } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const SIZE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

function urlFlag(parsed: Parsed): string | undefined {
  const u = parsed.flags["url"];
  return typeof u === "string" ? u : undefined;
}

export function makePresets(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "presets",
      summary: "List the export preset names available in this Affinity install",
      flags: [{ name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" }],
      examples: ["affinity-axi presets", "affinity-axi presets --url http://127.0.0.1:6767"],
    },
    async run(parsed: Parsed): Promise<number> {
      const client = await connect({ url: urlFlag(parsed) });
      let names: string[];
      try {
        names = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
      } finally {
        client.close();
      }
      print(
        [
          emitList("presets", names.map((name) => ({ name })), ["name"]),
          helpBlock([`${BIN} export current <preset> <path-under-Desktop>`]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

interface Plan {
  mode: "whole" | "spread" | "selection" | "artboard" | "all";
  artboard?: string;
  /** 0-based spread index (same convention as `render --spread`). */
  spread: number;
}

/** Validates the area flags and the {name} placeholder before any connection. */
function planArea(parsed: Parsed, rawPath: string): Plan {
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

interface Target {
  /** Artboard name, or "" when the area is not an artboard. */
  name: string;
  path: string;
  area: AreaSpec | null;
}

/** A written file as reported: bytes and size from disk, plus what a budget or the alt stub added. */
interface Written extends Target {
  bytes: number;
  size: string;
  /** Final preset when a budget stepped it. */
  preset?: string;
  attempts?: Attempt[];
  fit?: boolean;
  alt?: string;
}

const ALT_NONE = "(none; add one)";
const ALT_UNAVAILABLE = "(unavailable; read the text with inspect)";
const altText = (w: Written): string => (w.alt === undefined ? ALT_UNAVAILABLE : w.alt === "" ? ALT_NONE : w.alt);

/** The inventory area a target's alt text comes from (a selection reads the whole inventory). */
function altArea(plan: Plan, t: Target): AltArea {
  if (plan.mode === "artboard" || plan.mode === "all") return { kind: "artboard", name: t.name };
  return plan.mode === "selection" ? { kind: "all" } : { kind: "spread", spread: plan.spread };
}

/** One inventory call, then an alt stub per target ("" = no text). Best effort: null when it fails, the files are already written. */
async function altStubs(client: AffinityClient, uuid: string, plan: Plan, targets: Target[]): Promise<Array<string | null>> {
  try {
    const inv = await callJson<Inventory>(client, INSPECT(uuid, { textChars: ALT_TEXT_CHARS }), "reading text for alt", { timeoutMs: 120000 });
    return targets.map((t) => altFor(inv, altArea(plan, t)));
  } catch {
    return targets.map(() => null);
  }
}

/** The TOON report: the plain export lines, plus attempts when a budget ran and an alt line unless --no-alt. */
function report(uuid: string, plan: Plan, preset: string, written: Written[], tags: Array<[string, string]>, kb: number | null, wantAlt: boolean): string {
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

function failure(result: ToolResult, what: string): AxiError {
  const first = resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure";
  return new AxiError(`${what}: ${first}`, `check the path is writable and the preset suits this document; list presets with '${BIN} presets'`);
}

async function runScript(client: AffinityClient, script: string, what: string): Promise<string> {
  const result = await client.callTool("execute_script", { script });
  if (classify(result).kind !== "ok") throw failure(result, what);
  return resultText(result);
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new AxiError(`export reported success but ${path} was not written`, "check the folder exists and retry");
  }
}

/** Resolves the artboard targets of a plan against the document's real artboard list. */
async function artboardTargets(client: AffinityClient, doc: DocInfo, plan: Plan, template: string): Promise<Target[]> {
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

/** For AI-generated documents: embeds IPTC metadata where possible and writes the sidecars. Returns output lines. */
function tagAiExports(docUuid: string, targets: Target[]): Array<[string, string]> {
  const records = recordsFor(docUuid);
  if (records.length === 0) return [];
  const kv: Array<[string, string]> = [["provenance", "ai-generated"]];
  const raster = targets.filter((t) => imageKind(readBytes(t.path)) !== null);
  let metadata: string;
  if (raster.length === 0) metadata = "sidecar only (format not supported for embedding)";
  else if (!exiftoolAvailable()) metadata = "sidecar only (exiftool not found)";
  else {
    const type = sourceTypeFor(records);
    const text = describeAi(type);
    const results = raster.map((t) => embedAiMetadata(t.path, type, text));
    const failed = results.find((r) => !r.ok);
    const done = results.filter((r) => r.ok).length;
    if (!failed && done === targets.length) metadata = "iptc embedded";
    else if (done === 0) metadata = `sidecar only (exiftool failed: ${failed?.error ?? "unknown"})`;
    else metadata = `iptc embedded in ${done} of ${targets.length} files, others sidecar only`;
  }
  kv.push(["metadata", metadata]);
  const files: string[] = [];
  let firstError: string | undefined;
  for (const t of targets) {
    try {
      files.push(writeSidecar(t.path, docUuid, records));
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (firstError !== undefined) kv.push(["provenance_file", `NOT WRITTEN (${firstError})`]);
  else if (files.length === 1) kv.push(["provenance_file", files[0]!]);
  else kv.push(["provenance_files", String(files.length)]);
  return kv;
}

/**
 * Appends each written file to `exports` in the document's manifest. Only a
 * saved document that already has a manifest is recorded; best effort and
 * silent, so stdout never changes. Touches no other manifest field.
 */
function recordExports(
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

export function makeExport(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "export",
      summary: "Export a document with a named preset to a path under the Desktop folder",
      args: [
        { name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" },
        { name: "preset", required: true, description: "exact preset name (see 'affinity-axi presets')" },
        { name: "path", required: true, description: "output file path; must be inside the Desktop folder; {name} stands for the artboard name" },
      ],
      flags: [
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
        { name: "artboard", type: "string", description: "export one artboard by name" },
        { name: "all-artboards", type: "boolean", description: "one file per artboard; <path> must contain {name}" },
        { name: "selection", type: "boolean", description: "export the current selection" },
        { name: "spread", type: "string", description: "spread index from 0: the spread itself, or the spread holding the artboards" },
        { name: "width", type: "string", description: "output width in px (height follows the aspect ratio)" },
        { name: "height", type: "string", description: "output height in px (width follows the aspect ratio)" },
        { name: "scale", type: "string", description: "output scale factor, e.g. 2 for @2x" },
        { name: "square", type: "string", description: "fit the longer side to <px> keeping the aspect ratio, e.g. 512" },
        { ...MAX_KB_FLAG },
        { ...MIN_SCALE_FLAG },
        { ...NO_ALT_FLAG },
      ],
      examples: [
        "affinity-axi export current PNG ~/Desktop/logo.png",
        "affinity-axi export current PNG ~/Desktop/out/{name}.png --all-artboards",
        "affinity-axi export current PNG ~/Desktop/og@2x.png --artboard og --scale 2",
        'affinity-axi export current "JPEG (High quality)" ~/Desktop/ad.jpg --artboard ad-300x250 --max-kb 150',
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const [ref, preset, rawPath] = parsed.positionals as [string, string, string];
      const template = userPath(rawPath);
      const probe = template.split("{name}").join("x");
      requireVisible(probe, "export path");
      const plan = planArea(parsed, rawPath);
      const size = parseSizeFlags(parsed);
      const budget = budgetFor(parsed);
      const wantAlt = parsed.flags["no-alt"] !== true;
      if ((size || budget) && !SIZE_EXTS.includes(extname(template).toLowerCase())) {
        const flagsText = budget ? "--max-kb" : "size flags";
        throw new UsageError(
          `${flagsText} need a raster output path (${SIZE_EXTS.join(", ")}), got '${extname(template) || "no extension"}'`,
          "use a PNG, JPEG or WebP preset and file name, or drop --width, --height, --scale, --square and --max-kb",
        );
      }
      if (budget) ladderFor(preset, [preset], budget.minScale); // a non-raster preset is a usage error, before connecting

      const client = await connect({ url: urlFlag(parsed) });
      let doc: DocInfo;
      let targets: Target[];
      const budgeted = new Map<string, Attempt[]>();
      let alts: Array<string | null> | null = null;
      try {
        const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
        if (!presets.includes(preset)) {
          const q = preset.toLowerCase();
          const close = presets.filter((p) => p.toLowerCase().includes(q));
          const hint = close.length > 0 ? `closest: ${close.join(", ")}; ` : "";
          throw new UsageError(`unknown export preset '${preset}'`, `${hint}run '${BIN} presets' to list all names`);
        }

        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, probe, "export path", "write-file");

        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(
          client,
          LIST_DOCUMENTS,
          "listing documents",
        );
        doc = resolveDocRef(ref, listing.documents, listing.current);

        if (plan.mode === "all" || plan.mode === "artboard") targets = await artboardTargets(client, doc, plan, template);
        else if (plan.mode === "selection") targets = [{ name: "", path: template, area: { kind: "selection" } }];
        else if (plan.mode === "spread") targets = [{ name: "", path: template, area: { kind: "spread", spread: plan.spread } }];
        else targets = [{ name: "", path: template, area: null }];

        const plain = plan.mode === "whole" && !size;
        for (const t of targets) {
          const what = t.name === "" ? "export failed" : `export of artboard '${t.name}' failed`;
          await runScript(client, plain ? EXPORT(doc.uuid, preset, t.path) : EXPORT_AREA(doc.uuid, preset, t.path, t.area, null), what);
          if (!size && !budget) continue;
          // The SDK takes an absolute pixel size, so export at natural size first and read it back.
          const natural = imageSize(readBytes(t.path));
          if (!natural) {
            throw new AxiError(`cannot read the pixel size of ${t.path}`, "size and budget flags support PNG, JPEG and WebP presets only");
          }
          const want = size ? targetSize(natural, size) : natural;
          if (want.width !== natural.width || want.height !== natural.height) {
            await runScript(client, EXPORT_AREA(doc.uuid, preset, t.path, t.area, want), what);
          }
          if (!budget) continue;
          // The first step is the file just written; later steps re-export lower quality, then smaller.
          const steps = ladderFor(preset, presets, budget.minScale);
          const fitted = await fitBudget(steps, budget.bytes, async (s) => {
            if (s !== steps[0]) {
              const dim = s.scale === 1 && !size ? null : scaledDim(want, s.scale);
              await runScript(client, EXPORT_AREA(doc.uuid, s.preset, t.path, t.area, dim), what);
            }
            const buf = readBytes(t.path);
            const dim = imageSize(buf);
            return { bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
          });
          budgeted.set(t.path, fitted.attempts);
        }
        if (wantAlt) alts = await altStubs(client, doc.uuid, plan, targets);
      } finally {
        client.close();
      }

      // Tag first (it rewrites the files), then measure what is on disk.
      const tags = tagAiExports(doc.uuid, targets);
      const written: Written[] = targets.map((t, i) => {
        const buf = readBytes(t.path);
        const dim = imageSize(buf);
        const w: Written = { ...t, bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
        const tried = budgeted.get(t.path);
        if (tried) Object.assign(w, { attempts: tried, preset: tried[tried.length - 1]!.preset, fit: tried[tried.length - 1]!.fit });
        const alt = alts?.[i];
        if (alt !== undefined && alt !== null) w.alt = alt;
        return w;
      });

      recordExports(doc, plan, preset, written, tags.length > 0);
      print(report(doc.uuid, plan, preset, written, tags, budget?.kb ?? null, wantAlt));
      const misses = written.filter((w) => w.fit === false);
      if (budget && misses.length > 0) {
        const m = misses[0]!;
        const more = misses.length > 1 ? ` (and ${misses.length - 1} more)` : "";
        throw new AxiError(`${noFitMessage(m.path, budget.kb, m.attempts![m.attempts!.length - 1]!)}${more}`, NO_FIT_SUGGESTION);
      }
      return 0;
    },
  };
}

/** Both commands hosted by this module, for the registry. */
export function make(connect: ConnectFn): { export: CommandModule; presets: CommandModule } {
  return { export: makeExport(connect), presets: makePresets(connect) };
}
