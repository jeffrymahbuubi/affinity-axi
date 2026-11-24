// `batch`: the row type, the run context and the pieces of one record that do not need the whole command:
// note helpers, left-open bookkeeping, the out-dir cleanup, provenance, the skip rule and the failed-record discard.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrandKit } from "../affinity/brand.js";
import { finalizeFile, type Credit, type MetaOutcome } from "../affinity/metadata.js";
import { markOwned } from "../affinity/owned.js";
import { appendProvenance, extractUuids, sha256 } from "../affinity/provenance.js";
import type { BrandRef } from "../affinity/manifest-types.js";
import { shown } from "../affinity/paths.js";
import { TransportError } from "../mcp/client.js";
import type { AffinityClient, AiHit } from "../mcp/types.js";
import { discardDoc } from "./finish.js";
import { FatalRecord } from "./fill-parts.js";
import type { DocListing } from "./run.js";

const NOTE_LIMIT = 200;

export interface Row {
  key: string;
  status: "ok" | "failed" | "skipped";
  doc: string;
  ms: number;
  note: string;
}

export const ROW_FIELDS = ["key", "status", "doc", "ms", "note"];

export function oneLine(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > NOTE_LIMIT ? t.slice(0, NOTE_LIMIT - 3) + "..." : t;
}

/** Joins row note parts with "; ", dropping empty ones. */
export function joinNotes(parts: string[]): string {
  return parts.filter((p) => p !== "").join("; ");
}

/** Documents a failed record left behind: not in `known` (upper-cased UUIDs), plus `reported` when it is listed and dirty. */
export function strayDocs(known: ReadonlySet<string>, listing: DocListing | null, reported?: string): DocListing["documents"] {
  if (!listing) return [];
  const rep = reported?.toUpperCase();
  return listing.documents.filter((d) => {
    const id = d.uuid.toUpperCase();
    return !known.has(id) || (rep !== undefined && id === rep && d.dirty);
  });
}

/** `left open: 6681ED67 (unsaved)` | `(unsaved changes in welcome.af)` | `(welcome.af)`. */
export function leftOpenNote(d: { uuid: string; path: string; dirty: boolean }): string {
  const name = d.path === "" ? "" : (d.path.split(/[\\/]/).pop() ?? d.path);
  const what = name === "" ? "unsaved" : d.dirty ? `unsaved changes in ${name}` : name;
  return `left open: ${d.uuid.slice(0, 8).toUpperCase()} (${what})`;
}

/** Raster files in --out-dir finalized so far, and the mtime each had afterwards (a file is not redone until it changes). */
export interface Cleaned {
  n: number;
  seen: Map<string, number>;
}

export interface Ctx {
  flags: string[]; // replayable flags, for the run log
  force: boolean;
  client: AffinityClient;
  source: string; // the template as read (guard-scanned once)
  hits: AiHit[];
  file: string;
  helpers: boolean;
  timeoutMs: number;
  outDir: string | undefined;
  saveDir: string | undefined;
  brand: { kit: BrandKit; ref: BrandRef } | undefined;
  refused: Array<{ key: string; path: string }>; // targets checkOverwrite refused, for the help block
  credit: Credit | undefined; // the kit's credit, embedded into the rasters a template wrote to --out-dir
  cleaned: Cleaned;
  known: Set<string>; // upper-cased UUIDs of documents already open or already accounted for
  leftOpen: string[]; // UUIDs of documents a failed record left open, for the leftOpen: line
  leftClean: Set<string>; // UUIDs (as listed) of left-open documents the listing showed without unsaved changes
  preexisting: ReadonlySet<string>; // upper-cased UUIDs open when the batch started; never changed
  desktop: string | undefined; // the Desktop folder, read when a discard is possible
  exportTo: { preset: string; ext: string; width: number | undefined } | undefined;
  discard: boolean;
  skipExisting: boolean; // --on-exists skip
  exported: number;
  discarded: number;
}

