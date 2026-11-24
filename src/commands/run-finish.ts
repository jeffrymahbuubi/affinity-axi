// The finish steps of `run`: --save, --export, --close, --discard. Flag validation is pure (before any
// connection); the checks before the script and the steps after it need the connection. A failed script is
// never saved or exported; with --discard the documents it created are dropped (plan F3, F8, F9).

import { mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { positiveFlag, type Parsed } from "../cli/args.js";
import type { FlagSpec } from "../cli/spec.js";
import type { BrandKit } from "../affinity/brand.js";
import { freshness, recordSave } from "../affinity/manifest.js";
import type { BrandRef, Inventory } from "../affinity/manifest-types.js";
import { FORCE_FLAG, checkOverwrite } from "../affinity/overwrite.js";
import { realish, requireUnderDesktop, requireVisible, shown, userPath } from "../affinity/paths.js";
import { APP_INFO } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { emitKV } from "../output/toon.js";
import { TransportError } from "../mcp/client.js";
import type { AffinityClient } from "../mcp/types.js";
import { DOC_CLOSE, DOC_SAVE, fetchInventory, runDocScript } from "./doc.js";
import { recordExports } from "./fill-export.js";
import { checkExportTarget, discardDoc, exportTo, reportedUuid, requirePreset, type DiscardResult } from "./finish.js";
import { callJson, type DocListing } from "./run.js";
import { runDocHelp } from "./run-parts.js";

const BIN = "affinity-axi";
const id8 = (uuid: string): string => uuid.slice(0, 8).toUpperCase();

export const FINISH_FLAGS: FlagSpec[] = [
  { name: "save", type: "string", description: "after an ok run, save the document the script made as this .af (under the Desktop); writes the manifest like doc save" },
  FORCE_FLAG,
  { name: "export", type: "string", description: "after an ok run, export the whole document with this preset to --out (see: affinity-axi presets); Affinity's metadata is stripped" },
  { name: "out", type: "string", description: "file for --export, under the Desktop; its extension must match the preset" },
  { name: "width", type: "string", description: "with --export: output width in px (height follows)" },
  { name: "close", type: "boolean", description: "after an ok run, close the document (it must be clean: use --save, or save in the script)" },
  { name: "discard", type: "boolean", description: "close the document the run created without keeping it (after --export, if given); after a failed run, drop every unsaved document that run created" },
];

export interface FinishFlags {
  save?: string;
  force: boolean;
  preset?: string;
  out?: string;
  width?: number;
  close: boolean;
  discard: boolean;
}

/** The finish flags, validated offline; undefined when none is given. */
export function parseFinish(parsed: Parsed, generative: boolean): FinishFlags | undefined {
  const str = (n: string): string | undefined => (typeof parsed.flags[n] === "string" ? (parsed.flags[n] as string) : undefined);
  const rawSave = str("save");
  const preset = str("export");
  const rawOut = str("out");
  const rawWidth = str("width");
  const force = parsed.flags["force"] === true;
  const close = parsed.flags["close"] === true;
  const discard = parsed.flags["discard"] === true;
  if (rawSave === undefined && preset === undefined && rawOut === undefined && rawWidth === undefined && !close && !discard) {
    if (force) throw new UsageError("--force needs --save <path>.af", "--force replaces an existing .af");
    return undefined;
  }
  let save: string | undefined;
  if (rawSave !== undefined) {
    save = userPath(rawSave);
    if (!save.toLowerCase().endsWith(".af")) {
      throw new UsageError(`save path must end in .af: ${shown(save)}`, `example: ${BIN} run draw.js --save ~/Desktop/work.af`);
    }
    requireVisible(save, "save path");
  }
  if (close && discard) throw new UsageError("--close and --discard cannot be combined", "--close keeps the saved document, --discard drops it");
  if (save !== undefined && discard) throw new UsageError("--save and --discard cannot be combined", "use --save <path>.af --close to keep the document");
  const eg = `e.g. ${BIN} run draw.js --export PNG --out ~/Desktop/x.png`;
  if (preset !== undefined && rawOut === undefined) throw new UsageError("--export needs --out <file>", eg);
  if (preset === undefined && rawOut !== undefined) throw new UsageError("--out needs --export <preset>", eg);
  if (preset === undefined && rawWidth !== undefined) throw new UsageError("--width needs --export <preset>", eg);
  if (force && save === undefined) throw new UsageError("--force needs --save <path>.af", "--force replaces an existing .af");
  if (preset !== undefined && generative) {
    throw new UsageError("--export cannot label AI-generated files", `drop --export and run '${BIN} export <doc> <preset> <path>' after the run: it writes the AI label and sidecar`);
  }
  const width = positiveFlag(parsed, "width", { integer: true, example: "512" });
  let out: string | undefined;
  if (preset !== undefined && rawOut !== undefined) {
    out = userPath(rawOut);
    checkExportTarget(preset, out, width);
  }
  return {
    ...(save !== undefined ? { save } : {}),
    force,
    ...(preset !== undefined ? { preset } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(width !== undefined ? { width } : {}),
    close,
    discard,
  };
}

/** After connecting, before the script: the Desktop, the path checks, the stale verdict and the preset. A refusal runs no script. */
export async function preCheck(client: AffinityClient, f: FinishFlags, file: string, before: DocListing | null): Promise<string> {
  const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
  if (f.save !== undefined) {
    requireUnderDesktop(app.desktop, f.save, "save path", "write-file");
    // A document already open at the target path may be saved back to it; any other existing .af needs the manifest or --force.
    const own = before?.documents.find((d) => d.path !== "" && realish(d.path) === realish(f.save!))?.path;
    const early = checkOverwrite(f.save, { force: f.force, ...(own ? { ownPath: own } : {}), cmd: `${BIN} run ${shown(file)} --save ${shown(f.save)}` });
    if (!early.ok) throw new AxiError(early.message, early.suggestion);
  }
  if (f.out !== undefined) requireUnderDesktop(app.desktop, f.out, "--out", "write-file");
  if (f.preset !== undefined) await requirePreset(client, f.preset);
  return app.desktop;
}

export interface FinishResult {
  lines: string[];
  /** Help lines that replace runDocHelp's; null keeps them. */
  helps: string[] | null;
  failed: boolean;
  /** Upper-case uuids closed or discarded by the finish (never marked owned). */
  gone: string[];
  /** Documents of a failed run that are still open (set by the failed path only). */
  remaining?: DocListing["documents"];
}

export interface FinishCtx {
  desktop: string;
  text: string;
  opened: DocListing["documents"];
  listing: DocListing | null;
  timeoutMs: number;
  brand: { kit: BrandKit; ref: BrandRef } | undefined;
}

class StepFailure extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly leftover?: string,
  ) {
    super(message);
  }
}

