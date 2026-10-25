// Runs one registry example against a live Affinity by spawning the built
// bin once per command, and holds the gallery helpers shared by
// scripts/gen-examples.mjs, scripts/check-examples.mjs and `examples --run`.
//
// Safety rules baked in: the demo document is addressed by uuid8 only (never
// `current`, other tools may share Affinity), a document the runner made is
// ended with `doc save` then `doc close` (never an unsaved close), and any
// spawn timeout stops everything at once without further Affinity calls.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { normalise } from "./normalise.js";
import type { Example } from "./types.js";

/** Examples that change Affinity's persistent state; skipped unless opted in. */
export const SIDE_EFFECT_IDS: readonly string[] = ["hint-add", "library-read", "library-save", "brand-init"];

export function isSideEffect(ex: Pick<Example, "id">): boolean {
  return SIDE_EFFECT_IDS.includes(ex.id);
}

/** Gallery images above this size draw a warning from examples:check. */
export const IMAGE_BUDGET_BYTES = 500 * 1024;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Splits a command line like a POSIX shell without expansion: whitespace separates, quotes group. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (quote) throw new Error(`unterminated ${quote} in: ${line}`);
  if (cur || has) out.push(cur);
  return out;
}

export interface Vars {
  doc: string;
  out: string;
}

/** Replaces $DOC and $OUT inside one token; $BIN is handled by the caller. */
export function substitute(token: string, vars: Vars): string {
  return token.split("$DOC").join(vars.doc).split("$OUT").join(vars.out);
}

/**
 * Adds `out` (the example folder, absolute) to a --args JSON object so a
 * script can find files that sit next to it. Other args are left alone.
 */
export function withOutArg(args: string[], outDir: string): string[] {
  const i = args.indexOf("--args");
  const raw = args[i + 1];
  if (i < 0 || raw === undefined) return args;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return args;
    const obj = parsed as Record<string, unknown>;
    if ("out" in obj) return args;
    const next = [...args];
    next[i + 1] = JSON.stringify({ ...obj, out: outDir });
    return next;
  } catch {
    return args;
  }
}

/** The command as the gallery shows it: $BIN spelled out, $OUT as the relative folder. */
export function displayCommand(command: string, id: string): string {
  return command.replace(/^\$BIN/, "affinity-axi").split("$OUT").join(`examples/${id}`);
}

export interface RunOptions {
  /** Path of the CLI entry file, run with node (e.g. bin/affinity-axi.js). */
  bin: string;
  /** Tool directory: the working directory of every spawn. */
  cwd: string;
  /** Absolute folder standing for $OUT; created when missing. */
  outDir: string;
  /** Demo document uuid8; when absent and the example needs a document, one is made and cleaned up. */
  demoDoc?: string;
  /** Script that makes the demo document (default <cwd>/examples/_brand/demo-doc.js). */
  demoScript?: string;
  /** Per-command timeout in ms (default 120000); a timeout is fatal. */
  timeoutMs?: number;
  /** Interpreter for bin (default the current node). */
  node?: string;
  /** Extra environment for the spawned bin (e.g. AFFINITY_MCP_URL). */
  env?: NodeJS.ProcessEnv;
}

export type FailureKind = "demo-doc" | "command" | "timeout" | "images" | "cleanup";

export interface RunFailure {
  kind: FailureKind;
  command: string;
  message: string;
  /** uuid8 of a document the runner made and could not end cleanly. */
  leftOpen?: string;
}

export interface RunResult {
  ok: boolean;
  /** Raw stdout of the commands under `$ <command>` headers. */
  output: string;
  /** `output` with paths made relative and ids, timings and the home directory normalised. */
  normalised: string;
  /** Files from `ex.images` that exist after the run. */
  images: string[];
  failed?: RunFailure;
}

interface Spawned {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

function spawnBin(o: RunOptions, args: string[]): Spawned {
  const r = spawnSync(o.node ?? process.execPath, [o.bin, ...args], {
    cwd: o.cwd,
    encoding: "utf8",
    timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    env: { ...process.env, ...o.env },
  });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status, timedOut };
}

