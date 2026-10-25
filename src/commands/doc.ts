// `doc new`, `doc save`, `doc close`: safe document lifecycle.
//
// The SDK has no discard option: Document.close() on a dirty document opens a
// save prompt nobody can answer, which blocks execute_script and can hang
// Affinity. So `doc close` refuses dirty documents (before any close call, and
// again inside the script, right before close()), and `doc save` is the
// verified way to make a document clean (saveAs leaves isDirty false).

import { mkdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import { positiveFlag, type Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, LIST_DOCUMENTS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";
import type { Inventory } from "../affinity/manifest-types.js";
import { INSPECT } from "../affinity/inspect-script.js";
import { freshness, recordSave } from "../affinity/manifest.js";
import { FORCE_FLAG, checkOverwrite } from "../affinity/overwrite.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";

export const BIN = "affinity-axi";
const DOC_REQUIRE = "const { Document, NewDocumentOptions } = require('/document.js');";
const UNITS_REQUIRE = "const { UnitType } = require('/units.js');";
const FIND_DOC = "const doc = Document.all.find((d) => String(d.sessionUuid) === targetUuid);";

// The console.log calls inside these script strings are required output: the
// only channel back from Affinity.

/**
 * Creates a document. Logs {"uuid","title","dirty","units","width","height","dpi","transparent"} (sizes in px).
 * transparent sets the background transparent so a PNG export keeps alpha.
 */
export function DOC_NEW(width: number, height: number, units: string, dpi: number, transparent: boolean): string {
  const props = transparent
    ? [
        "const { DocumentProperties } = require('/documentproperties.js');",
        "const p = DocumentProperties.create(); p.isTransparent = true; doc.setDocumentProperties(p);",
      ]
    : [];
  return [
    "/* affinity-axi:doc-new */",
    DOC_REQUIRE,
    UNITS_REQUIRE,
    `const unitName = ${JSON.stringify(units)};`,
    "const o = NewDocumentOptions.createDefault();",
    "o.units = UnitType[unitName];",
    `o.width = ${width}; o.height = ${height}; o.dpi = ${dpi};`,
    "const doc = Document.createFromOptions(o);",
    ...props,
    `console.log(JSON.stringify({ uuid: String(doc.sessionUuid), title: String(doc.title), dirty: !!doc.isDirty, units: String(doc.units), width: doc.widthPixels, height: doc.heightPixels, dpi: doc.dpi, transparent: ${transparent} }));`,
  ].join("\n");
}

/**
 * Saves a document with saveAs. Logs {"status":"saved"|"unchanged"|"missing","uuid","path","dirty"}.
 * A clean document already at outPath is left alone (idempotent).
 */
export function DOC_SAVE(docUuid: string, path: string): string {
  return [
    "/* affinity-axi:doc-save */",
    DOC_REQUIRE,
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    `const outPath = ${JSON.stringify(path)};`,
    FIND_DOC,
    "if (!doc) { console.log(JSON.stringify({ status: 'missing', uuid: targetUuid })); }",
    "else if (!doc.isDirty && String(doc.path || '') === outPath) { console.log(JSON.stringify({ status: 'unchanged', uuid: targetUuid, path: outPath, dirty: false })); }",
    "else { doc.saveAs(outPath); console.log(JSON.stringify({ status: 'saved', uuid: targetUuid, path: String(doc.path || outPath), dirty: !!doc.isDirty })); }",
  ].join("\n");
}

/**
 * Closes a document only if it is clean. isDirty is re-read right before
 * close(); a dirty document is never closed. Logs {"status":"closed"|"dirty"|"missing"|"still-open","uuid"}.
 */
export function DOC_CLOSE(docUuid: string): string {
  return [
    "/* affinity-axi:doc-close */",
    DOC_REQUIRE,
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    FIND_DOC,
    "if (!doc) { console.log(JSON.stringify({ status: 'missing', uuid: targetUuid })); }",
    "else if (doc.isDirty) { console.log(JSON.stringify({ status: 'dirty', uuid: targetUuid })); }",
    "else {",
    "  doc.close();",
    "  const still = Document.all.some((d) => String(d.sessionUuid) === targetUuid);",
    "  console.log(JSON.stringify({ status: still ? 'still-open' : 'closed', uuid: targetUuid }));",
    "}",
  ].join("\n");
}

export const URL_FLAG = { name: "url", type: "string" as const, description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" };
const DOC_ARG = { name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" };

export function urlFlag(parsed: Parsed): string | undefined {
  const u = parsed.flags["url"];
  return typeof u === "string" ? u : undefined;
}

export async function resolveDoc(client: AffinityClient, ref: string): Promise<DocInfo> {
  const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(client, LIST_DOCUMENTS, "listing documents");
  return resolveDocRef(ref, listing.documents, listing.current);
}

/** Runs a doc-* script and parses the JSON it logged; any non-ok outcome is an AxiError. */
export async function runDocScript<T>(client: AffinityClient, script: string, what: string): Promise<T> {
  const result = await client.callTool("execute_script", { script });
  const outcome = classify(result);
  if (outcome.kind !== "ok") {
    const first = resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure";
    throw new AxiError(`${what} failed: ${first}`, "check Affinity for an open dialog or prompt and answer it by hand; do not re-run blindly");
  }
  const last = outcome.text.split("\n").filter((l) => l.trim() !== "").pop() ?? "";
  try {
    return JSON.parse(last) as T;
  } catch {
    throw new AxiError(`${what} returned unreadable output`, "re-run; if it persists report it with 'affinity-axi hint add'");
  }
}

/** The inventory of an open document, or null when the walk fails (a save must not fail over it). */
export async function fetchInventory(client: AffinityClient, uuid: string): Promise<Inventory | null> {
  try {
    const inv = await runDocScript<Inventory>(client, INSPECT(uuid), "reading the inventory");
    return inv && Array.isArray(inv.nodes) ? inv : null;
  } catch {
    return null;
  }
}

function makeNew(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "doc new",
      summary: "Create a new document (default 72 dpi for px; 300 dpi for mm/pt print sizes)",
      flags: [
        { name: "width", type: "string", description: "document width in --units (required)" },
        { name: "height", type: "string", description: "document height in --units (required)" },
        { name: "units", type: "string", default: "px", values: ["px", "mm", "pt"], description: "size units" },
        { name: "dpi", type: "string", description: "resolution (default 72 for px, 300 for mm/pt)" },
        { name: "transparent", type: "boolean", description: "transparent background, so PNG exports keep alpha (cut-outs, stickers, logos)" },
        URL_FLAG,
      ],
      examples: [
        "affinity-axi doc new --width 1920 --height 1080",
        "affinity-axi doc new --width 210 --height 297 --units mm",
        "affinity-axi doc new --width 800 --height 600 --transparent   # PNG export keeps alpha",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const units = String(parsed.flags["units"] ?? "px");
      const unitType = ({ px: "Pixel", mm: "Millimetre", pt: "Point" } as Record<string, string>)[units];
      if (!unitType) throw new UsageError(`invalid --units '${units}'`, "use px, mm or pt");
      if (parsed.flags["width"] === undefined || parsed.flags["height"] === undefined) {
        throw new UsageError("--width and --height are required", `example: ${BIN} doc new --width 800 --height 600`);
      }
      // Presence was checked above, so width and height are never undefined here.
      const width = positiveFlag(parsed, "width", { example: "800" })!;
      const height = positiveFlag(parsed, "height", { example: "800" })!;
      const dpi = positiveFlag(parsed, "dpi", { fallback: units === "px" ? 72 : 300, example: "72" });

      const transparent = parsed.flags["transparent"] === true;
      const client = await connect({ url: urlFlag(parsed) });
      let info: { uuid: string; title: string; dirty: boolean; units: string; width: number; height: number; dpi: number; transparent: boolean };
      try {
        info = await runDocScript(client, DOC_NEW(width, height, unitType, dpi, transparent), "creating the document");
      } finally {
        client.close();
      }
      const uuid8 = info.uuid.slice(0, 8);
      print(
        [
          emitKV([
            ["doc", info.uuid],
            ["size", `${Math.round(info.width)}x${Math.round(info.height)} px @ ${info.dpi} dpi`],
            ["units", info.units],
            ["dirty", info.dirty],
            ["transparent", info.transparent === true],
          ]),
          helpBlock([
            `${BIN} run <script.js> --args '{"uuid":"${uuid8}"}'   # draw into it`,
            `${BIN} render ${uuid8}`,
            ...(info.transparent === true ? [`${BIN} export ${uuid8} PNG <path-under-Desktop>.png   # keeps alpha`] : []),
            `${BIN} doc save ${uuid8} <path-under-Desktop>.af   # needed before it can be closed`,
          ]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

function makeSave(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "doc save",
      summary: "Save a document as a .af file under the Desktop folder (makes it clean)",
      args: [DOC_ARG, { name: "path", required: true, description: "output .af path; must be inside the Desktop folder" }],
      flags: [
        FORCE_FLAG,
        URL_FLAG,
      ],
      examples: ["affinity-axi doc save 70E876CB ~/Desktop/logo.af", "affinity-axi doc save 70E876CB out/work.af   # relative to the current directory"],
    },
    async run(parsed: Parsed): Promise<number> {
      const [ref, rawPath] = parsed.positionals as [string, string];
      const path = userPath(rawPath);
      if (!path.toLowerCase().endsWith(".af")) {
        throw new UsageError(`save path must end in .af: ${path}`, `example: ${BIN} doc save ${ref} ~/Desktop/work.af`);
      }
      requireVisible(path, "save path");

      // Offline guard: a hand-edited .af is never overwritten without --force.
      // The document's own path is not known yet, so only the stale verdict
      // is final here; the unmanaged verdict is re-checked after resolveDoc.
      const force = parsed.flags["force"] === true;
      const cmd = `${BIN} doc save ${ref} ${path}`;
      const fresh = freshness(path);
      const early = checkOverwrite(path, { force, cmd });
      if (!early.ok && early.reason === "stale") {
        throw new AxiError(early.message, `${early.suggestion}; ${BIN} inspect ${ref} --named shows what is in the open document`);
      }

      const client = await connect({ url: urlFlag(parsed) });
      let inventory: Inventory | null = null;
      let doc: DocInfo;
      let status: string;
      let dirty: boolean;
      let savedPath: string;
      let forced = false;
      try {
        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, path, "save path", "write-file");
        doc = await resolveDoc(client, ref);
        const verdict = checkOverwrite(path, { force, ownPath: doc.path, cmd });
        if (!verdict.ok) throw new AxiError(verdict.message, verdict.suggestion);
        forced = verdict.forced;
        mkdirSync(dirname(path), { recursive: true });
        const out = await runDocScript<{ status: string; path?: string; dirty?: boolean }>(client, DOC_SAVE(doc.uuid, path), "saving the document");
        if (out.status === "missing") {
          throw new UsageError(`no open document matches "${ref}"`, `run '${BIN}' to list open documents`);
        }
        status = out.status;
        dirty = out.dirty === true;
        savedPath = out.path ?? path;
        if (status !== "unchanged" || force || fresh.state === "none") inventory = await fetchInventory(client, doc.uuid);
      } finally {
        client.close();
      }

      let bytes: number;
      try {
        bytes = statSync(path).size;
      } catch {
        throw new AxiError(`save reported success but ${path} was not written`, "check the folder exists and retry");
      }
      const uuid8 = doc.uuid.slice(0, 8);
      const pairs: Array<[string, unknown]> = [
        ["saved", savedPath],
        ["doc", doc.uuid],
        ["bytes", bytes],
        ["dirty", dirty],
      ];
      if (status === "unchanged") pairs.push(["note", "already saved and clean; nothing to do"]);
      if (status !== "unchanged" || force || fresh.state === "none") {
        try {
          recordSave(path, doc.uuid, inventory, process.cwd(), { forced });
          pairs.push(["manifest", `${basename(path)}.axi.json${forced ? " (forced)" : ""}`]);
        } catch (err) {
          pairs.push(["manifest", `not updated (${err instanceof Error ? err.message : String(err)})`]);
        }
      }
      print([emitKV(pairs), helpBlock([`${BIN} doc close ${uuid8}`, `${BIN} export ${uuid8} PNG <path-under-Desktop>`])].join("\n"));
      return 0;
    },
  };
}

function makeClose(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "doc close",
      summary: "Close a clean document; refuses unsaved ones (the SDK cannot discard)",
      args: [DOC_ARG],
      flags: [URL_FLAG],
      examples: ["affinity-axi doc close 70E876CB"],
    },
    async run(parsed: Parsed): Promise<number> {
      const ref = parsed.positionals[0]!;
      const client = await connect({ url: urlFlag(parsed) });
      let uuid: string;
      try {
        const doc = await resolveDoc(client, ref);
        uuid = doc.uuid;
        const uuid8 = uuid.slice(0, 8);
        const refuse = (): never => {
          throw new AxiError(
            `document ${uuid} (${doc.title}) has unsaved changes; closing it would open a save prompt that hangs Affinity`,
            `the SDK cannot discard a document: run '${BIN} doc save ${uuid8} <path-under-Desktop>.af' first, then close it`,
          );
        };
        if (doc.dirty) refuse();
        const out = await runDocScript<{ status: string }>(client, DOC_CLOSE(uuid), "closing the document");
        if (out.status === "dirty") refuse();
        if (out.status === "missing") {
          throw new UsageError(`no open document matches "${ref}"`, `run '${BIN}' to list open documents`);
        }
        if (out.status !== "closed") {
          throw new AxiError(`document ${uuid} is still open after close`, "check Affinity for an open dialog and answer it by hand; do not re-run blindly");
        }
      } finally {
        client.close();
      }
      print(emitKV([["closed", uuid]]));
      return 0;
    },
  };
}

export function make(connect: ConnectFn): Record<"doc new" | "doc save" | "doc close", CommandModule> {
  return { "doc new": makeNew(connect), "doc save": makeSave(connect), "doc close": makeClose(connect) };
}
