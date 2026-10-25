// `doc open`, `doc info`, `doc note`: revisit a saved .af. The .af is the
// source of truth; the sidecar manifest is a cache bound to the file's sha256,
// so every view says whether it can be trusted (fresh | stale | none).
// `doc info` and `doc note` never connect; `doc open` never closes anything.

import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { freshness, readManifest, sha256File, writeManifest } from "../affinity/manifest.js";
import type { Freshness, Inventory, Manifest } from "../affinity/manifest-types.js";
import { APP_INFO } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { BIN, URL_FLAG, fetchInventory, runDocScript, urlFlag } from "./doc.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { callJson } from "./run.js";

const PATH_ARG = { name: "path", required: true, description: "a saved .af file; must be inside the Desktop folder for doc open" };
const MAX_NAMES = 12;
const MAX_ARGS = 200;

// The console.log call inside this script string is required output: the only
// channel back from Affinity.
/**
 * Opens a .af unless a document with that path is already open (never reloads).
 * Logs {"status":"opened"|"already-open"|"error","uuid","title","dirty","message"}.
 */
export function DOC_OPEN(path: string): string {
  return [
    "/* affinity-axi:doc-open */",
    "const { Document } = require('/document.js');",
    `const outPath = ${JSON.stringify(path)};`,
    "let doc = Document.all.find((d) => String(d.path || '') === outPath);",
    "let status = 'already-open';",
    "let message = '';",
    "if (!doc) {",
    "  try { doc = Document.load(outPath); status = 'opened'; } catch (e) { status = 'error'; message = String((e && e.message) || e); }",
    "}",
    "console.log(JSON.stringify(doc ? { status, uuid: String(doc.sessionUuid), title: String(doc.title), dirty: !!doc.isDirty } : { status: 'error', message }));",
  ].join("\n");
}

function afPath(raw: string): string {
  const path = userPath(raw);
  if (!path.toLowerCase().endsWith(".af")) {
    throw new UsageError(`path must end in .af: ${path}`, `example: ${BIN} doc open ~/Desktop/work.af`);
  }
  // doc info and doc note share this and only read the manifest offline; the
  // hidden check applies to them too, since Affinity can never have saved a
  // .af inside a hidden folder.
  requireVisible(path, "path");
  return path;
}

function describeFreshness(state: Freshness, savedAt: string | undefined): string {
  if (state === "stale") return `stale (changed outside affinity-axi after ${savedAt ?? "the last save"})`;
  return state;
}

function madeByLine(m: Manifest | null): string | null {
  if (!m?.madeBy) return null;
  const parts = [m.madeBy.script];
  const args = m.madeBy.args;
  const empty = args === null || args === undefined || (typeof args === "object" && Object.keys(args as object).length === 0);
  if (!empty) {
    const json = JSON.stringify(args);
    parts.push(`--args '${json.length > MAX_ARGS ? json.slice(0, MAX_ARGS) + "..." : json}'`);
  }
  for (const f of m.madeBy.flags) parts.push(f.startsWith("-") ? f : `--${f}`);
  return parts.join(" ");
}

/**
 * `brand: <name> (<path>)`, with " (changed)" when the kit file now differs. The recorded path is
 * relative to the manifest's folder; older manifests recorded it relative to the run's cwd, so
 * the process cwd is the fallback. Best effort: a missing kit prints no suffix.
 */
function brandLine(m: Manifest | null, manifestDir: string): string | null {
  const b = m?.madeBy?.brand;
  if (!b) return null;
  let changed = "";
  try {
    const file = [resolve(manifestDir, b.path), resolve(b.path)].find((f) => existsSync(f));
    if (file && sha256File(file) !== b.sha256) changed = " (changed)";
  } catch {
    // unreadable kit: report the recorded name only
  }
  return `brand: ${b.name} (${b.path})${changed}`;
}

function namedLine(inv: Inventory | null): string | null {
  if (!inv) return null;
  const names = [...new Set(inv.nodes.map((n) => n.name).filter((n) => n !== ""))];
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return `named[${names.length}]: ${shown}${names.length > MAX_NAMES ? ", ..." : ""}`;
}

/** The lines shared by `doc open` and `doc info`. */
function summaryLines(m: Manifest | null, state: Freshness, savedAt: string | undefined, inv: Inventory | null, manifestDir: string): string[] {
  const lines = [`manifest: ${describeFreshness(state, savedAt)}`];
  const made = madeByLine(m);
  if (made) lines.push(`madeBy: ${made}`);
  const brand = brandLine(m, manifestDir);
  if (brand) lines.push(brand);
  const named = namedLine(inv);
  if (named) lines.push(named);
  return lines;
}