function uuid8Of(text: string, field: "doc" | "uuid"): string | undefined {
  const m = field === "doc" ? /^doc: ([0-9A-Fa-f]{8})-/m.exec(text) : /"uuid"\s*:\s*"([0-9A-Fa-f]{8})-/.exec(text);
  return m?.[1];
}

/** Makes the demo document (1080x1080, one artboard named ig-square); returns its uuid8. */
function makeDemoDoc(o: RunOptions): { uuid8?: string; failure?: RunFailure } {
  const script = o.demoScript ?? join(o.cwd, "examples/_brand/demo-doc.js");
  const command = "affinity-axi run examples/_brand/demo-doc.js --with-helpers";
  const r = spawnBin(o, ["run", script, "--with-helpers"]);
  if (r.timedOut) return { failure: { kind: "timeout", command, message: "timed out making the demo document" } };
  const uuid8 = uuid8Of(r.stdout, "uuid");
  if (r.status !== 0 || !uuid8) {
    return { failure: { kind: "demo-doc", command, message: (r.stdout + r.stderr).trim().split("\n").slice(0, 3).join(" | ") } };
  }
  return { uuid8 };
}

/**
 * Whether the home view lists the document. `undefined` unless the view printed a
 * `documents[N]...:` header, so an `unavailable` table is never read as "closed".
 */
function isOpen(o: RunOptions, uuid8: string): boolean | undefined {
  const r = spawnBin(o, []);
  if (r.timedOut || r.status !== 0) return undefined;
  const lines = r.stdout.split("\n");
  const at = lines.findIndex((l) => /^documents\[\d+\](\{[^}]*\})?:\s*$/.test(l));
  if (at < 0) return undefined;
  const want = uuid8.toLowerCase();
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line)) break;
    const cell = line.trim().split(",")[0] ?? "";
    if (cell.toLowerCase().startsWith(want)) return true;
  }
  return false;
}

const GONE = /no open document matches/;

/** Ends a document the runner made: `doc save --force` then `doc close`; nothing when it is already gone. */
function endDemoDoc(o: RunOptions, uuid8: string): RunFailure | undefined {
  if (isOpen(o, uuid8) === false) return undefined;
  const fail = (message: string): RunFailure => ({ kind: "cleanup", command: `doc save/close ${uuid8}`, message, leftOpen: uuid8 });
  const first = (r: Spawned, what: string): string => (r.stdout + r.stderr).trim().split("\n")[0] || `${what} failed`;
  const save = spawnBin(o, ["doc", "save", uuid8, join(o.outDir, "demo.af"), "--force"]);
  if (save.timedOut) return fail("doc save timed out");
  if (save.status !== 0) return GONE.test(save.stdout + save.stderr) ? undefined : fail(first(save, "doc save"));
  const close = spawnBin(o, ["doc", "close", uuid8]);
  if (close.timedOut) return fail("doc close timed out");
  if (close.status !== 0) return GONE.test(close.stdout + close.stderr) ? undefined : fail(first(close, "doc close"));
  return undefined;
}

/** Makes the working and output folders relative; the CLI may print them absolute or with a leading ~. */
function pathsToRelative(text: string, o: RunOptions, id: string): string {
  let out = text;
  const home = homedir();
  const forms = (p: string): string[] => (home.length > 1 && p.startsWith(home + "/") ? [p, "~" + p.slice(home.length)] : [p]);
  for (const f of forms(o.outDir)) if (f.length > 1) out = out.split(f).join(`examples/${id}`);
  for (const f of forms(o.cwd)) if (f.length > 1) out = out.split(f + "/").join("").split(f).join(".");
  return out;
}

/** Table cells named doc that hold a bare uuid8 (batch rows) become <uuid8>; the normaliser only knows full UUIDs. */
function normaliseDocCells(text: string): string {
  let doc = -1;
  return text
    .split("\n")
    .map((line) => {
      const header = /^[A-Za-z][\w.-]*\[[^\]]*\]\{([^}]*)\}:\s*$/.exec(line);
      if (header) {
        doc = header[1]!.split(",").indexOf("doc");
        return line;
      }
      if (!/^\s/.test(line)) doc = -1;
      if (doc < 0 || !/^\s/.test(line)) return line;
      const indent = /^\s*/.exec(line)![0];
      const cells = line.slice(indent.length).split(",");
      if (/^[0-9A-Fa-f]{8}$/.test(cells[doc] ?? "")) cells[doc] = "<uuid8>";
      return indent + cells.join(",");
    })
    .join("\n");
}

