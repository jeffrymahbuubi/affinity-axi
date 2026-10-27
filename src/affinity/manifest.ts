// Asset manifest: <file>.af.axi.json beside the .af. It is a cache of what the
// tool knows about the file, bound to the file's bytes by sha256: the user
// hand-edits .af files, so a hash mismatch means "stale" and the file wins.
//
// `recordSave` is the only writer of af.sha256, history folding and madeBy;
// other commands read the manifest and write only their own field (exports,
// notes, an `open` history entry) through readManifest/writeManifest.
// Functions taking `afPath` also accept the manifest path itself.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { readAiUuids } from "./manifest-ai.js";
import { recordsFor, type ProvenanceRecord } from "./provenance.js";
import type { BrandRef, Freshness, Inventory, Manifest } from "./manifest-types.js";
import { runsSince } from "./runlog.js";

const SUFFIX = ".axi.json";

function toolName(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    if (pkg.version) return `affinity-axi ${pkg.version}`;
  } catch {
    // fall through to the fixed name
  }
  return "affinity-axi 0.1.0";
}

/** The .af path for either form of path. */
function afOf(path: string): string {
  return path.endsWith(SUFFIX) ? path.slice(0, -SUFFIX.length) : path;
}

/** `<afPath>.axi.json` (a path already ending in it is returned unchanged). */
export function manifestPath(afPath: string): string {
  return afOf(afPath) + SUFFIX;
}

/** Hex sha256 of the file's bytes. Throws when unreadable. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** Uppercase, deduplicated strings of a hand-editable list; anything else reads as []. */
const uuidList = (v: unknown): string[] => [...new Set(arr<unknown>(v).filter((x): x is string => typeof x === "string" && x !== "").map((x) => x.toUpperCase()))];
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Gives a parsed manifest its full shape: arrays default to [], af/ai to their
 * empty objects field by field, madeBy/inventory to null. Unknown keys are kept,
 * so a hand-edited or truncated file never breaks a caller's push/length.
 */
function normaliseManifest(raw: Record<string, unknown>, afPath: string): Manifest {
  const af = isObj(raw["af"]) ? raw["af"] : {};
  const ai = isObj(raw["ai"]) ? raw["ai"] : {};
  return {
    ...raw,
    schema: "affinity-axi/manifest/1",
    file: str(raw["file"]) || baseName(afOf(afPath)),
    af: { ...af, sha256: str(af["sha256"]), bytes: num(af["bytes"]), savedAt: str(af["savedAt"]), tool: str(af["tool"]) },
    madeBy: isObj(raw["madeBy"]) ? (raw["madeBy"] as unknown as Manifest["madeBy"]) : null,
    history: arr(raw["history"]),
    exports: arr(raw["exports"]),
    ai: { ...ai, generated: ai["generated"] === true, records: num(ai["records"]), uuids: uuidList(ai["uuids"]) },
    inventory: isObj(raw["inventory"]) ? (raw["inventory"] as unknown as Inventory) : null,
    notes: arr(raw["notes"]),
  };
}

/** The manifest (always fully shaped, see normaliseManifest), or null when absent, unparseable or not an object. */
export function readManifest(afPath: string): Manifest | null {
  const file = manifestPath(afPath);
  if (!existsSync(file)) return null;
  try {
    const m: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObj(m) ? normaliseManifest(m, afPath) : null;
  } catch {
    return null;
  }
}