function makeOpen(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "doc open",
      summary: "Open a saved .af (reuses it if already open), refresh its inventory, say whether the manifest can be trusted",
      args: [PATH_ARG],
      flags: [URL_FLAG],
      examples: ["affinity-axi doc open ~/Desktop/promo.af", "affinity-axi doc open examples/promo-post/promo.af"],
    },
    async run(parsed: Parsed): Promise<number> {
      const path = afPath(parsed.positionals[0]!);
      if (!existsSync(path)) throw new UsageError(`no such file: ${path}`, `run '${BIN} assets' to list saved assets under this directory`);

      const client = await connect({ url: urlFlag(parsed) });
      let opened: { status: string; uuid?: string; title?: string; dirty?: boolean; message?: string };
      let inventory: Inventory | null = null;
      try {
        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, path, "path", "open");
        opened = await runDocScript(client, DOC_OPEN(path), "opening the document");
        if ((opened.status !== "opened" && opened.status !== "already-open") || !opened.uuid) {
          throw new AxiError(`could not open ${path}: ${opened.message ?? "unknown failure"}`, "check Affinity for an open dialog and answer it by hand; do not re-run blindly");
        }
        inventory = await fetchInventory(client, opened.uuid);
      } finally {
        client.close();
      }

      const uuid = opened.uuid!;
      const uuid8 = uuid.slice(0, 8);
      const fresh = freshness(path);
      const manifest = readManifest(path);
      if (manifest) {
        // af.sha256 stays untouched: only a save binds the manifest to the file.
        manifest.history.push({ time: new Date().toISOString(), kind: "open" });
        if (inventory) manifest.inventory = inventory;
        writeManifest(path, manifest);
      }

      const pairs: Array<[string, unknown]> = [
        ["doc", uuid],
        ["path", path],
        ["status", opened.status],
      ];
      if (opened.dirty) pairs.push(["dirty", true]);
      const made = manifest?.madeBy;
      print(
        [
          emitKV(pairs),
          ...summaryLines(manifest, fresh.state, fresh.savedAt, inventory ?? manifest?.inventory ?? null, dirname(path)),
          helpBlock([
            `${BIN} inspect ${uuid8} --named`,
            made ? `${BIN} run ${made.script} --args '{...,"uuid":"${uuid8}"}'` : `${BIN} run <script.js> --args '{"uuid":"${uuid8}"}'`,
            `${BIN} doc save ${uuid8} ${path}`,
          ]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

function makeInfo(): CommandModule {
  return {
    spec: {
      name: "doc info",
      summary: "Offline: what the manifest says about a saved .af and whether it can be trusted",
      args: [PATH_ARG],
      flags: [],
      examples: ["affinity-axi doc info ~/Desktop/promo.af"],
    },
    run(parsed: Parsed): number {
      const path = afPath(parsed.positionals[0]!);
      const manifest = readManifest(path);
      if (!manifest && !existsSync(path)) throw new UsageError(`no such file: ${path}`, `run '${BIN} assets' to list saved assets under this directory`);
      const fresh = freshness(path);
      const lines = [`path: ${path}`, ...summaryLines(manifest, fresh.state, fresh.savedAt, manifest?.inventory ?? null, dirname(path))];
      if (manifest) {
        lines.push(`history: ${manifest.history.length}`, `exports: ${manifest.exports.length}`, `notes: ${manifest.notes.length}`);
        const last = manifest.notes[manifest.notes.length - 1];
        if (last) lines.push(`lastNote: ${last.text}`);
      }
      const help = [`${BIN} doc open ${path}`];
      if (fresh.state === "stale") help.push(`${BIN} inspect <uuid8> --named   # after doc open: the file, not the manifest, is the truth`);
      if (manifest) help.push(`${BIN} doc note ${path} "<text>"`);
      print([...lines, helpBlock(help)].join("\n"));
      return 0;
    },
  };
}

function makeNote(): CommandModule {
  return {
    spec: {
      name: "doc note",
      summary: "Offline: append a note to a saved .af's manifest (other keys are kept)",
      args: [PATH_ARG, { name: "text", required: true, description: "the note, one line" }],
      flags: [],
      examples: ['affinity-axi doc note ~/Desktop/promo.af "client approved v2"'],
    },
    run(parsed: Parsed): number {
      const path = afPath(parsed.positionals[0]!);
      const text = parsed.positionals.slice(1).join(" ").trim();
      if (text === "") throw new UsageError("the note is empty", `example: ${BIN} doc note ${path} "client approved v2"`);
      const manifest = readManifest(path);
      if (!manifest) {
        throw new AxiError(`no manifest for ${basename(path)}`, `a manifest is written by '${BIN} doc save'; save the document first`);
      }
      manifest.notes.push({ time: new Date().toISOString(), text });
      writeManifest(path, manifest);
      print([emitKV([["noted", path], ["notes", manifest.notes.length]]), helpBlock([`${BIN} doc info ${path}`])].join("\n"));
      return 0;
    },
  };
}

export function make(connect: ConnectFn): Record<"doc open" | "doc info" | "doc note", CommandModule> {
  return { "doc open": makeOpen(connect), "doc info": makeInfo(), "doc note": makeNote() };
}