function discardLines(r: DiscardResult): string[] {
  return r.status === "discarded" && r.leftover ? [`leftover: ${shown(r.leftover)}`] : [];
}

/** The finish of an ok run: save, export, then close or discard; the first failing step stops the rest. */
export async function finishOk(client: AffinityClient, f: FinishFlags, ctx: FinishCtx): Promise<FinishResult> {
  const opened = new Set(ctx.opened.map((d) => d.uuid.toUpperCase()));
  const uuid = reportedUuid(ctx.text) ?? (ctx.opened.length === 1 ? ctx.opened[0]!.uuid.toUpperCase() : undefined);
  const lines: string[] = [];
  const helps: string[] = [];
  const gone: string[] = [];
  let step = f.save !== undefined ? "save" : f.preset !== undefined ? "export" : f.close ? "close" : "discard";
  let saved = false;
  let leftover: string | undefined;
  try {
    if (uuid === undefined) {
      throw new StepFailure(
        step,
        `cannot tell which document to finish: the output names no uuid and the run opened ${ctx.opened.length} documents; log JSON.stringify({uuid: String(doc.sessionUuid)})`,
      );
    }
    lines.push(`doc: ${uuid}`);
    if (f.save !== undefined) {
      step = "save";
      const path = f.save;
      const own = ctx.listing?.documents.find((d) => d.uuid.toUpperCase() === uuid)?.path ?? "";
      const cmd = `${BIN} run <script> --save ${shown(path)}`;
      const fresh = freshness(path);
      const verdict = checkOverwrite(path, { force: f.force, ...(own ? { ownPath: own } : {}), cmd });
      if (!verdict.ok) throw new StepFailure(step, verdict.message);
      mkdirSync(dirname(path), { recursive: true });
      const out = await runDocScript<{ status: string; path?: string; dirty?: boolean }>(client, DOC_SAVE(uuid, path), "saving the document");
      if (out.status === "missing") throw new StepFailure(step, `document ${uuid} is no longer open`);
      try {
        statSync(path);
      } catch {
        throw new StepFailure(step, `save reported success but ${shown(path)} was not written`);
      }
      saved = true;
      lines.push(emitKV([["saved", shown(out.path ?? path)]]));
      let inventory: Inventory | null = null;
      if (out.status !== "unchanged" || f.force || fresh.state === "none") inventory = await fetchInventory(client, uuid);
      try {
        recordSave(path, uuid, inventory, process.cwd(), { forced: verdict.forced, ...(own ? { fromPath: own } : {}) });
        lines.push(`manifest: ${basename(path)}.axi.json${verdict.forced ? " (forced)" : ""}`);
      } catch (err) {
        lines.push(`manifest: not updated (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (f.preset !== undefined && f.out !== undefined) {
      step = "export";
      let r;
      try {
        r = await exportTo(client, uuid, { preset: f.preset, path: f.out, ...(f.width !== undefined ? { width: f.width } : {}), timeoutMs: ctx.timeoutMs, ...(ctx.brand ? { brand: ctx.brand } : {}) });
      } catch (err) {
        if (err instanceof TransportError) throw err;
        throw new StepFailure(step, err instanceof Error ? err.message : String(err));
      }
      lines.push(emitKV([["exported", shown(r.path)]]));
      if (r.size !== "") lines.push(`size: ${r.size}`);
      lines.push(`bytes: ${r.bytes}`);
      if (r.metaNote !== null) lines.push(`metadata: ${r.metaNote}`);
      if (saved && f.save !== undefined) {
        recordExports({ client, outDir: dirname(r.path), timeoutMs: ctx.timeoutMs, preset: f.preset, ext: undefined, allBoards: false, brand: ctx.brand, budget: undefined }, f.save, [r.entry]);
      }
    }
    if (f.close) {
      step = "close";
      const r = await runDocScript<{ status: string }>(client, DOC_CLOSE(uuid), "closing the document");
      if (r.status === "dirty") throw new StepFailure(step, `document ${uuid} has unsaved changes; add --save <path>.af, or use --discard`);
      if (r.status !== "closed" && r.status !== "missing") throw new StepFailure(step, `the document did not close (${r.status}); check Affinity for a dialog`);
      gone.push(uuid);
      lines.push("closed: true");
    }
    if (f.discard) {
      step = "discard";
      if (!opened.has(uuid)) throw new StepFailure(step, `document ${id8(uuid)} was open before this run; --discard only drops documents the run created`);
      const r = await discardDoc(client, ctx.desktop, uuid);
      if (r.status === "failed") throw new StepFailure(step, r.message, r.leftover);
      gone.push(uuid);
      lines.push("discarded: true", ...discardLines(r));
      if (r.status === "discarded" && r.leftover) leftover = r.leftover;
    }
  } catch (err) {
    if (!(err instanceof StepFailure)) throw err;
    lines.push(`finish: failed at ${err.step}: ${err.message}`);
    if (err.leftover) {
      lines.push(`leftover: ${shown(err.leftover)}`);
      helps.push(`delete ${shown(err.leftover)}: the throwaway copy could not be removed`);
    }
    const doc = uuid === undefined ? undefined : ctx.opened.find((d) => d.uuid.toUpperCase() === uuid);
    return { lines, helps: doc ? [...runDocHelp(BIN, false, ctx.text, [doc]), ...helps] : helps.length > 0 ? helps : null, failed: true, gone };
  }
  if (leftover) helps.push(`delete ${shown(leftover)}: the throwaway copy could not be removed`);
  if (f.discard) return { lines, helps, failed: false, gone };
  if (uuid !== undefined && saved && f.save !== undefined) {
    if (f.close) helps.push(`${BIN} doc open ${shown(f.save)}`);
    else helps.push(`${BIN} doc close ${id8(uuid)}`, `${BIN} export ${id8(uuid)} PNG <path-under-Desktop>`);
    return { lines, helps, failed: false, gone };
  }
  return { lines, helps: helps.length > 0 ? helps : null, failed: false, gone };
}

/** The finish of a failed run: nothing is saved or exported; with --discard the unsaved documents it created are dropped. */
export async function finishFailed(client: AffinityClient, f: FinishFlags, ctx: Pick<FinishCtx, "desktop" | "opened"> & { listingsRead: boolean }): Promise<FinishResult> {
  const lines = ["finish: skipped (the run did not succeed)"];
  const gone: string[] = [];
  if (!f.discard || !ctx.listingsRead) return { lines, helps: null, failed: false, gone, remaining: ctx.opened };
  const targets = ctx.opened.filter((d) => d.path === "");
  const failures: string[] = [];
  const dropped: string[] = [];
  const helps: string[] = [];
  for (const d of targets) {
    let r: DiscardResult;
    try {
      r = await discardDoc(client, ctx.desktop, d.uuid);
    } catch (err) {
      r = { status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (r.status === "failed") {
      failures.push(`finish: failed at discard: ${id8(d.uuid)}: ${r.message}`);
      if (r.leftover) {
        failures.push(`leftover: ${shown(r.leftover)}`);
        helps.push(`delete ${shown(r.leftover)}: the throwaway copy could not be removed`);
      }
      continue;
    }
    dropped.push(id8(d.uuid));
    gone.push(d.uuid.toUpperCase());
    if (r.status === "discarded" && r.leftover) {
      lines.push(`leftover: ${shown(r.leftover)}`);
      helps.push(`delete ${shown(r.leftover)}: the throwaway copy could not be removed`);
    }
  }
  lines.push(dropped.length > 0 ? `discarded: ${dropped.join(" ")}   # created by the failed run` : "discarded: none");
  lines.push(...failures);
  const goneSet = new Set(gone);
  return { lines, helps: helps.length > 0 ? helps : null, failed: false, gone, remaining: ctx.opened.filter((d) => !goneSet.has(d.uuid.toUpperCase())) };
}

/** The F8 line for a failed run: one unsaved unnamed document, or several. */
export function discardHelp(remaining: DocListing["documents"]): string | undefined {
  const unsaved = remaining.filter((d) => d.path === "");
  if (unsaved.length === 1) return `${BIN} doc close ${id8(unsaved[0]!.uuid)} --discard   # or drop the half-built document without saving`;
  if (unsaved.length > 1) return `${BIN} doc close --mine --discard   # or drop every unsaved document affinity-axi created from this folder`;
  return undefined;
}
