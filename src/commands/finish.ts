// Shared helpers for finishing a document in `run`, `batch` and `doc`: the uuid a script reported, the
// throwaway-save discard (the SDK has no discard: saveAs a throwaway file, close, delete it), the export
// target checks and a one-document export with an optional width. Nothing here decides ownership.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { EXPORT_AREA, imageSize, targetSize } from "../affinity/export-area.js";
import { extFor } from "../affinity/fill-script.js";
import { finalizeFile, metadataNote, type MetaOutcome } from "../affinity/metadata.js";
import { requireVisible, shown } from "../affinity/paths.js";
import { LIST_PRESETS } from "../affinity/scripts.js";
import type { BrandKit } from "../affinity/brand.js";
import type { BrandRef } from "../affinity/manifest-types.js";
import { AxiError, UsageError } from "../output/errors.js";
import { TransportError } from "../mcp/client.js";
import type { AffinityClient } from "../mcp/types.js";
import { exportDoc, type ExportEntry } from "./fill-export.js";
import { DOC_CLOSE, DOC_SAVE } from "./doc.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const UUID_RE = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/;

/** The document UUID a script reported: a `{"uuid":...}` line from the end first, else the first UUID in the output. Upper-case. */
export function reportedUuid(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof v === "string" && UUID_RE.test(v)) return v.toUpperCase();
    } catch {
      // not JSON
    }
  }
  return UUID_RE.exec(text)?.[0].toUpperCase();
}

/** The throwaway file a discard saves to: `<desktop>/affinity-axi-discard-<8 hex>.af`. */
export function discardPath(desktop: string, uuid: string): string {
  return join(desktop, `affinity-axi-discard-${uuid.slice(0, 8).toUpperCase()}.af`);
}

export type DiscardResult =
  | { status: "closed" }
  | { status: "discarded"; leftover?: string }
  | { status: "missing" }
  | { status: "failed"; message: string; leftover?: string };

function tryDelete(path: string): boolean {
  try {
    rmSync(path, { force: true });
  } catch {
    // reported through existsSync below
  }
  return !existsSync(path);
}

/**
 * Drops a document without keeping it: DOC_CLOSE; when it is dirty, save a throwaway copy on the
 * Desktop, close, delete the copy. Does not check ownership (the caller does). A TransportError propagates.
 */
export async function discardDoc(client: AffinityClient, desktop: string, uuid: string): Promise<DiscardResult> {
  const call = async <T>(script: string, what: string): Promise<T> => {
    try {
      return await callJson<T>(client, script, what);
    } catch (err) {
      if (err instanceof TransportError || !(err instanceof AxiError)) throw err;
      throw new DiscardFailure(err.message);
    }
  };
  let tmp: string | undefined;
  try {
    const first = await call<{ status: string }>(DOC_CLOSE(uuid), "closing the document");
    if (first.status === "closed") return { status: "closed" };
    if (first.status === "missing") return { status: "missing" };
    if (first.status !== "dirty") return { status: "failed", message: `the document did not close (${first.status}); check Affinity for a dialog` };
    tmp = discardPath(desktop, uuid);
    tryDelete(tmp);
    const saved = await call<{ status: string; dirty?: boolean }>(DOC_SAVE(uuid, tmp), "saving a throwaway copy");
    if (saved.status === "missing") return { status: "missing" };
    if (saved.dirty === true || !existsSync(tmp)) {
      const left = existsSync(tmp) ? { leftover: tmp } : {};
      return { status: "failed", message: `could not save a throwaway copy to ${shown(tmp)}; the document is still open`, ...left };
    }
    const second = await call<{ status: string }>(DOC_CLOSE(uuid), "closing the document");
    if (second.status === "closed") return tryDelete(tmp) ? { status: "discarded" } : { status: "discarded", leftover: tmp };
    return { status: "failed", message: `saved a throwaway copy but the document did not close (${second.status}); check Affinity for a dialog`, leftover: tmp };
  } catch (err) {
    if (!(err instanceof DiscardFailure)) throw err;
    return { status: "failed", message: err.message, ...(tmp !== undefined && existsSync(tmp) ? { leftover: tmp } : {}) };
  }
}

