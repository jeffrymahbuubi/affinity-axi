// Asset manifest: <file>.af.axi.json beside the .af. It is a cache of what the
// tool knows about the file, bound to the file's bytes by sha256: the user
// hand-edits .af files, so a hash mismatch means "stale" and the file wins.
//
// `recordSave` is the only writer of af.sha256, history folding and madeBy;
// other commands read the manifest and write only their own field (exports,
// notes, an `open` history entry) through readManifest/writeManifest.
// Functions taking `afPath` also accept the manifest path itself.
//
// Stored form: the file is meant to be committed and read on other machines, so it
// holds no home folder. Script and kit paths are relative to the manifest's folder
// (`../` allowed), else `~/...`, else absolute; exports and inventory.doc.path are
// stored the same way and read back absolute; every other string is scrubbed of the
// home path. See portable.ts for the encoding rules.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readAiUuids } from "./manifest-ai.js";
import { toPosix } from "./paths.js";
import { resolveStored, scrubHome, storedPath } from "./portable.js";
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

/** The folder a manifest lives in: the base of every stored relative path. */
const dirOf = (afPath: string): string => dirname(resolve(manifestPath(afPath)));

/** The in-memory shape: exports[].path and inventory.doc.path absolute again; the rest as stored. */
function decode(m: Manifest, dir: string, home: string): Manifest {
  const out: Manifest = { ...m };
  out.exports = m.exports.map((e) => (typeof e?.path === "string" ? { ...e, path: resolveStored(e.path, dir, home) } : e));
  if (m.inventory?.doc && typeof m.inventory.doc.path === "string") {
    out.inventory = { ...m.inventory, doc: { ...m.inventory.doc, path: resolveStored(m.inventory.doc.path, dir, home) } };
  }
  return out;
}

/** The manifest (always fully shaped, see normaliseManifest), or null when absent, unparseable or not an object. */
export function readManifest(afPath: string): Manifest | null {
  const file = manifestPath(afPath);
  if (!existsSync(file)) return null;
  try {
    const m: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObj(m) ? decode(normaliseManifest(m, afPath), dirOf(afPath), homedir()) : null;
  } catch {
    return null;
  }
}

const posixBrand = (b: BrandRef | undefined): BrandRef | undefined => (b && typeof b.path === "string" ? { ...b, path: toPosix(b.path) } : b);

/**
 * The manifest as it is stored: every path field that comes from a run (madeBy.script,
 * history[].script and the brand paths) uses "/", so the file reads back on any OS.
 * Pure: returns a copy; unknown keys, exports, inventory and notes pass through.
 */
export function portable(manifest: Manifest): Manifest {
  const out: Manifest = { ...manifest };
  const m = manifest.madeBy;
  if (m) {
    const brand = posixBrand(m.brand);
    out.madeBy = { ...m, script: typeof m.script === "string" ? toPosix(m.script) : m.script, ...(brand ? { brand } : {}) };
  }
  if (Array.isArray(manifest.history)) {
    out.history = manifest.history.map((h) => {
      const brand = posixBrand(h.brand);
      return { ...h, ...(typeof h.script === "string" ? { script: toPosix(h.script) } : {}), ...(brand ? { brand } : {}) };
    });
  }
  return out;
}

/**
 * portable(manifest), then every path field in its stored form (see the header), then the
 * home folder scrubbed out of every string. Pure and idempotent: storing a stored manifest
 * changes nothing. `dir` is the manifest's folder.
 */
export function stored(manifest: Manifest, dir: string, home: string = homedir()): Manifest {
  const out = portable(manifest);
  const enc = (v: string): string => storedPath(resolveStored(v, dir, home), dir, home);
  const brand = (b: BrandRef | undefined): BrandRef | undefined => (b && typeof b.path === "string" ? { ...b, path: enc(b.path) } : b);
  if (out.madeBy) {
    const b = brand(out.madeBy.brand);
    out.madeBy = { ...out.madeBy, ...(typeof out.madeBy.script === "string" ? { script: enc(out.madeBy.script) } : {}), ...(b ? { brand: b } : {}) };
  }
  if (Array.isArray(out.history)) {
    out.history = out.history.map((h) => {
      const b = brand(h.brand);
      return { ...h, ...(typeof h.script === "string" ? { script: enc(h.script) } : {}), ...(b ? { brand: b } : {}) };
    });
  }
  if (Array.isArray(out.exports)) out.exports = out.exports.map((e) => (typeof e?.path === "string" ? { ...e, path: enc(e.path) } : e));
  if (out.inventory?.doc && typeof out.inventory.doc.path === "string") {
    out.inventory = { ...out.inventory, doc: { ...out.inventory.doc, path: enc(out.inventory.doc.path) } };
  }
  return scrubHome(out, home);
}

/** Two-space JSON of stored(...), written to a temp file then renamed so readers never see a torn manifest. */
export function writeManifest(afPath: string, manifest: Manifest, home: string = homedir()): string {
  const file = manifestPath(afPath);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored(manifest, dirOf(afPath), home), null, 2) + "\n");
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
 * The kit of a run as a manifest stores it. A run-log brand ref has its path relative to the
 * run's cwd (or "~/..."); in a manifest it is relative to the .af's folder (the way madeBy.script
 * is), `~/...` or absolute, so the reader needs no cwd.
 */
export function brandFor(ref: BrandRef, afPath: string, cwd: string = process.cwd(), home: string = homedir()): BrandRef {
  const path = storedPath(resolveStored(ref.path, cwd, home), dirOf(afPath), home);
  return { ...ref, path: path === "" || path === "." ? baseName(ref.path) : path };
}

/** A run's script as a manifest stores it; template scripts ("templates/<name>") keep the name as logged. */
function scriptFor(r: { cmd: string; script: string; cwd: string }, af: string, cwd: string, home: string): string {
  if (r.cmd === "templates" || r.script === "") return r.script;
  return storedPath(resolve(r.cwd || cwd, r.script), dirOf(af), home);
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
  opts: { forced?: boolean; fromPath?: string; home?: string } = {},
): Manifest {
  const af = afOf(afPath);
  const home = opts.home ?? homedir();
  const now = new Date().toISOString();
  const base = readManifest(af) ?? emptyManifest(baseName(af));
  const prevSave = [...(base.history ?? [])].reverse().find((h) => h.kind === "save");
  const runs = runsSince(uuid, prevSave?.time ?? "", cwd);

  const history = [...(base.history ?? [])];
  for (const r of runs) {
    history.push({
      time: r.time,
      kind: r.cmd,
      script: scriptFor(r, af, cwd, home),
      scriptSha256: r.scriptSha256,
      args: r.args,
      flags: r.flags,
      outcome: r.outcome,
      ms: r.ms,
      ...(r.brand ? { brand: brandFor(r.brand, af, r.cwd || cwd, home) } : {}),
    });
  }
  history.push(opts.forced ? { time: now, kind: "save", forced: true } : { time: now, kind: "save" });

  let madeBy = base.madeBy ?? null;
  const first = runs[0];
  const kitRun = runs.find((r) => r.brand);
  const kit = kitRun?.brand ? brandFor(kitRun.brand, af, kitRun.cwd || cwd, home) : undefined;
  if (!madeBy && first) {
    const script = scriptFor(first, af, cwd, home);
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
  writeManifest(af, manifest, home);
  return readManifest(af) ?? manifest;
}
