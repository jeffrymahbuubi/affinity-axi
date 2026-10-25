// Export metadata: strips the XMP Affinity stamps into raster exports (account
// name as dc:creator, history, dates) and optionally writes our credit and the
// AI label, at file level after Affinity wrote the file. PNG: every text chunk
// dropped in pure Node (iCCP, pHYs, IDAT copied verbatim). JPEG: the APP1 Exif,
// APP1 XMP, APP13 Photoshop/IPTC and COM segments dropped in pure Node (JFIF,
// ICC and everything from SOS on copied verbatim). WebP: `exiftool -XMP:all=`
// only when an XMP packet exists. TIFF: exiftool deletes EXIF Artist/Copyright,
// IPTC By-line/CopyrightNotice and XMP (no exiftool: left untouched, error).
// Credit and AI tags go in one exiftool call. Never `-all=` (keeps ICC).
// Nothing here throws.

import { readFileSync, writeFileSync } from "node:fs";
import type { Parsed } from "../cli/args.js";
import { UsageError } from "../output/errors.js";
import type { BrandKit } from "./brand.js";
import { describeAi, exiftoolAvailable, sourceTypeFor, writeXmp } from "./exif.js";
import { imageKind } from "./export-area.js";
import { recordsFor, writeSidecar } from "./provenance.js";

export interface Credit { creator: string; copyright?: string }
export interface MetaSpec {
  credit?: Credit;
  ai?: { sourceType: string; description: string };
  keep?: boolean;
}
export type MetaTag = "creator" | "copyright" | "iptc";
export interface MetaOutcome {
  kind: "png" | "jpeg" | "webp" | "tiff" | null;
  stripped: "chunks" | "segments" | "exiftool" | "none" | "kept";
  embedded: MetaTag[];
  skipped: MetaTag[];
  error?: string;
}

export const CREATOR_FLAG = { name: "creator", type: "string" as const, description: "credit to embed as XMP dc:Creator (default: the brand kit's credit.creator); needs exiftool" };
export const COPYRIGHT_FLAG = { name: "copyright", type: "string" as const, description: "rights text to embed as XMP dc:Rights with the copyright flag set (needs --creator or a kit creator)" };
export const KEEP_FLAG = { name: "keep-metadata", type: "boolean" as const, description: "keep the metadata Affinity writes (XMP: account name, history, dates; in JPEG also EXIF and IPTC); default strips it" };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXT_CHUNKS = new Set(["tEXt", "zTXt", "iTXt"]);
const NOT_FOUND = "exiftool not found";
const UNSUPPORTED = "format not supported for embedding";
const BAD_PNG = "not a well-formed PNG";
const BAD_JPEG = "not a well-formed JPEG";
// Identity fields exiftool deletes from a TIFF (an empty value deletes the tag); ICC is not touched.
const TIFF_WIPE: Array<[string, string]> = [["EXIF:Artist", ""], ["EXIF:Copyright", ""], ["IPTC:By-line", ""], ["IPTC:CopyrightNotice", ""]];

/**
 * Drops every tEXt, zTXt and iTXt chunk and copies all others verbatim (no re-encode, CRCs untouched).
 * Null when the chunk walk fails (a length runs past the end, or bytes are left over mid-chunk).
 * A file that ends exactly on a chunk boundary without IEND is accepted as is.
 */
export function stripPngText(buf: Buffer): { buf: Buffer; removed: number } | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const keep: Buffer[] = [PNG_SIG];
  let removed = 0;
  let pos = 8;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) return null;
    const end = pos + 12 + buf.readUInt32BE(pos);
    if (end > buf.length) return null;
    const type = buf.toString("latin1", pos + 4, pos + 8);
    if (TEXT_CHUNKS.has(type)) removed++;
    else keep.push(buf.subarray(pos, end));
    pos = end;
    if (type === "IEND") {
      keep.push(buf.subarray(pos));
      break;
    }
  }
  return removed === 0 ? { buf, removed } : { buf: Buffer.concat(keep), removed };
}

const startsWith = (buf: Buffer, at: number, text: string): boolean => buf.toString("latin1", at, at + text.length) === text;

/**
 * Drops the APP1 Exif, APP1 XMP (+ extension), APP13 Photoshop/IPTC and COM segments of a JPEG;
 * every other segment and everything from SOS (0xFFDA) on is copied verbatim.
 * Null when the walk fails (no 0xFF where a marker is due, or a length past the end).
 * `removed === 0` returns the input buffer itself (same contract as stripPngText).
 */