class DiscardFailure extends Error {}

/** Lists the live presets and returns them; an unknown name is a UsageError with the closest matches (as `fill --export`). */
export async function requirePreset(client: AffinityClient, preset: string): Promise<string[]> {
  const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
  if (!presets.includes(preset)) {
    const q = preset.toLowerCase();
    const near = presets.filter((p) => p.toLowerCase().includes(q));
    throw new UsageError(`unknown export preset '${preset}'`, `${near.length > 0 ? `closest: ${near.join(", ")}; ` : ""}run '${BIN} presets' to list all names`);
  }
  return presets;
}

const same = (a: string, b: string): boolean => a === b || (a === "jpg" && b === "jpeg") || (a === "jpeg" && b === "jpg");

/** Offline checks of an export target: visible path, a known preset type, a matching extension, --width only for raster types. */
export function checkExportTarget(preset: string, path: string, width: number | undefined): void {
  requireVisible(path, "--out");
  const want = extFor(preset);
  if (want === undefined) {
    throw new UsageError(`cannot tell the file type of preset '${preset}'`, `run '${BIN} presets' and pick a PNG, JPEG, WebP, SVG or PDF preset`);
  }
  const got = extname(path).slice(1).toLowerCase();
  if (!same(got, want)) {
    throw new UsageError(`--out must end in .${want} for preset '${preset}': ${shown(path)}`, "rename the file, or pick the preset that writes that type");
  }
  if (width !== undefined && !["png", "jpg", "jpeg", "webp"].includes(want)) {
    throw new UsageError("--width needs a PNG, JPEG or WebP export", "drop --width, or use a raster preset");
  }
}

export interface ExportToOptions {
  preset: string;
  path: string;
  width?: number;
  timeoutMs: number;
  brand?: { kit: BrandKit; ref: BrandRef };
}

export interface ExportToResult {
  path: string;
  bytes: number;
  size: string;
  entry: ExportEntry;
  note: string;
  metaNote: string | null;
}

const sizeText = (path: string): string => {
  const dim = imageSize(readFileSync(path));
  return dim ? `${dim.width}x${dim.height}` : "";
};

/** Exports the whole document to one file; with `width`, re-exports at that width when the natural size differs. */
export async function exportTo(client: AffinityClient, uuid: string, o: ExportToOptions): Promise<ExportToResult> {
  const ext = extname(o.path).slice(1);
  const key = basename(o.path, extname(o.path));
  const done = await exportDoc(
    { client, outDir: dirname(o.path), timeoutMs: o.timeoutMs, preset: o.preset, ext, allBoards: false, brand: o.brand, budget: undefined },
    uuid,
    key,
  );
  let metaNote = done.metaNote;
  if (o.width !== undefined) {
    const natural = imageSize(readFileSync(o.path));
    if (!natural) throw new AxiError(`cannot read the pixel size of ${shown(o.path)}`, "--width supports PNG, JPEG and WebP presets only");
    const want = targetSize(natural, { width: o.width });
    if (want.width !== natural.width || want.height !== natural.height) {
      await callJson<{ exported: string }>(client, EXPORT_AREA(uuid, o.preset, o.path, null, want), `export of ${basename(o.path)} at ${want.width} px`, { timeoutMs: o.timeoutMs });
      if (!existsSync(o.path)) throw new AxiError(`export reported success but ${shown(o.path)} was not written`, "check the folder and preset");
      const outcome: MetaOutcome = finalizeFile(o.path, { credit: o.brand?.kit.credit });
      metaNote = metadataNote([outcome]);
    }
  }
  const bytes = readFileSync(o.path).length;
  const size = sizeText(o.path);
  return {
    path: o.path,
    bytes,
    size,
    entry: { path: o.path, preset: o.preset, size },
    note: o.width === undefined ? `exported ${basename(o.path)}` : `exported ${basename(o.path)} (${size})`,
    metaNote,
  };
}
