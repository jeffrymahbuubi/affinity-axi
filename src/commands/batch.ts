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

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "../cli/router.js";
import { positiveFlag, type Parsed } from "../cli/args.js";
import { BRAND_FLAG, injectBrand, loadBrand, resolveBrandRef } from "../affinity/brand.js";
import { refusalMessage, refusalSuggestion, scanForAi, scanForBlocking } from "../affinity/guard.js";
import { withHelpers } from "../affinity/helpers.js";
import { creditFor, metadataNote } from "../affinity/metadata.js";
import { recordSave } from "../affinity/manifest.js";
import { checkOverwrite, FORCE_FLAG } from "../affinity/overwrite.js";
import { requireUnderDesktop, requireVisible, shown, userPath } from "../affinity/paths.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, injectArgs } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, listHeader, listRow, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { DOC_CLOSE, DOC_SAVE } from "./doc.js";
import { callJson, listDocs, logRun, replayFlags, runDocuments } from "./run.js";
import { BATCH_RESERVED, deriveKeys, keyRenames, loadRecords, reservedFields, type DataRecord } from "./batch-data.js";
import { FatalRecord } from "./fill-parts.js";
import { checkExportTarget, exportTo, reportedUuid, requirePreset } from "./finish.js";
import { recordExports, type ExportCtx } from "./fill-export.js";
import { extFor } from "../affinity/fill-script.js";
import {
  cleanOutDir, discardOrFatal, exportPath, filesExist, handleStrays, joinNotes, leftoverNote, logGenerative, oneLine, ownIfNew, ROW_FIELDS, strayDocs,
  type Cleaned, type Ctx, type Row,
} from "./batch-parts.js";

// Re-exported for the tests that import them from here.
export { joinNotes, leftOpenNote, strayDocs } from "./batch-parts.js";

const BIN = "affinity-axi";
const DEFAULT_TIMEOUT_MS = 60000;

/** The document UUID a template reported: a `{"uuid":...}` line first, else the first UUID in the output. */
export const findDocUuid = reportedUuid;

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
  if (!uuid && (c.hits.length > 0 || (needsDoc(c) && outcome.kind === "ok"))) {
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
    notes.push(...(await handleStrays(c, strays)));
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

  if (!needsDoc(c)) {
    if (outcome.kind === "ok") ownIfNew(c, uuid);
    return row("ok", uuid, joinNotes(notes));
  }
  if (!uuid) {
    const todo = c.saveDir !== undefined ? "saved or closed" : "exported or discarded";
    return row("failed", undefined, joinNotes([`no document UUID in the output, so it cannot be ${todo}; log JSON.stringify({uuid: String(doc.sessionUuid)})`, ...notes]));
  }
  const left = (r: Row): Row => {
    c.leftOpen.push(uuid!);
    ownIfNew(c, uuid);
    return r;
  };
  let afPath: string | undefined;
  if (c.saveDir !== undefined) {
    const path = join(c.saveDir, `${key}.af`);
    // A hand-edited or never-saved target is not overwritten without --force; this record fails, the batch goes on (--continue-on-error).
    const verdict = checkOverwrite(path, { force: c.force, cmd: `${BIN} batch <template> --data <file> --save-dir <dir>` });
    if (!verdict.ok) {
      // The note stays short; the --force line and the full path go in the help block, once per run.
      c.refused.push({ key, path });
      return left(row("failed", uuid, joinNotes([`${verdict.message} (--force to replace); left open`, ...notes])));
    }
    const saved = await docScript<{ status: string; dirty?: boolean }>(c, DOC_SAVE(uuid, path), "saving the document");
    if (saved.status === "missing") return row("failed", uuid, joinNotes(["document not found to save (the template may have closed it)", ...notes]));
    if (saved.dirty === true) return left(row("failed", uuid, joinNotes([`still dirty after save; left open (${shown(path)})`, ...notes])));
    if (!existsSync(path)) return left(row("failed", uuid, joinNotes([`save reported success but ${shown(path)} was not written; left open`, ...notes])));
    try {
      // The same writer as `doc save`: hash, folded history, madeBy. A null inventory skips the extra script.
      recordSave(path, uuid, null, process.cwd(), { forced: verdict.forced });
    } catch (err) {
      notes.push(`manifest NOT WRITTEN (${err instanceof Error ? err.message : String(err)})`);
    }
    afPath = path;
  }
  if (c.exportTo !== undefined) {
    const path = exportPath(c, key);
    try {
      const done = await exportTo(c.client, uuid, { preset: c.exportTo.preset, path, timeoutMs: c.timeoutMs, ...(c.exportTo.width !== undefined ? { width: c.exportTo.width } : {}), ...(c.brand ? { brand: c.brand } : {}) });
      c.exported++;
      c.cleaned.seen.set(path, statSync(path).mtimeMs);
      notes.push(done.note);
      if (done.metaNote !== null) notes.push(`metadata: ${done.metaNote}`);
      if (afPath !== undefined) recordExports(exportCtx(c), afPath, [done.entry]);
    } catch (err) {
      if (!(err instanceof AxiError)) throw err;
      const where = afPath !== undefined ? `saved ${shown(afPath)}; ` : "";
      return left(row("failed", uuid, joinNotes([`${where}export failed: ${err.message}; left open`, ...notes])));
    }
  }
  if (c.discard) {
    if (c.preexisting.has(uuid.toUpperCase())) return row("failed", uuid, joinNotes(["the record's document was open before the batch started; not discarded", ...notes]));
    const res = await discardOrFatal(c, uuid);
    if (res.status === "failed") return left(row("failed", uuid, joinNotes([res.message, ...notes])));
    if (res.status === "missing") notes.push("document already gone");
    else {
      c.discarded++;
      notes.push("discarded");
      if (res.status === "discarded" && res.leftover) notes.push(leftoverNote(res.leftover));
    }
    return row("ok", uuid, joinNotes(notes));
  }
  if (afPath === undefined) {
    ownIfNew(c, uuid);
    return row("ok", uuid, joinNotes(notes));
  }
  const closed = await docScript<{ status: string }>(c, DOC_CLOSE(uuid), "closing the document");
  if (closed.status === "still-open") throw new FatalRecord(`document ${uuid} is still open after close; check Affinity for a dialog`);
  if (closed.status !== "closed") {
    ownIfNew(c, uuid);
    return row("failed", uuid, joinNotes([`saved ${shown(afPath)} but not closed (${closed.status})`, ...notes]));
  }
  notes.unshift(`saved ${shown(afPath)}, closed`);
  return row("ok", uuid, joinNotes(notes));
}