export function stripJpegSegments(buf: Buffer): { buf: Buffer; removed: number } | null {
  if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const keep: Buffer[] = [buf.subarray(0, 2)];
  let removed = 0;
  let pos = 2;
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return null;
    let p = pos;
    while (p < buf.length && buf[p] === 0xff) p++; // padding bytes
    if (p >= buf.length) return null;
    const m = buf[p]!;
    if (m === 0x00) return null;
    if (m === 0xda || m === 0xd9) {
      keep.push(buf.subarray(pos));
      break;
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      keep.push(buf.subarray(pos, p + 1));
      pos = p + 1;
      continue;
    }
    if (p + 3 > buf.length) return null;
    const len = buf.readUInt16BE(p + 1);
    const end = p + 1 + len;
    if (len < 2 || end > buf.length) return null;
    const at = p + 3; // first payload byte
    const drop =
      (m === 0xe1 && (startsWith(buf, at, "Exif\0") || startsWith(buf, at, "http://ns.adobe.com/xap/1.0/\0") || startsWith(buf, at, "http://ns.adobe.com/xmp/extension/\0"))) ||
      (m === 0xed && startsWith(buf, at, "Photoshop 3.0\0")) ||
      m === 0xfe;
    if (drop) removed++;
    else keep.push(buf.subarray(pos, end));
    pos = end;
  }
  return removed === 0 ? { buf, removed } : { buf: Buffer.concat(keep), removed };
}

/** True when the bytes hold an XMP packet. */
export function hasXmp(buf: Buffer): boolean {
  return buf.includes("<x:xmpmeta") || buf.includes("http://ns.adobe.com/xap/1.0/");
}
let probe: { path: string | undefined; ok: boolean } | undefined;
/** exiftoolAvailable(), once per process and PATH value. */
function haveExiftool(): boolean {
  const path = process.env["PATH"];
  if (!probe || probe.path !== path) probe = { path, ok: exiftoolAvailable() };
  return probe.ok;
}

