// The ownership ledger: which open documents affinity-axi created (doc new, run, batch), so that
// `--discard` and `doc close --mine` only ever drop documents the tool made. One JSON line per mark in
// <state dir>/owned.jsonl. It stores ids, times and a hash of the folder, never a path.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { realish } from "./paths.js";

export interface OwnedRecord {
  time: string;
  uuid: string;
  by: "doc new" | "run" | "batch";
  scratch: boolean;
  scope: string;
}

const BYS: ReadonlyArray<string> = ["doc new", "run", "batch"];

/** The user-level state folder: $AFFINITY_AXI_HOME when set and non-empty, else ~/.affinity-axi. */
function stateDir(): string {
  const env = process.env["AFFINITY_AXI_HOME"];
  return typeof env === "string" && env !== "" ? resolve(env) : join(homedir(), ".affinity-axi");
}

/** A short hash of the folder a document was created from. */
export function scopeOf(cwd: string = process.cwd()): string {
  return createHash("sha256").update(realish(resolve(cwd))).digest("hex").slice(0, 12);
}

export function ownedPath(dir?: string): string {
  return join(dir ?? stateDir(), "owned.jsonl");
}

/** Appends one line per uuid. Does nothing for an empty list and never throws. */
export function markOwned(
  uuids: string[],
  by: OwnedRecord["by"],
  opts: { scratch?: boolean; cwd?: string; dir?: string } = {},
): void {
  if (uuids.length === 0) return;
  try {
    const path = ownedPath(opts.dir);
    const scope = scopeOf(opts.cwd);
    const time = new Date().toISOString();
    const lines = uuids.map((u): string => JSON.stringify({ time, uuid: u.toUpperCase(), by, scratch: opts.scratch === true, scope } satisfies OwnedRecord));
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, lines.join("\n") + "\n");
  } catch {
    // best effort: a missing ledger line only makes --discard more cautious
  }
}

function parseLine(line: string): OwnedRecord | undefined {
  try {
    const v = JSON.parse(line) as Partial<OwnedRecord> | null;
    if (!v || typeof v !== "object") return undefined;
    if (typeof v.uuid !== "string" || v.uuid === "" || typeof v.time !== "string" || typeof v.scope !== "string") return undefined;
    if (typeof v.by !== "string" || !BYS.includes(v.by)) return undefined;
    return { time: v.time, uuid: v.uuid.toUpperCase(), by: v.by, scratch: v.scratch === true, scope: v.scope };
  } catch {
    return undefined; // a torn line
  }
}

/** The ledger by upper-case uuid. A later line replaces an earlier one; `scratch` stays true once set. */
export function readOwned(dir?: string): Map<string, OwnedRecord> {
  const out = new Map<string, OwnedRecord>();
  let text: string;
  try {
    text = readFileSync(ownedPath(dir), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const rec = parseLine(line);
    if (!rec) continue;
    const prev = out.get(rec.uuid);
    out.set(rec.uuid, { ...rec, scratch: rec.scratch || prev?.scratch === true });
  }
  return out;
}

/** Keeps only the uuids in `open`; deletes the file when nothing is left. Never throws. */
export function pruneOwned(open: string[], dir?: string): void {
  try {
    const path = ownedPath(dir);
    if (!existsSync(path)) return;
    const keep = new Set(open.map((u) => u.toUpperCase()));
    const kept = [...readOwned(dir).values()].filter((r) => keep.has(r.uuid));
    if (kept.length === 0) rmSync(path, { force: true });
    else writeFileSync(path, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  } catch {
    // best effort
  }
}
