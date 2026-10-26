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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AiHit } from "../mcp/types.js";

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

/** Records that touched this document session UUID (case-insensitive), from every log found walking up; duplicates (same time, script and documents) count once. */
export function recordsFor(uuid: string, cwd: string = process.cwd(), opts?: LookupOpts): ProvenanceRecord[] {
  const want = uuid.toUpperCase();
  const seen = new Set<string>();
  const found: ProvenanceRecord[] = [];
  for (const dir of lookupDirs(cwd, opts)) {
    for (const r of readProvenance(dir)) {
      if (!r.documents.some((d) => d.toUpperCase() === want)) continue;
      const key = JSON.stringify([r.time, r.script, r.documents]);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(r);
    }
  }
  return found;
}

/** True when a logged generative run touched this document session UUID. */
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
