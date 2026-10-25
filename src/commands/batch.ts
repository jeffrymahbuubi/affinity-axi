// `batch <template.js> --data <file>`: run one template once per data record
// over a single connection.
//
// Pipeline: read + guard-scan the template once, load and validate the data,
// connect once, then per record: inject ARGS, append helpers, execute,
// classify, provenance (generative), and optionally save + close the document.
// A document is closed only after saveAs succeeded and the .af exists, and
// DOC_CLOSE re-checks isDirty inside Affinity before calling close().
//
// Left-open documents: one listing at the start seeds `known` (every open
// document). After a failed record the listing is diffed against it, and each
// new document (plus the reported one when dirty) is named in the row note and
// in a `leftOpen:` line after the summary. Row notes join with "; ".

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "../cli/router.js";
import { positiveFlag, type Parsed } from "../cli/args.js";
import { BRAND_FLAG, injectBrand, loadBrand, resolveBrandRef, type BrandKit } from "../affinity/brand.js";
import { refusalMessage, refusalSuggestion, scanForAi, scanForBlocking } from "../affinity/guard.js";
import { withHelpers } from "../affinity/helpers.js";
import { creditFor, finalizeFile, metadataNote, type Credit, type MetaOutcome } from "../affinity/metadata.js";
import { appendProvenance, extractUuids, sha256 } from "../affinity/provenance.js";
import { recordSave } from "../affinity/manifest.js";
import { checkOverwrite, FORCE_FLAG } from "../affinity/overwrite.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import type { BrandRef } from "../affinity/manifest-types.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, injectArgs } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { AffinityClient, AiHit, ConnectFn } from "../mcp/types.js";
import { DOC_CLOSE, DOC_SAVE } from "./doc.js";
import { callJson, listDocs, logRun, replayFlags, runDocuments, type DocListing } from "./run.js";
import { BATCH_RESERVED, deriveKeys, loadRecords, reservedFields, type DataRecord } from "./batch-data.js";

const BIN = "affinity-axi";
const DEFAULT_TIMEOUT_MS = 60000;
const NOTE_LIMIT = 200;
const UUID_RE = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/;

interface Row {
  key: string;
  status: "ok" | "failed" | "skipped";
  doc: string;
  ms: number;
  note: string;
}

/** Thrown for a failure that makes continuing unsafe (transport error, timeout, stuck close). */
class FatalRecord extends Error {}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > NOTE_LIMIT ? t.slice(0, NOTE_LIMIT - 3) + "..." : t;
}

/** Joins row note parts with "; ", dropping empty ones. */
export function joinNotes(parts: string[]): string {
  return parts.filter((p) => p !== "").join("; ");
}

/** Documents a failed record left behind: not in `known` (upper-cased UUIDs), plus `reported` when it is listed and dirty. */
export function strayDocs(known: ReadonlySet<string>, listing: DocListing | null, reported?: string): DocListing["documents"] {
  if (!listing) return [];
  const rep = reported?.toUpperCase();
  return listing.documents.filter((d) => {
    const id = d.uuid.toUpperCase();
    return !known.has(id) || (rep !== undefined && id === rep && d.dirty);
  });
}

/** `left open: 6681ED67 (unsaved)` | `(unsaved changes in welcome.af)` | `(welcome.af)`. */
export function leftOpenNote(d: { uuid: string; path: string; dirty: boolean }): string {
  const name = d.path === "" ? "" : (d.path.split(/[\\/]/).pop() ?? d.path);
  const what = name === "" ? "unsaved" : d.dirty ? `unsaved changes in ${name}` : name;
  return `left open: ${d.uuid.slice(0, 8).toUpperCase()} (${what})`;
}

/** The document UUID a template reported: a `{"uuid":...}` line first, else the first UUID in the output. */
export function findDocUuid(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof v === "string" && UUID_RE.test(v)) return v.toUpperCase();
    } catch {
      // not JSON
    }
  }
  return UUID_RE.exec(text)?.[0].toUpperCase();
}

