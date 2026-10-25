// `fill <template.af> --data <file>`: fill a hand-tuned .af by element name,
// once per data record, over a single connection.
//
// Slots are elements named `slot:<key>`; other elements are never touched.
// Per record: load the template (never `current`, never a document the user
// already has open), apply the record, saveAs <out-dir>/<key>.af, optionally
// export, then close. A document is closed only after saveAs succeeded and
// DOC_CLOSE re-checks isDirty inside Affinity; a dirty one is left open and
// stops the run. A failed apply that undo could not clean is first saved as a
// template copy under <out-dir>/_failed/ (saveAs is the only way to make it clean),
// then closed through the same gate: the record fails, the run is not fatal.

import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { CommandModule } from "../cli/router.js";
import { positiveFlag, type Parsed } from "../cli/args.js";
import { EXPORT_AREA, LIST_ARTBOARDS, uniqueSafeNames } from "../affinity/export-area.js";
import {
  FILL_APPLY,
  FILL_OPEN,
  extFor,
  imagePaths,
  planEdits,
  problemsOf,
  type ApplyReply,
  type Edit,
} from "../affinity/fill-script.js";
import { withHelpers } from "../affinity/helpers.js";
import { readManifest, recordSave, sha256File, writeManifest } from "../affinity/manifest.js";
import { checkOverwrite, FORCE_FLAG } from "../affinity/overwrite.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { appendRun } from "../affinity/runlog.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, EXPORT, LIST_PRESETS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn } from "../mcp/types.js";
import { DOC_CLOSE, DOC_SAVE } from "./doc.js";
import { callJson } from "./run.js";
import { deriveKeys, loadRecords, type DataRecord } from "./batch-data.js";
import { BRAND_FLAG, injectBrand, loadBrand, resolveBrandRef, type BrandKit } from "../affinity/brand.js";
import type { BrandRef } from "../affinity/manifest-types.js";
import { finalizeFile, metadataNote, type MetaOutcome } from "../affinity/metadata.js";

const BIN = "affinity-axi";
const DEFAULT_TIMEOUT_MS = 60000;
const NOTE_LIMIT = 300;
const USAGE = `usage: ${BIN} fill <template.af> --data <file.json|file.csv> --out-dir <dir under Desktop>`;

interface Row {
  key: string;
  status: "ok" | "failed" | "skipped";
  doc: string;
  ms: number;
  note: string;
}

/** A failure that makes continuing unsafe (transport error, timeout, a document that cannot be closed). */
class FatalRecord extends Error {
  constructor(
    message: string,
    readonly uuid?: string,
  ) {
    super(message);
  }
}

const oneLine = (s: string): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > NOTE_LIMIT ? t.slice(0, NOTE_LIMIT - 3) + "..." : t;
};

interface Ctx {
  client: AffinityClient;
  template: string;
  templateSha: string; // sha256 of the template bytes: the run log and madeBy both carry it
  force: boolean;
  outDir: string;
  ignoreUnknown: boolean;
  timeoutMs: number;
  preset: string | undefined;
  ext: string | undefined;
  allBoards: boolean;
  flags: string[];
  exported: number;
  leftOpen: string[];
  failedCopies: number; // template copies written under <out-dir>/_failed/ so a dirty document could be closed
  brand: { kit: BrandKit; ref: BrandRef } | undefined;
  refused: Array<{ key: string; path: string }>; // targets checkOverwrite refused, for the help block
}