/** Two-space JSON, written to a temp file then renamed so readers never see a torn manifest. */
export function writeManifest(afPath: string, manifest: Manifest): string {
  const file = manifestPath(afPath);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

/**
 * none: no manifest (or one that never recorded a hash); fresh: the .af still
 * has the recorded hash; stale: the hash differs or the .af is gone.
 */
export function freshness(afPath: string): { state: Freshness; savedAt?: string } {
  const m = readManifest(afPath);
  const recorded = m?.af?.sha256;
  if (!m || !recorded) return { state: "none" };
  const savedAt = m.af.savedAt;
  try {
    return { state: sha256File(afOf(afPath)) === recorded ? "fresh" : "stale", savedAt };
  } catch {
    return { state: "stale", savedAt };
  }
}

/**
 * AI records for a document being saved: matched by its session uuid, the target
 * path and, when it was opened from another file (`fromPath`), that source path
 * and the uuids its manifest lists. `uuids` are the session uuids to remember in
 * `ai.uuids` so a later reopen of the target still finds the records: the current
 * one plus the records' own documents (only the ones this document is known by,
 * when the record touched several). Empty when nothing matched.
 */
function aiEvidence(uuid: string, af: string, cwd: string, fromPath?: string): { count: number; uuids: string[] } {
  const cur = uuid.toUpperCase();
  const known = new Set([cur, ...readAiUuids(af)]);
  const lookups = [recordsFor(uuid, cwd, { docPath: af })];
  if (typeof fromPath === "string" && fromPath.trim() !== "" && resolve(cwd, fromPath) !== resolve(cwd, af)) {
    for (const u of readAiUuids(resolve(cwd, fromPath))) known.add(u);
    lookups.push(recordsFor(uuid, cwd, { docPath: fromPath }));
  }
  const seen = new Set<string>();
  const found: ProvenanceRecord[] = [];
  for (const r of lookups.flat()) {
    const key = JSON.stringify([r.time, r.script, r.documents]);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(r);
  }
  if (found.length === 0) return { count: 0, uuids: [] };
  const out = new Set([cur]);
  for (const r of found) {
    const docs = r.documents.map((d) => String(d).toUpperCase());
    const own = docs.filter((d) => known.has(d));
    for (const d of own.length > 0 ? own : docs) out.add(d);
  }
  return { count: found.length, uuids: [...out] };
}

function emptyManifest(file: string): Manifest {
  return {
    schema: "affinity-axi/manifest/1",
    file,
    af: { sha256: "", bytes: 0, savedAt: "", tool: toolName() },
    madeBy: null,
    history: [],
    exports: [],
    ai: { generated: false, records: 0, uuids: [] },
    inventory: null,
    notes: [],
  };
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p;

/**
 * A run-log brand ref has its path relative to the run's cwd; in a manifest it is
 * relative to the .af's folder (the way madeBy.script is), so the reader needs no cwd.
 */
function rebaseBrand(b: BrandRef, runCwd: string, af: string): BrandRef {
  const path = relative(dirname(resolve(af)), resolve(runCwd, b.path));
  return { ...b, path: path === "" ? baseName(b.path) : path };
}

/**
 * Called after the .af was written. Rehashes it, folds the run-log records for
 * this session UUID since the previous save into `history`, appends the save
 * entry (`forced: true` for a --force save over a stale file), sets `madeBy`
 * from the first folded run when none is recorded (plus the first brand kit any folded run used), refreshes `ai` from the
 * provenance log (matching by session UUID, by this file's path or by `opts.fromPath`, the file the document was opened from, and keeping every UUID seen in `ai.uuids`) and stores `inventory` (null clears it: a stale snapshot is
 * worse than none). Exports, notes and unknown keys are preserved.
 */
export function recordSave(
  afPath: string,
  uuid: string,
  inventory: Inventory | null,
  cwd: string = process.cwd(),
  opts: { forced?: boolean; fromPath?: string } = {},
): Manifest {
  const af = afOf(afPath);
  const now = new Date().toISOString();
  const base = readManifest(af) ?? emptyManifest(baseName(af));
  const prevSave = [...(base.history ?? [])].reverse().find((h) => h.kind === "save");
  const runs = runsSince(uuid, prevSave?.time ?? "", cwd);

  const history = [...(base.history ?? [])];
  for (const r of runs) {
    history.push({
      time: r.time,
      kind: r.cmd,
      script: r.script,
      scriptSha256: r.scriptSha256,
      args: r.args,
      flags: r.flags,
      outcome: r.outcome,
      ms: r.ms,
      ...(r.brand ? { brand: rebaseBrand(r.brand, r.cwd || cwd, af) } : {}),
    });
  }
  history.push(opts.forced ? { time: now, kind: "save", forced: true } : { time: now, kind: "save" });

  let madeBy = base.madeBy ?? null;
  const first = runs[0];
  const kitRun = runs.find((r) => r.brand);
  const kit = kitRun?.brand ? rebaseBrand(kitRun.brand, kitRun.cwd || cwd, af) : undefined;
  if (!madeBy && first) {
    const script = relative(dirname(resolve(af)), resolve(first.cwd || cwd, first.script));
    madeBy = { script, scriptSha256: first.scriptSha256, args: first.args, flags: first.flags, ...(kit ? { brand: kit } : {}) };
  }

  const { count: aiRecords, uuids: aiUuids } = aiEvidence(uuid, af, cwd, opts.fromPath);
  const prevAi = base.ai ?? { generated: false, records: 0, uuids: [] };
  const uuids = [...new Set([...(prevAi.uuids ?? []), ...aiUuids])];
  const ai = { ...prevAi, generated: prevAi.generated || aiRecords > 0, records: Math.max(prevAi.records, aiRecords), uuids };

  const manifest: Manifest = {
    ...base,
    schema: "affinity-axi/manifest/1",
    file: baseName(af),
    af: { sha256: sha256File(af), bytes: statSync(af).size, savedAt: now, tool: toolName() },
    madeBy,
    history,
    exports: base.exports ?? [],
    ai,
    inventory,
    notes: base.notes ?? [],
  };
  writeManifest(af, manifest);
  return manifest;
}