/** Runs every command of `ex` and collects the output; never throws for command failures. */
export function runExample(ex: Example, o: RunOptions): RunResult {
  mkdirSync(o.outDir, { recursive: true });
  const blocks: string[] = [];
  let failed: RunFailure | undefined;
  let madeDoc: string | undefined;
  let doc = o.demoDoc ?? "";

  if (ex.needs.includes("document") && !doc) {
    const made = makeDemoDoc(o);
    if (made.failure) return { ok: false, output: "", normalised: "", images: [], failed: made.failure };
    madeDoc = made.uuid8;
    doc = made.uuid8!;
  }

  const vars: Vars = { doc, out: o.outDir };
  for (const command of ex.commands) {
    const shown = displayCommand(command, ex.id);
    const tokens = tokenize(command).slice(1).map((t) => substitute(t, vars));
    const args = tokens[0] === "run" || tokens[0] === "batch" ? withOutArg(tokens, o.outDir) : tokens;
    const r = spawnBin(o, args);
    blocks.push(`$ ${shown}\n${r.stdout.trimEnd()}`);
    if (r.timedOut) {
      failed = { kind: "timeout", command: shown, message: `timed out after ${(o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`, leftOpen: madeDoc };
      break;
    }
    if (r.status !== 0) {
      failed = { kind: "command", command: shown, message: `exit ${r.status}: ${(r.stdout + r.stderr).trim().split("\n")[0] ?? ""}` };
      break;
    }
    if (tokens[0] === "doc" && tokens[1] === "new") {
      // A fresh document is clean, so closing it cannot prompt.
      const extra = uuid8Of(r.stdout, "doc");
      if (extra) spawnBin(o, ["doc", "close", extra]);
    }
  }

  // A timeout means Affinity may be stuck behind a dialog: no further calls.
  if (madeDoc && failed?.kind !== "timeout") {
    const cleanup = endDemoDoc(o, madeDoc);
    if (cleanup) {
      if (failed) failed.leftOpen = cleanup.leftOpen;
      else failed = cleanup;
    }
  }

  const images = ex.images.filter((f) => existsSync(join(o.outDir, f)));
  if (!failed && images.length !== ex.images.length) {
    const missing = ex.images.filter((f) => !images.includes(f));
    failed = { kind: "images", command: ex.commands[ex.commands.length - 1] ?? "", message: `missing image ${missing.join(", ")}` };
  }

  const output = blocks.join("\n\n") + "\n";
  let normalised = normaliseDocCells(normalise(pathsToRelative(output, o, ex.id)));
  if (doc) normalised = normalised.replace(new RegExp(`(?<![0-9A-Za-z])${doc}(?![0-9A-Za-z])`, "gi"), "<uuid8>");
  return { ok: !failed, output, normalised, images, failed };
}

/** Command paths from the root `--help` table: "run", "doc save", "docs read", ... */
export function parseCommandPaths(rootHelp: string): string[] {
  const lines = rootHelp.split("\n");
  const start = lines.findIndex((l) => l.startsWith("commands["));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  const rows = lines.slice(start + 1, end < 0 ? undefined : end);
  const paths = rows.map((row) => {
    const t = row.trim();
    const cell = t.startsWith('"') ? t.slice(1).split('"')[0]! : t.split(",")[0]!;
    return cell.split(" ").filter((w) => w && !w.startsWith("<") && !w.startsWith("[")).join(" ");
  });
  return paths.filter((p) => p !== "" && !p.startsWith("-"));
}

/** The gallery's command.sh: the commands as the example runs them. */
export function renderCommandSh(ex: Example): string {
  const lines = ["#!/bin/sh", `# ${ex.title}: ${ex.summary}`];
  if (ex.needs.includes("document")) {
    lines.push("# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).");
  }
  if (ex.commands.some((c) => c.includes("--args"))) {
    lines.push("# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.");
  }
  for (const c of ex.commands) lines.push(displayCommand(c, ex.id));
  return lines.join("\n") + "\n";
}

/** Output lines of an output.txt without the `$ command` headers and blank lines. */
function bodyLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("$ "));
}