/** Runs a script that must succeed; any failure or unreadable reply is fatal (state is unknown). */
async function step<T>(c: Ctx, script: string, what: string): Promise<T> {
  try {
    return await callJson<T>(c.client, script, what, { timeoutMs: c.timeoutMs });
  } catch (err) {
    throw new FatalRecord(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Closes a document only when clean. `still-open` and `dirty` are fatal: the document stays open.
 * `context` (the reason this record failed) leads the fatal message so the real error is not lost.
 */
async function closeDoc(c: Ctx, uuid: string, context?: string): Promise<"closed" | "missing"> {
  const r = await step<{ status: string }>(c, DOC_CLOSE(uuid), "closing the document");
  if (r.status === "closed") return "closed";
  if (r.status === "missing") return "missing";
  const why = r.status === "dirty" ? "has unsaved changes" : "is still open after close";
  const tail = `document ${uuid} ${why}; left open, check Affinity (do not close it blindly)`;
  throw new FatalRecord(context ? `${context}; ${tail}` : tail, uuid);
}

/** Exports the open document: the whole document, or one file per artboard. Returns the files written. */
async function exportDoc(c: Ctx, uuid: string, key: string): Promise<{ files: string[]; note: string | null }> {
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
  const targets: Array<{ path: string; script: string }> = [];
  if (!c.allBoards) {
    const path = join(c.outDir, `${key}.${c.ext}`);
    targets.push({ path, script: EXPORT(uuid, preset, path) });
  } else {
    const listed = await step<{ artboards: Array<{ index: number; name: string }> }>(c, LIST_ARTBOARDS(uuid, 0), "listing artboards");
    if (listed.artboards.length === 0) throw new AxiError("the template has no artboards on spread 0", "export without --all-artboards");
    const safe = uniqueSafeNames(listed.artboards.map((b) => b.name));
    listed.artboards.forEach((b, i) => {
      const path = join(c.outDir, `${key}-${safe[i]}.${c.ext}`);
      targets.push({ path, script: EXPORT_AREA(uuid, preset, path, { kind: "artboard", spread: 0, index: b.index }, null) });
    });
  }
  const outcomes: MetaOutcome[] = [];
  for (const t of targets) {
    await run(t.script, `export of ${basename(t.path)} failed`);
    if (!existsSync(t.path)) throw new AxiError(`export reported success but ${t.path} was not written`, "check the folder and preset");
    outcomes.push(finalizeFile(t.path, { credit: c.brand?.kit.credit }));
  }
  return { files: targets.map((t) => t.path), note: metadataNote(outcomes) };
}

/** Appends the exports to the saved file's manifest. Best effort: the files already exist. */
function recordExports(c: Ctx, afPath: string, files: string[]): void {
  try {
    const m = readManifest(afPath);
    if (!m) return;
    const time = new Date().toISOString();
    m.exports = [
      ...(m.exports ?? []),
      ...files.map((path) => ({ time, path, preset: c.preset!, area: c.allBoards ? "all-artboards" : "whole", size: "", bytes: statSync(path).size, aiGenerated: false })),
    ];
    writeManifest(afPath, m);
  } catch {
    // the export itself succeeded
  }
}

async function runOne(c: Ctx, rec: DataRecord, key: string, edits: Edit[]): Promise<Row> {
  const started = Date.now();
  const afPath = join(c.outDir, `${key}.af`);
  let uuid: string | undefined;
  const row = (status: Row["status"], note: string): Row => ({ key, status, doc: uuid ? uuid.slice(0, 8) : "", ms: Date.now() - started, note: oneLine(note) });
  const log = (outcome: string, saved: boolean, path?: string): void => {
    if (uuid === undefined) return;
    try {
      appendRun({ time: new Date().toISOString(), cwd: process.cwd(), scriptSha256: c.templateSha, cmd: "fill", script: c.template, args: rec, flags: c.flags, outcome, ms: Date.now() - started, documents: [{ uuid, path: path ?? (saved ? afPath : "") }], ...(c.brand ? { brand: c.brand.ref } : {}) });
    } catch {
      // unwritable log directory: the run itself already happened
    }
  };

  // A hand-edited or never-saved target is not overwritten without --force; checked before anything is loaded.
  const verdict = checkOverwrite(afPath, { force: c.force, cmd: `${BIN} fill <template.af> --data <file> --out-dir <dir>` });
  if (!verdict.ok) {
    // The note stays short; the --force line and the full path go in the help block, once per run.
    c.refused.push({ key, path: afPath });
    return row("failed", `${verdict.message} (--force to replace)`);
  }

  const opened = await step<{ status: string; uuid?: string }>(c, FILL_OPEN(c.template), "opening the template");
  uuid = opened.uuid?.toUpperCase();
  if (opened.status === "already-open") {
    return row("failed", "the template is already open in Affinity; close it in Affinity, or doc save and doc close it first (fill never reloads an open document)");
  }
  if (opened.status !== "loaded" || !uuid) throw new FatalRecord(`opening the template returned '${opened.status}'`);

  // Undo left the document dirty: save a template copy under _failed/ with our manifest, then close it (DOC_CLOSE still re-checks isDirty).
  const failDirty = async (applyError: string): Promise<Row> => {
    const id = uuid!;
    const base = `apply failed: ${applyError}`;
    const rel = `_failed/${key}-${id.slice(0, 8)}.af`;
    const scratch = join(c.outDir, "_failed", `${key}-${id.slice(0, 8)}.af`);
    mkdirSync(dirname(scratch), { recursive: true });
    const saved = await step<{ status: string; dirty?: boolean }>(c, DOC_SAVE(id, scratch), "saving a copy of the failed document");
    if (saved.status === "missing") {
      log("exception", false);
      return row("failed", `${base} (document vanished)`);
    }
    if (saved.dirty === true || !existsSync(scratch)) throw new FatalRecord(`${base}; could not save a copy to ${scratch}; left open`, id);
    log("exception", false, scratch);
    try {
      const m = recordSave(scratch, id, null, process.cwd());
      m.madeBy = { script: "fill", scriptSha256: c.templateSha, args: rec, flags: c.flags, ...(c.brand ? { brand: c.brand.ref } : {}) };
      m.notes = [...(m.notes ?? []), { time: new Date().toISOString(), text: `fill: ${base}; saved only so the document could be closed` }];
      writeManifest(scratch, m);
    } catch {
      // the copy is saved; the manifest is a courtesy
    }
    c.failedCopies += 1;
    const note = `${base} (undo left the document dirty; saved as ${rel} and closed)`;
    const closed = await closeDoc(c, id, note);
    return row("failed", closed === "closed" ? note : `${note} (document vanished)`);
  };

  // Apply. A refusal changes nothing, so the document is clean and can be closed.
  let result;
  try {
    result = await c.client.callTool("execute_script", { script: withHelpers(c.brand ? injectBrand(FILL_APPLY(uuid, edits, c.ignoreUnknown), c.brand.kit) : FILL_APPLY(uuid, edits, c.ignoreUnknown)) }, { timeoutMs: c.timeoutMs });
  } catch (err) {
    throw new FatalRecord(`applying the record failed: ${err instanceof Error ? err.message : String(err)}`, uuid);
  }
  const outcome = classify(result);
  let reply: ApplyReply | undefined;
  let reason = "";
  if (outcome.kind !== "ok") {
    reason = outcome.kind === "exception" ? `${outcome.error}${outcome.at ? ` at ${outcome.at}` : ""}` : (resultText(result).split("\n").find((l) => l.trim() !== "") ?? outcome.kind);
  } else {
    try {
      reply = JSON.parse(outcome.text.split("\n").filter((l) => l.trim() !== "").pop() ?? "") as ApplyReply;
    } catch {
      reason = "the apply script returned unreadable output";
    }
  }
  if (reply?.error !== undefined) {
    // The script caught its own exception and undid its edits where it could: the real error leads the note.
    // A document undo left clean is closed and the run goes on. A dirty one is saved as a template copy under
    // _failed/ (the only way to make it clean) and closed through the same gate; if that cannot be done it is fatal.
    if (reply.cleaned !== true) return await failDirty(reply.error);
    const note = `apply failed: ${reply.error} (changes undone)`;
    log("exception", false);
    const closed = await closeDoc(c, uuid, note);
    return row("failed", closed === "closed" ? note : `${note} (document vanished)`);
  }
  const problems = reply ? problemsOf(reply, c.ignoreUnknown) : [];
  if (!reply || problems.length > 0) {
    log(outcome.kind === "ok" ? "refused" : outcome.kind, false);
    const note = reply ? problems.join("; ") : reason;
    // Clean after a refusal; an exception may have left edits behind, which closeDoc reports as fatal with the reason first.
    const closed = await closeDoc(c, uuid, note);
    return row("failed", closed === "closed" ? note : `${note} (document vanished)`);
  }

  const notes: string[] = [];
  if (c.ignoreUnknown && reply.unknown.length > 0) notes.push(`ignored unknown slot${reply.unknown.length > 1 ? "s" : ""}: ${reply.unknown.join(", ")}`);

  // Per-slot remarks from the script (text shrunk to fit, overflow): they follow "saved <file>" and the unknown-slot note.
  notes.push(...(reply.notes ?? []));

  const saved = await step<{ status: string; dirty?: boolean }>(c, DOC_SAVE(uuid, afPath), "saving the document");
  if (saved.status === "missing") return row("failed", "document not found to save");
  if (saved.dirty === true) throw new FatalRecord(`${afPath} is still dirty after save; left open`, uuid);
  if (!existsSync(afPath)) throw new FatalRecord(`save reported success but ${afPath} was not written; left open`, uuid);
  log("ok", true);
  try {
    // The same writer as `doc save`; the file's origin is this command, with the record as its args.
    const m = recordSave(afPath, uuid, null, process.cwd(), { forced: verdict.forced });
    m.madeBy = { script: "fill", scriptSha256: c.templateSha, args: rec, flags: c.flags, ...(c.brand ? { brand: c.brand.ref } : {}) };
    writeManifest(afPath, m);
  } catch (err) {
    notes.push(`manifest NOT WRITTEN (${err instanceof Error ? err.message : String(err)})`);
  }
  notes.unshift(`saved ${basename(afPath)}`);

  let failure: string | undefined;
  if (c.preset !== undefined) {
    try {
      const { files, note } = await exportDoc(c, uuid, key);
      c.exported += files.length;
      recordExports(c, afPath, files);
      notes.push(files.length === 1 ? `exported ${basename(files[0]!)}` : `exported ${files.length} files`);
      if (note !== null) notes.push(`metadata: ${note}`);
    } catch (err) {
      if (err instanceof FatalRecord) throw new FatalRecord(err.message, uuid);
      failure = err instanceof Error ? err.message : String(err);
    }
  }

  if ((await closeDoc(c, uuid)) === "missing") notes.push("document already gone");
  return failure !== undefined ? row("failed", `${notes.join("; ")}; ${failure}`) : row("ok", notes.join("; "));
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "fill",
      summary: "Fill a saved .af by element name from JSON or CSV: one file per record",
      args: [{ name: "template", required: true, description: "the saved .af whose fillable elements are named slot:<key> in the Layers panel" }],
      flags: [
        { name: "data", type: "string", description: "records: a .json array of objects, or a .csv with a header row (required). A picture slot may be a path to .png .jpg .jpeg .webp .heic .heif .tif or .tiff (JPEG and TIFF with EXIF orientation are placed upright) or {\"image\": \"photo.jpg\", \"cutout\": true|\"subject\", \"colourise\": true, \"align\": \"centre\"|\"fit\"|\"none\" (default centre with cutout), \"padding\": px (with fit)} (JSON only)" },
        { name: "out-dir", type: "string", description: "folder under Desktop: each record is saved as <dir>/<key>.af (required)" },
        { name: "key", type: "string", description: "record field that names each record (default: the record index); made filesystem-safe, must be unique" },
        { name: "export", type: "string", description: "also export each record with this preset (see: affinity-axi presets) as <dir>/<key>.<ext>; Affinity's XMP (account name) is stripped from PNG/JPEG/WebP and the kit's `credit` is embedded when set (needs exiftool)" },
        { name: "all-artboards", type: "boolean", description: "with --export: one file per artboard, <dir>/<key>-<artboard>.<ext>" },
        { name: "limit", type: "string", description: "process only the first N records" },
        { name: "continue-on-error", type: "boolean", description: "keep going after a failed record (default: stop at the first failure); a failed ML record whose undo leaves the document dirty is saved under _failed/ and closed" },
        FORCE_FLAG,
        { name: "ignore-unknown", type: "boolean", description: "a data key with no slot is skipped instead of failing the record" },
        BRAND_FLAG,
        { name: "timeout", type: "string", default: String(DEFAULT_TIMEOUT_MS), description: "per-script timeout in milliseconds (ML options cutout and colourise take about 10 s per photo)" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi fill post.af --data posts.json --key slug --out-dir ~/Desktop/out --export PNG",
        "affinity-axi fill post.af --data posts.csv --key slug --out-dir ~/Desktop/out --limit 2 --ignore-unknown",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const templateArg = parsed.positionals[0]!;
      const dataFile = parsed.flags["data"];
      if (typeof dataFile !== "string") throw new UsageError("--data is required", USAGE);
      const rawOut = parsed.flags["out-dir"];
      if (typeof rawOut !== "string") throw new UsageError("--out-dir is required (every record is saved there as <key>.af)", USAGE);
      const template = userPath(templateArg);
      if (!template.endsWith(".af")) throw new UsageError(`template must be a saved .af file, got '${templateArg}'`, USAGE);
      requireVisible(template, "template");
      if (!existsSync(template)) throw new UsageError(`cannot find template '${templateArg}'`, "save the design first: doc save <doc> <path>.af");

      const preset = typeof parsed.flags["export"] === "string" ? parsed.flags["export"] : undefined;
      const allBoards = parsed.flags["all-artboards"] === true;
      if (allBoards && preset === undefined) throw new UsageError("--all-artboards needs --export <preset>", `e.g. ${BIN} fill post.af --data d.json --out-dir out --export PNG --all-artboards`);
      const ext = preset === undefined ? undefined : extFor(preset);
      if (preset !== undefined && ext === undefined) throw new UsageError(`cannot tell the file type of preset '${preset}'`, `run '${BIN} presets' and pick a PNG, JPEG, WebP, SVG or PDF preset`);
      const timeoutMs = positiveFlag(parsed, "timeout", { integer: true, fallback: DEFAULT_TIMEOUT_MS, example: "60000" });
      const limit = positiveFlag(parsed, "limit", { integer: true, example: "3" });
      const keyField = typeof parsed.flags["key"] === "string" ? parsed.flags["key"] : undefined;

      const all = loadRecords(dataFile);
      const records = limit === undefined ? all : all.slice(0, limit);
      const keys = deriveKeys(records, keyField);
      const dataDir = dirname(resolve(dataFile));
      const plans = records.map((r) => planEdits(r, keyField, dataDir));
      const outDir = userPath(rawOut);
      requireVisible(outDir, "--out-dir");
      for (const p of plans.flatMap(imagePaths)) requireVisible(p, "image");
      const brandPath = resolveBrandRef(typeof parsed.flags["brand"] === "string" ? parsed.flags["brand"] : undefined, process.env, process.cwd());
      const brand = brandPath ? loadBrand(brandPath) : undefined;

      if (records.length === 0) {
        print([emitList("records", [], ["key", "status", "doc", "ms", "note"]), `saved: ${outDir}`, "exported: 0"].join("\n"));
        return 0;
      }

      const client = await connect({ url: typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined });
      const rows: Row[] = [];
      const ctx: Ctx = {
        client,
        template,
        templateSha: sha256File(template),
        force: parsed.flags["force"] === true,
        outDir,
        ignoreUnknown: parsed.flags["ignore-unknown"] === true,
        timeoutMs,
        preset,
        ext,
        allBoards,
        flags: [...(preset ? [`--export ${preset}`] : []), ...(allBoards ? ["--all-artboards"] : []), ...(parsed.flags["ignore-unknown"] === true ? ["--ignore-unknown"] : []), ...(parsed.flags["force"] === true ? ["--force"] : [])],
        exported: 0,
        leftOpen: [],
        failedCopies: 0,
        brand,
        refused: [],
      };
      try {
        const app = await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info");
        const desktop = resolve(app.desktop);
        requireUnderDesktop(desktop, template, "template", "open");
        requireUnderDesktop(desktop, outDir, "--out-dir", "write-folder");
        for (const p of plans.flatMap(imagePaths)) requireUnderDesktop(desktop, p, "image", "read-image");
        if (preset !== undefined) {
          const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
          if (!presets.includes(preset)) {
            const q = preset.toLowerCase();
            const near = presets.filter((p) => p.toLowerCase().includes(q));
            throw new UsageError(`unknown export preset '${preset}'`, `${near.length > 0 ? `closest: ${near.join(", ")}; ` : ""}run '${BIN} presets' to list all names`);
          }
        }
        mkdirSync(outDir, { recursive: true });

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
            r = await runOne(ctx, records[i]!, key, plans[i]!);
          } catch (err) {
            if (!(err instanceof FatalRecord)) throw err;
            if (err.uuid) ctx.leftOpen.push(err.uuid);
            r = { key, status: "failed", doc: err.uuid ? err.uuid.slice(0, 8) : "", ms: 0, note: oneLine(err.message) };
            stopped = `not run: stopped after a fatal error at '${key}'`;
          }
          rows.push(r);
          if (r.status === "failed" && stopped === undefined && !keepGoing) stopped = `not run: stopped after failure at '${key}'`;
        }
      } finally {
        client.close();
      }

      const failed = rows.filter((r) => r.status === "failed").length;
      const out = [emitList("records", rows as unknown as Array<Record<string, unknown>>, ["key", "status", "doc", "ms", "note"]), `saved: ${outDir}`, `exported: ${ctx.exported}`];
      if (ctx.failedCopies > 0) out.push(`failedCopies: ${join(outDir, "_failed")}`);
      if (ctx.leftOpen.length > 0) out.push(`leftOpen: ${ctx.leftOpen.join(" ")}`);
      const firstOk = rows.find((r) => r.status === "ok");
      const helps: string[] = [];
      if (firstOk) helps.push(`${BIN} doc open ${join(outDir, `${firstOk.key}.af`)}`, `${BIN} inspect <doc> --named   # the doc id doc open prints`);
      if (rows.some((r) => r.status === "skipped")) helps.push(`${BIN} fill ${templateArg} --data ${dataFile} --out-dir ${rawOut} --continue-on-error   # process the records after a failure`);
      if (ctx.refused.length > 0) {
        const names = ctx.refused.slice(0, 5).map((r) => `${r.key}.af`).join(", ") + (ctx.refused.length > 5 ? ", ..." : "");
        helps.push(
          `${BIN} fill ${templateArg} --data ${dataFile}${keyField ? ` --key ${keyField}` : ""} --out-dir ${rawOut} --force   # replace the ${ctx.refused.length} refused .af: ${names}`,
          `${BIN} doc open ${ctx.refused[0]!.path}   # work on the existing file instead`,
        );
      }
      if (ctx.failedCopies > 0) helps.push(`rm -r ${join(outDir, "_failed")}   # template copies saved only so failed documents could be closed`);
      if (helps.length > 0) out.push(helpBlock(helps));
      print(out.join("\n"));
      return failed > 0 ? 1 : 0;
    },
  };
}