const RASTER_EXT = /\.(png|jpe?g|webp)$/i;

/** Finalizes the rasters at the top level of `dir` written since `since` (ms) and not yet finalized; returns the outcomes. */
export function cleanOutDir(dir: string, since: number, credit: Credit | undefined, seen: Map<string, number>): MetaOutcome[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile() || !RASTER_EXT.test(name) || st.mtimeMs < since - 1000 || seen.get(file) === st.mtimeMs) return [];
      const o = finalizeFile(file, credit ? { credit } : {});
      seen.set(file, statSync(file).mtimeMs);
      return [o];
    } catch {
      return [];
    }
  });
}

/** Provenance for one generative record, with that record's args. */
export function logGenerative(c: Ctx, args: unknown, outcome: string, text: string, current: string | undefined): string | undefined {
  const documents = extractUuids(text);
  if (current && !documents.includes(current)) documents.push(current);
  try {
    appendProvenance({ time: new Date().toISOString(), script: c.file, sha256: sha256(c.source), identifiers: c.hits, args, outcome, documents });
    return undefined;
  } catch (err) {
    return `provenance NOT LOGGED (${err instanceof Error ? err.message : String(err)}); record this run by hand`;
  }
}

/** Records a document this batch created and left open (never one open before the batch started). */
export function ownIfNew(c: Ctx, uuid: string | undefined): void {
  if (uuid !== undefined && !c.preexisting.has(uuid.toUpperCase())) markOwned([uuid], "batch");
}

/** `--on-exists skip`: true when every file this batch would write for the record already exists. */
export function filesExist(c: Ctx, key: string): boolean {
  if (!c.skipExisting) return false;
  const af = c.saveDir === undefined ? true : existsSync(join(c.saveDir, `${key}.af`));
  const exp = c.exportTo === undefined || c.outDir === undefined ? true : existsSync(join(c.outDir, `${key}.${c.exportTo.ext}`));
  return af && exp;
}

/** The export file of a record. */
export function exportPath(c: Ctx, key: string): string {
  return join(c.outDir!, `${key}.${c.exportTo!.ext}`);
}

/** `discardDoc` with a transport failure turned into a fatal record (the state is unknown). */
export async function discardOrFatal(c: Ctx, uuid: string): ReturnType<typeof discardDoc> {
  try {
    return await discardDoc(c.client, c.desktop!, uuid);
  } catch (err) {
    if (err instanceof TransportError || err instanceof Error) throw new FatalRecord(err.message, uuid);
    throw err;
  }
}

/** The note part for a throwaway copy that could not be removed. */
export const leftoverNote = (path: string): string => `delete ${shown(path)}: the throwaway copy could not be removed`;

/**
 * F9: drops the unsaved documents a failed record created (strays that were not open before the batch and have no
 * path). Returns the row note parts and records the rest as left open. Without `--discard` it only records them.
 */
export async function handleStrays(c: Ctx, strays: DocListing["documents"]): Promise<string[]> {
  const notes: string[] = [];
  const dropped: string[] = [];
  const failures: string[] = [];
  for (const d of strays) {
    c.known.add(d.uuid.toUpperCase());
    const eligible = c.discard && d.path === "" && !c.preexisting.has(d.uuid.toUpperCase());
    if (eligible) {
      const res = await discardOrFatal(c, d.uuid);
      if (res.status !== "failed") {
        dropped.push(d.uuid.slice(0, 8).toUpperCase());
        c.discarded++;
        if (res.status === "discarded" && res.leftover) failures.push(leftoverNote(res.leftover));
        continue;
      }
      failures.push(`discard failed: ${res.message}`);
    }
    c.leftOpen.push(d.uuid);
    if (!d.dirty) c.leftClean.add(d.uuid);
    ownIfNew(c, d.uuid);
    notes.push(leftOpenNote(d));
  }
  if (dropped.length > 0) notes.unshift(`discarded after failure: ${dropped.join(" ")}`);
  return [...notes, ...failures];
}