/** examples/README.md: one section per example with a thumbnail and its first output lines. */
export function renderReadme(examples: readonly Example[], galleryDir: string): string {
  const out = [
    "# affinity-axi examples",
    "",
    "Generated by `npm run examples:gen`. Every example uses the invented demo brand Lumen Studio with Helvetica.",
    "Each folder holds `example.json`, `command.sh`, `output.txt` (normalised stdout) and the files the commands made.",
    "",
  ];
  for (const ex of examples) {
    out.push(`## ${ex.title}`, "", `\`${ex.id}\`: ${ex.summary}`, "");
    const outputPath = join(galleryDir, ex.id, "output.txt");
    if (ex.pending) {
      out.push("Not generated yet: the feature is not merged.", "");
      continue;
    }
    if (!existsSync(outputPath)) {
      out.push(isSideEffect(ex) ? "Not generated by default: it changes Affinity's stored state (`--include-side-effects`)." : "Not generated yet.", "");
      continue;
    }
    const shot = ex.images.find((f) => /\.(png|jpe?g)$/i.test(f));
    if (shot) out.push(`![${ex.title}](${ex.id}/${shot})`, "");
    out.push("```", ...ex.commands.map((c) => displayCommand(c, ex.id)), "```", "", "```", ...bodyLines(readFileSync(outputPath, "utf8")).slice(0, 6), "```", "");
  }
  return out.join("\n");
}

export interface GalleryReport {
  errors: string[];
  warnings: string[];
  checked: string[];
  skipped: string[];
}

function walkImages(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "_run") walkImages(p, found);
    }
    else if (/\.(png|jpe?g)$/i.test(name)) found.push(p);
  }
  return found;
}

/**
 * Offline gallery check: each non-pending example has a folder with output.txt,
 * its images and script, and its sample lines appear in order in output.txt.
 * Side-effect examples are checked only once they have an output.txt.
 * Images above the budget are warnings, never errors.
 */
export function checkGallery(examples: readonly Example[], galleryDir: string): GalleryReport {
  const report: GalleryReport = { errors: [], warnings: [], checked: [], skipped: [] };
  for (const ex of examples) {
    const dir = join(galleryDir, ex.id);
    const outputPath = join(dir, "output.txt");
    if (ex.pending) {
      report.skipped.push(`${ex.id} (pending)`);
      continue;
    }
    if (isSideEffect(ex) && !existsSync(outputPath)) {
      report.skipped.push(`${ex.id} (side effects)`);
      continue;
    }
    if (!existsSync(dir)) {
      report.errors.push(`${ex.id}: no gallery folder examples/${ex.id}/`);
      continue;
    }
    if (!existsSync(outputPath)) {
      report.errors.push(`${ex.id}: examples/${ex.id}/output.txt is missing`);
      continue;
    }
    report.checked.push(ex.id);
    const lines = readFileSync(outputPath, "utf8").split("\n");
    let at = 0;
    for (const sample of ex.output) {
      const found = lines.indexOf(sample, at);
      if (found < 0) {
        report.errors.push(`${ex.id}: sample line missing or out of order in output.txt: ${sample}`);
        break;
      }
      at = found + 1;
    }
    for (const img of ex.images) if (!existsSync(join(dir, img))) report.errors.push(`${ex.id}: image examples/${ex.id}/${img} is missing`);
    if (ex.script && !existsSync(join(dir, ex.script))) report.errors.push(`${ex.id}: script examples/${ex.id}/${ex.script} is missing`);
  }
  for (const img of walkImages(galleryDir)) {
    const bytes = statSync(img).size;
    if (bytes > IMAGE_BUDGET_BYTES) {
      report.warnings.push(`${relative(galleryDir, img)} is ${Math.round(bytes / 1024)} KB (budget ${IMAGE_BUDGET_BYTES / 1024} KB)`);
    }
  }
  return report;
}

/** Files of an example folder that are inputs (scripts, data, photos), not generated output. */
export function inputFiles(ex: Example, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const generated = new Set(["example.json", "command.sh", "output.txt", "demo.af", "demo.af.axi.json", ...ex.images]);
  return readdirSync(dir).filter((n) => !generated.has(n) && !n.endsWith("~lock~") && statSync(join(dir, n)).isFile());
}
