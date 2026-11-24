// Run log: one JSON line per `run`, `batch` or `fill` record in the user-level
// state folder (<home>/.affinity-axi/runs.jsonl, or $AFFINITY_AXI_HOME/runs.jsonl),
// not in the project. `doc save` folds the lines for its session UUID into the
// manifest history. The home folder is stored as "~". A log of MAX_LOG_BYTES or more
// is rotated to runs.1.jsonl (one generation kept). A legacy
// <cwd>/.affinity-axi/runs.jsonl is moved into the user-level log on first use and
// deleted. Best-effort, plain text, torn lines skipped (same contract as provenance.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expandTilde, scrubHome, stateDir } from "./portable.js";
import type { RunRecord } from "./manifest-types.js";

export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export function runsPath(dir: string = stateDir()): string {
  return join(dir, "runs.jsonl");
}

/** Well-formed records of a log text; torn or malformed lines are skipped. */
function parse(text: string): RunRecord[] {
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

/** Moves <cwd>/.affinity-axi/runs.jsonl into the user-level log; returns the number of records moved. Never throws. */
export function migrateLegacy(cwd: string, dir: string = stateDir()): number {
  try {
    const legacy = join(cwd, ".affinity-axi", "runs.jsonl");
    if (!existsSync(legacy) || resolve(legacy) === resolve(runsPath(dir))) return 0;
    const parent = resolve(cwd);
    const records = parse(readFileSync(legacy, "utf8")).map((r) => (r.cwd ? r : { ...r, cwd: parent }));
    if (records.length > 0) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(runsPath(dir), records.map((r) => JSON.stringify(scrubHome(r)) + "\n").join(""));
    }
    unlinkSync(legacy);
    try {
      rmdirSync(dirname(legacy));
    } catch {
      // renders or the provenance log are still there
    }
    return records.length;
  } catch {
    return 0;
  }
}

/** Appends one record (home folder stored as "~") and returns the log path. */
export function appendRun(record: RunRecord, cwd: string = process.cwd(), dir: string = stateDir()): string {
  migrateLegacy(cwd, dir);
  const file = runsPath(dir);
  mkdirSync(dir, { recursive: true });
  if (existsSync(file) && statSync(file).size >= MAX_LOG_BYTES) renameSync(file, join(dir, "runs.1.jsonl"));
  appendFileSync(file, JSON.stringify(scrubHome(record)) + "\n");
  return file;
}

function expand(r: RunRecord): RunRecord {
  return {
    ...r,
    cwd: typeof r.cwd === "string" ? expandTilde(r.cwd) : r.cwd,
    script: typeof r.script === "string" ? expandTilde(r.script) : r.script,
    documents: r.documents.map((d) => (typeof d.path === "string" ? { ...d, path: expandTilde(d.path) } : d)),
    ...(r.brand && typeof r.brand.path === "string" ? { brand: { ...r.brand, path: expandTilde(r.brand.path) } } : {}),
  };
}

/** Every well-formed record, rotated log first; unreadable or malformed lines are skipped. */
export function readRuns(cwd: string = process.cwd(), dir: string = stateDir()): RunRecord[] {
  migrateLegacy(cwd, dir);
  const out: RunRecord[] = [];
  for (const file of [join(dir, "runs.1.jsonl"), runsPath(dir)]) {
    try {
      out.push(...parse(readFileSync(file, "utf8")));
    } catch {
      // absent or unreadable
    }
  }
  return out.map(expand);
}

/**
 * Records that touched this document session UUID (case-insensitive) strictly
 * after `time` (ISO 8601; empty or unparseable means from the beginning).
 */
export function runsSince(uuid: string, time: string, cwd: string = process.cwd(), dir: string = stateDir()): RunRecord[] {
  const want = uuid.toUpperCase();
  const since = time ? Date.parse(time) : NaN;
  return readRuns(cwd, dir).filter((r) => {
    if (!r.documents.some((d) => String(d.uuid).toUpperCase() === want)) return false;
    if (Number.isNaN(since)) return true;
    const t = Date.parse(r.time);
    return Number.isNaN(t) ? true : t > since;
  });
}