/** Cleans one exported file in place: strip Affinity's XMP, then write the asked-for tags. Synchronous, never throws, idempotent. */
export function finalizeFile(path: string, spec: MetaSpec): MetaOutcome {
  const asked: MetaTag[] = [...(spec.ai ? (["iptc"] as const) : []), ...(spec.credit ? (["creator"] as const) : []), ...(spec.credit?.copyright ? (["copyright"] as const) : [])];
  const out: MetaOutcome = { kind: null, stripped: "none", embedded: [], skipped: [] };
  const fail = (error: string): MetaOutcome => ({ ...out, skipped: asked, ...(error !== "" ? { error } : {}) });
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return fail(`cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const kind = imageKind(buf);
  if (kind === null) return fail(asked.length > 0 ? UNSUPPORTED : "");
  out.kind = kind;
  let clear = false; // run exiftool with -XMP:all= (after a PNG or JPEG strip, for idempotence, but only when tags are asked; WebP only with an XMP packet; TIFF always)
  if (spec.keep) out.stripped = "kept";
  else if (kind === "jpeg") {
    const r = stripJpegSegments(buf);
    if (r === null) out.error = BAD_JPEG;
    else if (r.removed > 0) {
      try {
        writeFileSync(path, r.buf);
        out.stripped = "segments";
      } catch (err) {
        out.error = `cannot write: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    clear = true;
  } else if (kind === "png") {
    const r = stripPngText(buf);
    if (r === null) out.error = BAD_PNG;
    else if (r.removed > 0) {
      try {
        writeFileSync(path, r.buf);
        out.stripped = "chunks";
      } catch (err) {
        out.error = `cannot write: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    clear = true;
  } else clear = kind === "tiff" || hasXmp(buf);
  const wipe = !spec.keep && kind === "tiff" ? TIFF_WIPE : [];
  const tags: Array<[string, string]> = [];
  if (spec.ai) tags.push(["XMP-iptcExt:DigitalSourceType", spec.ai.sourceType], ["XMP-dc:Description", spec.ai.description]);
  if (spec.credit) tags.push(["XMP-dc:Creator", spec.credit.creator]);
  if (spec.credit?.copyright) tags.push(["XMP-dc:Rights", spec.credit.copyright], ["XMP-xmpRights:Marked", "true"]);
  const exiftoolStrips = kind === "webp" || kind === "tiff";
  const needsRun = tags.length > 0 || (clear && exiftoolStrips);
  if (!needsRun) return out;
  if (!haveExiftool()) {
    out.error = NOT_FOUND;
    out.skipped = asked;
    return out;
  }
  const w = writeXmp(path, [...wipe, ...tags], { clearXmp: clear });
  if (!w.ok) {
    out.error = w.error ?? "exit";
    out.skipped = asked;
  } else {
    out.embedded = asked;
    if (clear && exiftoolStrips) out.stripped = "exiftool";
  }
  return out;
}

const OWN = new Set([NOT_FOUND, UNSUPPORTED, BAD_PNG, BAD_JPEG]);
const reasonOf = (o: MetaOutcome): string => (OWN.has(o.error ?? "") || o.error?.startsWith("cannot ") ? (o.error ?? "") : `exiftool failed: ${o.error ?? "unknown"}`);

/** The `metadata:` line value, or null when there is nothing to say (strip ok or a no-op, nothing asked). */
export function metadataNote(outcomes: MetaOutcome[]): string | null {
  const parts: string[] = [];
  const has = (o: MetaOutcome, t: MetaTag): boolean => o.embedded.includes(t) || o.skipped.includes(t);
  const ai = outcomes.filter((o) => has(o, "iptc"));
  if (ai.length > 0) {
    const done = ai.filter((o) => o.embedded.includes("iptc")).length;
    if (done === ai.length) parts.push("iptc embedded");
    else if (done === 0) parts.push(`sidecar only (${reasonOf(ai[0]!)})`);
    else parts.push(`iptc embedded in ${done} of ${ai.length} files, others sidecar only`);
  }
  const cr = outcomes.filter((o) => has(o, "creator"));
  if (cr.length > 0) {
    const bad = cr.find((o) => o.skipped.includes("creator"));
    if (bad) parts.push(`creator NOT embedded (${reasonOf(bad)})`);
    else parts.push(cr.some((o) => o.embedded.includes("copyright")) ? "creator and copyright embedded" : "creator embedded");
  }
  if (outcomes.some((o) => o.stripped === "kept")) parts.push("Affinity XMP kept");
  const stuck = outcomes.find((o) => o.kind !== null && o.skipped.length === 0 && o.error !== undefined);
  if (stuck) parts.push(stuck.error === NOT_FOUND ? `${stuck.kind === "tiff" ? "TIFF metadata" : "XMP"} not stripped (exiftool not found)` : `strip skipped (${reasonOf(stuck)})`);
  return parts.length > 0 ? parts.join(", ") : null;
}

/** `--creator` wins over the kit credit (`""` = none); `--copyright` needs a creator. */
export function creditFor(parsed: Parsed, kit: BrandKit | undefined): Credit | undefined {
  const flag = parsed.flags["creator"];
  const rights = parsed.flags["copyright"];
  const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const raw = (kit as { credit?: { creator?: unknown; copyright?: unknown } } | undefined)?.credit;
  const kitCreator = text(raw?.creator);
  const fromKit = kitCreator !== undefined ? { creator: kitCreator, copyright: text(raw?.copyright) } : undefined;
  const base = typeof flag === "string" ? (text(flag) !== undefined ? { creator: text(flag)!, copyright: undefined } : undefined) : fromKit;
  const copyright = typeof rights === "string" ? text(rights) : base?.copyright;
  if (text(rights) !== undefined && base === undefined) {
    throw new UsageError("--copyright needs --creator or a brand kit credit.creator", "pass --creator <name>, or add credit.creator to the brand kit");
  }
  return base === undefined ? undefined : { creator: base.creator, ...(copyright !== undefined ? { copyright } : {}) };
}

/** The AI label for a document with logged generative runs, else undefined. */
export function aiSpecFor(docUuid: string): MetaSpec["ai"] {
  const records = recordsFor(docUuid);
  if (records.length === 0) return undefined;
  const sourceType = sourceTypeFor(records);
  return { sourceType, description: describeAi(sourceType) };
}

/** After an export: AI document -> sidecars plus the note; any document -> the credit/keep note. `done` = finalizeFile outcomes already made with aiSpecFor in the spec (one per path); else files are finalized here. */
export function tagExports(docUuid: string, paths: string[], spec: Omit<MetaSpec, "ai">, done?: MetaOutcome[]): Array<[string, string]> {
  const records = recordsFor(docUuid);
  const outcomes = done ?? paths.map((p) => finalizeFile(p, { ...spec, ai: aiSpecFor(docUuid) }));
  const note = metadataNote(outcomes);
  if (records.length === 0) return note === null ? [] : [["metadata", note]];
  const kv: Array<[string, string]> = [["provenance", "ai-generated"]];
  if (note !== null) kv.push(["metadata", note]);
  const files: string[] = [];
  let firstError: string | undefined;
  for (const p of paths) {
    try {
      files.push(writeSidecar(p, docUuid, records));
    } catch (err) {
      firstError ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (firstError !== undefined) kv.push(["provenance_file", `NOT WRITTEN (${firstError})`]);
  else if (files.length === 1) kv.push(["provenance_file", files[0]!]);
  else kv.push(["provenance_files", String(files.length)]);
  return kv;
}