interface Ctx {
  flags: string[]; // replayable flags, for the run log
  force: boolean;
  client: AffinityClient;
  source: string; // the template as read (guard-scanned once)
  hits: AiHit[];
  file: string;
  helpers: boolean;
  timeoutMs: number;
  outDir: string | undefined;
  saveDir: string | undefined;
  brand: { kit: BrandKit; ref: BrandRef } | undefined;
  refused: Array<{ key: string; path: string }>; // targets checkOverwrite refused, for the help block
  credit: Credit | undefined; // the kit's credit, embedded into the rasters a template wrote to --out-dir
  cleaned: Cleaned;
  known: Set<string>; // upper-cased UUIDs of documents already open or already accounted for
  leftOpen: string[]; // UUIDs of documents a failed record left open, for the leftOpen: line
}

/** Raster files in --out-dir finalized so far, and the mtime each had afterwards (a file is not redone until it changes). */
interface Cleaned {
  n: number;
  seen: Map<string, number>;
}

const RASTER_EXT = /\.(png|jpe?g|webp)$/i;

/** Finalizes the rasters at the top level of `dir` written since `since` (ms) and not yet finalized; returns the outcomes. */
function cleanOutDir(dir: string, since: number, credit: Credit | undefined, seen: Map<string, number>): MetaOutcome[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || !RASTER_EXT.test(name) || st.mtimeMs < since - 1000 || seen.get(file) === st.mtimeMs) return [];
      const o = finalizeFile(file, credit ? { credit } : {});
      seen.set(file, statSync(file).mtimeMs);
      return [o];
    } catch {
      return [];
    }
  });
}

/** Provenance for one generative record, with that record's args. */
function logGenerative(c: Ctx, args: unknown, outcome: string, text: string, current: string | undefined): string | undefined {
  const documents = extractUuids(text);
  if (current && !documents.includes(current)) documents.push(current);
  try {
    appendProvenance({ time: new Date().toISOString(), script: c.file, sha256: sha256(c.source), identifiers: c.hits, args, outcome, documents });
    return undefined;
  } catch (err) {
    return `provenance NOT LOGGED (${err instanceof Error ? err.message : String(err)}); record this run by hand`;
  }
}

/** Runs a doc-* script; any non-ok outcome or unreadable output is a fatal error (state is unknown). */
async function docScript<T>(c: Ctx, script: string, what: string): Promise<T> {
  try {
    return await callJson<T>(c.client, script, what);
  } catch (err) {
    throw new FatalRecord(err instanceof Error ? err.message : String(err));
  }
}

