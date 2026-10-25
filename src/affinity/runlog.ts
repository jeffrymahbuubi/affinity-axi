// Run log: one JSON line per `run` or `batch` record in
// <cwd>/.affinity-axi/runs.jsonl. `doc save` folds the lines for its session
// UUID into the manifest history. Best-effort, plain text, torn lines skipped
// (same contract as provenance.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunRecord } from "./manifest-types.js";

export function runsPath(cwd: string = process.cwd()): string {
  return join(cwd, ".affinity-axi", "runs.jsonl");
}

/** Appends one record and returns the log path. */
export function appendRun(record: RunRecord, cwd: string = process.cwd()): string {
  const file = runsPath(cwd);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n");
  return file;
}

/** Every well-formed record in file order; unreadable or malformed lines are skipped. */
export function readRuns(cwd: string = process.cwd()): RunRecord[] {
  const file = runsPath(cwd);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r && typeof r === "object" && Array.isArray(r.documents)) records.push(r);
    } catch {
      // a torn line must not hide the rest of the log
    }
  }
  return records;
}

/**
 * Records that touched this document session UUID (case-insensitive) strictly
 * after `time` (ISO 8601; empty or unparseable means from the beginning).
 */
export function runsSince(uuid: string, time: string, cwd: string = process.cwd()): RunRecord[] {
  const want = uuid.toUpperCase();
  const since = time ? Date.parse(time) : NaN;
  return readRuns(cwd).filter((r) => {
    if (!r.documents.some((d) => String(d.uuid).toUpperCase() === want)) return false;
    if (Number.isNaN(since)) return true;
    const t = Date.parse(r.time);
    return Number.isNaN(t) ? true : t > since;
  });
}