/** True when an ok record's document is saved, exported or discarded, so its uuid must be known. */
const needsDoc = (c: Ctx): boolean => c.saveDir !== undefined || c.exportTo !== undefined || c.discard;

const exportCtx = (c: Ctx): ExportCtx => ({ client: c.client, outDir: c.outDir ?? "", timeoutMs: c.timeoutMs, preset: c.exportTo?.preset, ext: c.exportTo?.ext, allBoards: false, brand: c.brand, budget: undefined });

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
        { name: "export", type: "string", description: "after each ok record, export its document with this preset as <out-dir>/<key>.<ext> (needs --out-dir; see: affinity-axi presets)" },
        { name: "width", type: "string", description: "with --export: output width in px (height follows)" },
        { name: "discard", type: "boolean", description: "after each ok record, close its document without keeping it (after --export, if given); after a failed record, drop the unsaved documents that record created; not with --save-dir" },
        { name: "on-exists", type: "string", values: ["error", "skip", "overwrite"], description: "when a record's files exist: error (default: a .af affinity-axi did not save, or that was edited since, fails the record), skip (do not run the record when its .af and export exist), overwrite (same as --force)" },
        { name: "limit", type: "string", description: "process only the first N records" },
        FORCE_FLAG,
        { name: "continue-on-error", type: "boolean", description: "keep going after a failed record (default: stop at the first failure)" },
        { name: "timeout", type: "string", default: String(DEFAULT_TIMEOUT_MS), description: "per-record script timeout in milliseconds" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi batch post.js --data posts.json --key slug --with-helpers --out-dir ~/Desktop/out --save-dir ~/Desktop/af",
        "affinity-axi batch post.js --data posts.json --key slug --with-helpers --export PNG --out-dir ~/Desktop/out --discard",
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
        throw new UsageError(`cannot read template file '${shown(file)}'`, `usage: ${BIN} batch <template.js> --data <file.json|file.csv>`);
      }
      const hits = scanForAi(source);
      if (hits.length > 0 && parsed.flags["allow-generative"] !== true) {
        throw new AxiError(refusalMessage(hits[0]!), refusalSuggestion(`${BIN} batch ${shown(file)} --data ${shown(dataFile)} --allow-generative`));
      }
      const blocking = scanForBlocking(source);
      if (blocking.length > 0 && !parsed.flags["allow-blocking"]) {
        const hit = blocking[0]!;
        throw new AxiError(
          `template calls ${hit.identifier} at line ${hit.line}, which can open a modal prompt and hang Affinity`,
          `let batch close documents safely instead: --save-dir <dir under Desktop> saves each document, then closes it`,
        );
      }

      const exportPreset = typeof parsed.flags["export"] === "string" ? parsed.flags["export"] : undefined;
      const discard = parsed.flags["discard"] === true;
      const onExistsFlag = typeof parsed.flags["on-exists"] === "string" ? parsed.flags["on-exists"] : undefined;
      const e = `e.g. ${BIN} batch ${shown(file)} --data ${shown(dataFile)}`;
      if (exportPreset !== undefined && typeof parsed.flags["out-dir"] !== "string") throw new UsageError("--export needs --out-dir <dir under Desktop>", `${e} --export PNG --out-dir ~/Desktop/out`);
      if (parsed.flags["width"] !== undefined && exportPreset === undefined) throw new UsageError("--width needs --export <preset>", `${e} --export PNG --out-dir ~/Desktop/out --width 1080`);
      if (discard && typeof parsed.flags["save-dir"] === "string") throw new UsageError("--discard and --save-dir cannot be combined", "--save-dir keeps each document, --discard drops it");
      if (onExistsFlag !== undefined && typeof parsed.flags["save-dir"] !== "string" && exportPreset === undefined) {
        throw new UsageError("--on-exists needs --save-dir or --export", `${e} --save-dir ~/Desktop/af --on-exists skip`);
      }
      if (parsed.flags["force"] === true && (onExistsFlag === "error" || onExistsFlag === "skip")) throw new UsageError("--force means --on-exists overwrite", "drop --force, or use --on-exists overwrite");
      if (exportPreset !== undefined && parsed.flags["allow-generative"] === true) {
        throw new UsageError("--export cannot label AI-generated files", `drop --export and run '${BIN} export <doc> <preset> <path>' after the batch: it writes the AI label and sidecar`);
      }
      const width = positiveFlag(parsed, "width", { integer: true, example: "512" });
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
            emitList("batch", [], ROW_FIELDS),
            `summary: ok=0 failed=0 skipped=0 ms=0 (no records in ${shown(dataFile)}; nothing was run)`,
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
      const exportExt = exportPreset === undefined ? undefined : extFor(exportPreset);
      if (exportPreset !== undefined) checkExportTarget(exportPreset, join(outDir!, `x.${exportExt ?? "png"}`), width);

      const client = await connect({ url });
      const rows: Row[] = [];
      const refused: Ctx["refused"] = [];
      const cleaned: Cleaned = { n: 0, seen: new Map() };
      const leftOpen: string[] = [];
      const leftClean = new Set<string>();
      let counts: Pick<Ctx, "exported" | "discarded"> = { exported: 0, discarded: 0 };
      try {
        let desktop: string | undefined;
        if (outDir !== undefined || saveDir !== undefined || discard) {
          const app = await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info");
          for (const [flag, dir] of [["out-dir", outDir], ["save-dir", saveDir]] as const) {
            if (dir !== undefined) requireUnderDesktop(app.desktop, dir, `--${flag}`, "write-folder");
          }
          desktop = app.desktop;
          if (outDir !== undefined) mkdirSync(outDir, { recursive: true });
          if (saveDir !== undefined) mkdirSync(saveDir, { recursive: true });
        }
        if (exportPreset !== undefined) await requirePreset(client, exportPreset);
        // Every document open now is not this batch's to report; a null listing leaves the set empty.
        const start = await listDocs(client);
        const known = new Set((start?.documents ?? []).map((d) => d.uuid.toUpperCase()));
        const force = parsed.flags["force"] === true || onExistsFlag === "overwrite";
        const ctx: Ctx = {
          client, flags: [...replayFlags(parsed), ...(force ? ["--force"] : [])], force, source, hits, file, helpers: parsed.flags["with-helpers"] === true, timeoutMs, outDir, saveDir, brand, refused, credit, cleaned, known, leftOpen, leftClean,
          preexisting: new Set(known), desktop, discard, skipExisting: onExistsFlag === "skip", exported: 0, discarded: 0,
          exportTo: exportPreset === undefined ? undefined : { preset: exportPreset, ext: exportExt!, width },
        };
        counts = ctx;
        const keepGoing = parsed.flags["continue-on-error"] === true;
        let stopped: string | undefined;
        // The table streams: the header now, each row as its record finishes (skipped rows too).
        print(listHeader("batch", records.length, ROW_FIELDS));
        const push = (row: Row): void => {
          rows.push(row);
          print(listRow(row as unknown as Record<string, unknown>, ROW_FIELDS));
        };
        for (let i = 0; i < records.length; i++) {
          const key = keys[i]!;
          if (stopped !== undefined) {
            push({ key, status: "skipped", doc: "", ms: 0, note: stopped });
            continue;
          }
          if (filesExist(ctx, key)) {
            push({ key, status: "skipped", doc: "", ms: 0, note: "exists: kept (--on-exists skip)" });
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
          push(r);
          if (r.status === "failed" && stopped === undefined && !keepGoing) stopped = `not run: stopped after failure at '${key}'`;
        }
      } finally {
        client.close();
      }

      const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length;
      const failed = count("failed");
      const out = [
        `summary: ok=${count("ok")} failed=${failed} skipped=${count("skipped")} ms=${Date.now() - started}` +
          (limit !== undefined && all.length > records.length ? ` (limited to ${records.length} of ${all.length} records)` : ""),
      ];
      if (outDir !== undefined) out.push(`cleaned: ${cleaned.n}`);
      if (exportPreset !== undefined) out.push(`exported: ${counts.exported}`);
      if (discard) out.push(`discarded: ${counts.discarded}`);
      const open = [...new Set(leftOpen)];
      if (open.length > 0) out.push(`leftOpen: ${open.join(" ")}`);
      const reserved = reservedFields(records);
      if (reserved.length > 0) {
        const many = reserved.length > 1;
        out.push(`warning: record field${many ? "s" : ""} ${reserved.join(", ")} ${many ? "are" : "is"} replaced in ARGS by the batch values (${BATCH_RESERVED.join(", ")}); rename ${many ? "them" : "it"} in the data file`);
      }
      const renamed = keyRenames(records, keyField, keys);
      if (renamed.length > 0) out.push(emitList("renamed", renamed.slice(0, 10), ["value", "key"], { total: renamed.length }));
      const helps: string[] = [];
      if (rows.some((r) => r.status === "skipped" && r.note.startsWith("not run:"))) helps.push(`${BIN} batch ${shown(file)} --data ${shown(dataFile)} --continue-on-error   # process the records after a failure`);
      const firstDoc = rows.find((r) => r.status === "ok" && r.doc);
      // --discard closes every ok record's document, so like --save-dir nothing stays open to render or save.
      if (firstDoc && saveDir === undefined && !discard) helps.push(`${BIN} render ${firstDoc.doc}`, `${BIN} doc save ${firstDoc.doc} <path-under-Desktop>.af   # documents stay open; use --save-dir to save and close them`);
      if (firstDoc && (saveDir !== undefined || discard)) helps.push(`${BIN}   # home view: confirm no documents are left open`);
      for (const uuid of open.slice(0, 3)) {
        const id = uuid.slice(0, 8).toUpperCase();
        if (leftClean.has(uuid)) helps.push(`${BIN} doc close ${id}   # left open by a failed record; it has no unsaved changes`);
        else helps.push(`${BIN} doc save ${id} <path-under-Desktop>.af   # left open with unsaved changes`, `${BIN} doc close ${id}   # after the save, or close it in Affinity with Don't Save`);
      }
      if (open.length > 3) helps.push(`${BIN}   # home view: lists the other ${open.length - 3} left-open documents`);
      if (open.length > 0) helps.push(`${BIN} doc close --mine --discard   # or drop every unsaved document affinity-axi created from this folder`);
      if (refused.length > 0) {
        const names = refused.slice(0, 5).map((r) => `${r.key}.af`).join(", ") + (refused.length > 5 ? ", ..." : "");
        helps.push(
          `${BIN} batch ${shown(file)} --data ${shown(dataFile)}${keyField ? ` --key ${keyField}` : ""} --save-dir ${shown(String(rawSave))} --force   # replace the ${refused.length} refused .af: ${names}`,
          `${BIN} doc open ${shown(refused[0]!.path)}   # work on the existing file instead`,
        );
      }
      if (helps.length > 0) out.push(helpBlock(helps));
      print(out.join("\n"));
      return failed > 0 ? 1 : 0;
    },
  };
}