async function runOne(c: Ctx, rec: DataRecord, key: string, index: number): Promise<Row> {
  const started = Date.now();
  const row = (status: Row["status"], doc: string | undefined, note: string): Row => ({
    key,
    status,
    doc: doc ? doc.slice(0, 8) : "",
    ms: Date.now() - started,
    note: oneLine(note),
  });

  const outBase = c.outDir === undefined ? undefined : join(c.outDir, key);
  const args = { ...rec, key, index, outDir: c.outDir, outBase };
  let script = injectArgs(c.source, JSON.stringify(args));
  if (c.brand) script = injectBrand(script, c.brand.kit);
  if (c.helpers) script = withHelpers(script);

  // One run-log line per data record; args is the record itself (not the injected extras).
  const logRecord = (kind: string, text: string, listing: Awaited<ReturnType<typeof listDocs>>): void =>
    logRun({
      cmd: "batch",
      script: c.file,
      source: c.source,
      args: rec,
      flags: c.flags,
      outcome: kind,
      ms: Date.now() - started,
      documents: runDocuments(text, listing),
      ...(c.brand ? { brand: c.brand.ref } : {}),
    });

  let result;
  try {
    result = await c.client.callTool("execute_script", { script }, { timeoutMs: c.timeoutMs });
  } catch (err) {
    // The call may have reached Canva AI before failing: log it anyway.
    if (c.hits.length > 0) logGenerative(c, args, "error", "", undefined);
    logRecord("error", "", null);
    throw new FatalRecord(`call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const outcome = classify(result);
  const text = resultText(result);

  let uuid = findDocUuid(text);
  let current: string | undefined;
  // The listing also gives saved paths for the run log, so it is read whenever the output names no document.
  const listing = uuid ? null : await listDocs(c.client);
  if (!uuid && (c.hits.length > 0 || (c.saveDir !== undefined && outcome.kind === "ok"))) {
    current = listing?.current?.toUpperCase();
    uuid = current;
  }
  logRecord(outcome.kind, text, listing);
  const notes: string[] = [];
  if (outcome.kind === "ok") {
    if (uuid) c.known.add(uuid.toUpperCase());
    for (const d of listing?.documents ?? []) c.known.add(d.uuid.toUpperCase());
  }
  if (c.outDir !== undefined) {
    const done = cleanOutDir(c.outDir, started, c.credit, c.cleaned.seen);
    c.cleaned.n += done.filter((o) => o.kind !== null && o.error === undefined).length;
    const meta = metadataNote(done);
    if (meta !== null) notes.push(`metadata: ${meta}`);
  }
  if (c.hits.length > 0) {
    const n = logGenerative(c, args, outcome.kind, text, current);
    if (n) notes.push(n);
  }

  if (outcome.kind !== "ok") {
    // A failed record may have left a document open: diff the listing against what was open before.
    const strays = strayDocs(c.known, listing ?? (await listDocs(c.client)), uuid);
    for (const d of strays) {
      c.known.add(d.uuid.toUpperCase());
      c.leftOpen.push(d.uuid);
      notes.push(leftOpenNote(d));
    }
    if (!uuid && strays.length === 1) uuid = strays[0]!.uuid;
  }

  if (outcome.kind === "exception") {
    return row("failed", uuid, joinNotes([[outcome.error, outcome.at ? `at ${outcome.at}` : ""].filter(Boolean).join(" "), ...notes]));
  }
  if (outcome.kind === "sdk-error") {
    return row("failed", uuid, joinNotes([text.split("\n").find((l) => l.trim() !== "") ?? "sdk error", ...notes]));
  }
  if (outcome.kind === "not-allowed") {
    const why = c.hits.length > 0 ? "enable Affinity > Settings > Use Canva AI Studio features" : "enable the matching permission in Affinity > Settings";
    return row("failed", uuid, joinNotes([`not allowed: ${why}`, ...notes]));
  }

  if (c.saveDir !== undefined) {
    if (!uuid) return row("failed", undefined, joinNotes(["no document UUID in the output, so it cannot be saved or closed; log JSON.stringify({uuid: String(doc.sessionUuid)})", ...notes]));
    const path = join(c.saveDir, `${key}.af`);
    // A hand-edited or never-saved target is not overwritten without --force; this record fails, the batch goes on (--continue-on-error).
    const verdict = checkOverwrite(path, { force: c.force, cmd: `${BIN} batch <template> --data <file> --save-dir <dir>` });
    if (!verdict.ok) {
      // The note stays short; the --force line and the full path go in the help block, once per run.
      c.refused.push({ key, path });
      c.leftOpen.push(uuid);
      return row("failed", uuid, joinNotes([`${verdict.message} (--force to replace); left open`, ...notes]));
    }
    const saved = await docScript<{ status: string; dirty?: boolean }>(c, DOC_SAVE(uuid, path), "saving the document");
    if (saved.status === "missing") return row("failed", uuid, joinNotes(["document not found to save (the template may have closed it)", ...notes]));
    if (saved.dirty === true) {
      c.leftOpen.push(uuid);
      return row("failed", uuid, joinNotes([`still dirty after save; left open (${path})`, ...notes]));
    }
    if (!existsSync(path)) {
      c.leftOpen.push(uuid);
      return row("failed", uuid, joinNotes([`save reported success but ${path} was not written; left open`, ...notes]));
    }
    try {
      // The same writer as `doc save`: hash, folded history, madeBy. A null inventory skips the extra script.
      recordSave(path, uuid, null, process.cwd(), { forced: verdict.forced });
    } catch (err) {
      notes.push(`manifest NOT WRITTEN (${err instanceof Error ? err.message : String(err)})`);
    }
    const closed = await docScript<{ status: string }>(c, DOC_CLOSE(uuid), "closing the document");
    if (closed.status === "still-open") throw new FatalRecord(`document ${uuid} is still open after close; check Affinity for a dialog`);
    if (closed.status !== "closed") return row("failed", uuid, joinNotes([`saved ${path} but not closed (${closed.status})`, ...notes]));
    notes.unshift(`saved ${path}, closed`);
  }
  return row("ok", uuid, joinNotes(notes));
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "batch",
      summary: "Run a template script once per data record (JSON or CSV) over one connection",
      args: [{ name: "template", required: true, description: "path to the .js template; it reads ARGS (the record plus key, index, outDir, outBase)" }],
      flags: [
        { name: "data", type: "string", description: "records: a .json array of objects, or a .csv with a header row (required)" },
        { name: "key", type: "string", description: "record field that names each record (default: the record index); made filesystem-safe, must be unique" },
        { name: "with-helpers", type: "boolean", description: "append the axi* SDK helpers after the template (see: affinity-axi helpers)" },
        BRAND_FLAG,
        { name: "allow-generative", type: "boolean", description: "allow generative Canva AI APIs in the template (uses AI credits; logs provenance per record)" },
        { name: "allow-blocking", type: "boolean", description: "run even if the template calls close()/closeAsync() or loads /dialog.js" },
        { name: "save-dir", type: "string", description: "folder under Desktop: after each record, save its document as <dir>/<key>.af and close it" },
        { name: "out-dir", type: "string", description: "folder under Desktop passed as ARGS.outDir; ARGS.outBase = <outDir>/<key> (the template exports itself)" },
        { name: "limit", type: "string", description: "process only the first N records" },
        FORCE_FLAG,
        { name: "continue-on-error", type: "boolean", description: "keep going after a failed record (default: stop at the first failure)" },
        { name: "timeout", type: "string", default: String(DEFAULT_TIMEOUT_MS), description: "per-record script timeout in milliseconds" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi batch post.js --data posts.json --key slug --with-helpers --out-dir ~/Desktop/out --save-dir ~/Desktop/af",
        "affinity-axi batch og-card.js --data pages.csv --key slug --limit 3 --continue-on-error",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const file = parsed.positionals[0]!;
      const dataFile = parsed.flags["data"];
      if (typeof dataFile !== "string") throw new UsageError("--data is required", `usage: ${BIN} batch <template.js> --data <file.json|file.csv>`);

      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`cannot read template file '${file}'`, `usage: ${BIN} batch <template.js> --data <file.json|file.csv>`);
      }
      const hits = scanForAi(source);
      if (hits.length > 0 && parsed.flags["allow-generative"] !== true) {
        throw new AxiError(refusalMessage(hits[0]!), refusalSuggestion(`${BIN} batch ${file} --data ${dataFile} --allow-generative`));
      }
      const blocking = scanForBlocking(source);
      if (blocking.length > 0 && !parsed.flags["allow-blocking"]) {
        const hit = blocking[0]!;
        throw new AxiError(
          `template calls ${hit.identifier} at line ${hit.line}, which can open a modal prompt and hang Affinity`,
          `let batch close documents safely instead: --save-dir <dir under Desktop> saves each document, then closes it`,
        );
      }

      const timeoutMs = positiveFlag(parsed, "timeout", { integer: true, fallback: DEFAULT_TIMEOUT_MS, example: "60000" });
      const limit = positiveFlag(parsed, "limit", { integer: true, example: "3" });
      // Validated before any connection; every record gets the same kit and logs it.
      const brandPath = resolveBrandRef(typeof parsed.flags["brand"] === "string" ? parsed.flags["brand"] : undefined, process.env, process.cwd());
      const brand = brandPath ? loadBrand(brandPath) : undefined;
      const credit = creditFor(parsed, brand?.kit);
      const keyField = typeof parsed.flags["key"] === "string" ? parsed.flags["key"] : undefined;

      const all = loadRecords(dataFile);
      const records = limit === undefined ? all : all.slice(0, limit);
      const keys = deriveKeys(records, keyField);
      const url = typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined;
      const started = Date.now();

      if (records.length === 0) {
        print(
          [
            emitList("batch", [], ["key", "status", "doc", "ms", "note"]),
            `summary: ok=0 failed=0 skipped=0 ms=0 (no records in ${dataFile}; nothing was run)`,
          ].join("\n"),
        );
        return 0;
      }

      const rawOut = parsed.flags["out-dir"];
      const rawSave = parsed.flags["save-dir"];
      const outDir = typeof rawOut === "string" ? userPath(rawOut) : undefined;
      const saveDir = typeof rawSave === "string" ? userPath(rawSave) : undefined;
      if (outDir !== undefined) requireVisible(outDir, "--out-dir");
      if (saveDir !== undefined) requireVisible(saveDir, "--save-dir");

      const client = await connect({ url });
      const rows: Row[] = [];
      const refused: Ctx["refused"] = [];
      const cleaned: Cleaned = { n: 0, seen: new Map() };
      const leftOpen: string[] = [];
      try {
        if (outDir !== undefined || saveDir !== undefined) {
          const app = await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info");
          for (const [flag, dir] of [["out-dir", outDir], ["save-dir", saveDir]] as const) {
            if (dir !== undefined) requireUnderDesktop(app.desktop, dir, `--${flag}`, "write-folder");
          }
          if (outDir !== undefined) mkdirSync(outDir, { recursive: true });
          if (saveDir !== undefined) mkdirSync(saveDir, { recursive: true });
        }
        // Every document open now is not this batch's to report; a null listing leaves the set empty.
        const start = await listDocs(client);
        const known = new Set((start?.documents ?? []).map((d) => d.uuid.toUpperCase()));
        const force = parsed.flags["force"] === true;
        const ctx: Ctx = { client, flags: [...replayFlags(parsed), ...(force ? ["--force"] : [])], force, source, hits, file, helpers: parsed.flags["with-helpers"] === true, timeoutMs, outDir, saveDir, brand, refused, credit, cleaned, known, leftOpen };
        const keepGoing = parsed.flags["continue-on-error"] === true;
        let stopped: string | undefined;
        for (let i = 0; i < records.length; i++) {
          const key = keys[i]!;
          if (stopped !== undefined) {
            rows.push({ key, status: "skipped", doc: "", ms: 0, note: stopped });
            continue;
          }
          let r: Row;
          try {
            r = await runOne(ctx, records[i]!, key, i);
          } catch (err) {
            if (!(err instanceof FatalRecord)) throw err;
            r = { key, status: "failed", doc: "", ms: 0, note: oneLine(err.message) };
            stopped = `not run: stopped after a fatal error at '${key}'`;
          }
          rows.push(r);
          if (r.status === "failed" && stopped === undefined && !keepGoing) stopped = `not run: stopped after failure at '${key}'`;
        }
      } finally {
        client.close();
      }

      const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length;
      const failed = count("failed");
      const out = [
        emitList("batch", rows as unknown as Array<Record<string, unknown>>, ["key", "status", "doc", "ms", "note"]),
        `summary: ok=${count("ok")} failed=${failed} skipped=${count("skipped")} ms=${Date.now() - started}` +
          (limit !== undefined && all.length > records.length ? ` (limited to ${records.length} of ${all.length} records)` : ""),
      ];
      if (outDir !== undefined) out.push(`cleaned: ${cleaned.n}`);
      const open = [...new Set(leftOpen)];
      if (open.length > 0) out.push(`leftOpen: ${open.join(" ")}`);
      const reserved = reservedFields(records);
      if (reserved.length > 0) {
        const many = reserved.length > 1;
        out.push(`warning: record field${many ? "s" : ""} ${reserved.join(", ")} ${many ? "are" : "is"} replaced in ARGS by the batch values (${BATCH_RESERVED.join(", ")}); rename ${many ? "them" : "it"} in the data file`);
      }
      const helps: string[] = [];
      if (count("skipped") > 0) helps.push(`${BIN} batch ${file} --data ${dataFile} --continue-on-error   # process the records after a failure`);
      const firstDoc = rows.find((r) => r.status === "ok" && r.doc);
      if (firstDoc && saveDir === undefined) helps.push(`${BIN} render ${firstDoc.doc}`, `${BIN} doc save ${firstDoc.doc} <path-under-Desktop>.af   # documents stay open; use --save-dir to save and close them`);
      if (firstDoc && saveDir !== undefined) helps.push(`${BIN}   # home view: confirm no documents are left open`);
      if (open.length > 0) helps.push(`${BIN} doc save <doc> <path-under-Desktop>.af   # then doc close <doc>; a left-open document has unsaved changes`);
      if (refused.length > 0) {
        const names = refused.slice(0, 5).map((r) => `${r.key}.af`).join(", ") + (refused.length > 5 ? ", ..." : "");
        helps.push(
          `${BIN} batch ${file} --data ${dataFile}${keyField ? ` --key ${keyField}` : ""} --save-dir ${String(rawSave)} --force   # replace the ${refused.length} refused .af: ${names}`,
          `${BIN} doc open ${refused[0]!.path}   # work on the existing file instead`,
        );
      }
      if (helps.length > 0) out.push(helpBlock(helps));
      print(out.join("\n"));
      return failed > 0 ? 1 : 0;
    },
  };
}
