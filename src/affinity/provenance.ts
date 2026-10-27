// Provenance log for generative runs.
//
// Every `run --allow-generative` whose script really references a generative
// identifier appends one JSON line to <cwd>/.affinity-axi/provenance.jsonl.
// `export` reads the logs found walking up from the cwd and from the saved
// document's folder (a sibling folder or a subfolder of the project still finds
// the project's log): a document whose session UUID appears in any record
// is ai-generated, and gets a `<file>.provenance.json` sidecar for disclosure
// labels (Meta AI disclosure and similar). The log is best-effort evidence,
// not tamper-proof: it lives next to the project, in plain text.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AiHit } from "../mcp/types.js";
import { readAiUuids } from "./manifest-ai.js";

export interface ProvenanceRecord {
  /** ISO 8601 time the run finished. */
  time: string;
  script: string;
  sha256: string;
  identifiers: AiHit[];
  /** The parsed --args JSON (the prompt usually travels here), or null. */
  args: unknown;
  /** Outcome kind: ok, not-allowed, exception, sdk-error, or "error" when the call itself failed. */
  outcome: string;
  /** Document session UUIDs seen in the script output (uppercase). */
  documents: string[];
  /**
   * Saved path of every document in `documents` at the end of the run (unsaved
   * documents contribute nothing). A reopened document gets a new session UUID,
   * so lookups also match by path. Absent in old records.
   */
  paths?: string[];
  /**
   * Whether the run's call-shim saw a generative API run: true, false (the
   * identifier was in the script but the call never ran) or "unknown" (no
   * confirmation possible: timeout, error, shim unavailable). Absent in old
   * records, which count as generated.
   */
  called?: boolean | "unknown";
}

const UUID_RE = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/g;

export function provenancePath(cwd: string = process.cwd()): string {
  return join(cwd, ".affinity-axi", "provenance.jsonl");
}

/** Unique UUIDs in text, uppercased, in order of first appearance. */
export function extractUuids(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(UUID_RE)) seen.add(m[0].toUpperCase());
  return [...seen];
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function appendProvenance(record: ProvenanceRecord, cwd: string = process.cwd()): string {
  const file = provenancePath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n");
  return file;
}

/** Every well-formed record; unreadable or malformed lines are skipped. */
export function readProvenance(cwd: string = process.cwd()): ProvenanceRecord[] {
  const file = provenancePath(cwd);
  if (!existsSync(file)) return [];
  const records: ProvenanceRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as ProvenanceRecord;
      if (r && Array.isArray(r.documents)) records.push(r);
    } catch {
      // a torn line must not hide the rest of the log
    }
  }
  return records;
}

export interface LookupOpts {
  /** Saved path of the document: its folder (and parents) are searched too. */
  docPath?: string;
}

/** `dir` and every parent up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  let cur = resolve(dir);
  for (;;) {
    out.push(cur);
    const up = dirname(cur);
    if (up === cur) return out;
    cur = up;
  }
}

/** Every folder whose provenance log applies: the cwd and the document's folder, each with its parents. */
function lookupDirs(cwd: string, opts?: LookupOpts): string[] {
  const roots = [cwd];
  const doc = opts?.docPath;
  if (typeof doc === "string" && doc.trim() !== "") roots.push(dirname(resolve(cwd, doc)));
  return [...new Set(roots.flatMap(ancestors))];
}

/** Realpath (when the file exists) of a path, lowercased, for case-insensitive comparison. */
function pathKey(p: string, cwd: string): string {
  const abs = resolve(cwd, p);
  try {
    return realpathSync(abs).toLowerCase();
  } catch {
    return abs.toLowerCase();
  }
}

/**
 * Records that touched this document, from every log found walking up: a record
 * matches when its `documents` has the session UUID (case-insensitive), or the
 * saved `docPath` equals one of its `paths` (realpath, case-insensitive), or the
 * manifest beside `docPath` lists (`ai.uuids`) a UUID its `documents` has.
 * Duplicates (same time, script and documents) count once. Records with
 * `called: false` (the call never ran) are ignored.
 */
export function recordsFor(uuid: string, cwd: string = process.cwd(), opts?: LookupOpts): ProvenanceRecord[] {
  const want = new Set([uuid.toUpperCase()]);
  const doc = typeof opts?.docPath === "string" ? opts.docPath : "";
  const docKey = doc.trim() !== "" ? pathKey(doc, cwd) : undefined;
  if (docKey !== undefined) for (const u of readAiUuids(resolve(cwd, doc))) want.add(u);
  const seen = new Set<string>();
  const found: ProvenanceRecord[] = [];
  for (const dir of lookupDirs(cwd, opts)) {
    for (const r of readProvenance(dir)) {
      if (r.called === false) continue;
      const byUuid = r.documents.some((d) => want.has(String(d).toUpperCase()));
      const byPath = docKey !== undefined && Array.isArray(r.paths) && r.paths.some((p) => typeof p === "string" && p !== "" && pathKey(p, cwd) === docKey);
      if (!byUuid && !byPath) continue;
      const key = JSON.stringify([r.time, r.script, r.documents]);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(r);
    }
  }
  return found;
}

/** True when a logged generative run that really called the API (or could not say) touched this document session UUID. */
export function isAiGenerated(uuid: string, cwd: string = process.cwd(), opts?: LookupOpts): boolean {
  return recordsFor(uuid, cwd, opts).length > 0;
}

/** Writes `<exported>.provenance.json` and returns its path. */
export function writeSidecar(exported: string, uuid: string, records: ProvenanceRecord[]): string {
  const file = `${exported}.provenance.json`;
  const body = { ai_generated: true, document: uuid, export: exported, records };
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}
