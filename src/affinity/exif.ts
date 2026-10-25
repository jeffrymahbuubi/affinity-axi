// exiftool wrapper for embedding AI-disclosure metadata in exported images.
//
// All exiftool calls go through this module so tests can put a fake
// `exiftool` first on PATH. Arguments are passed as an array (no shell).
// Embedding is best-effort: callers fall back to the provenance sidecar.

import { spawnSync } from "node:child_process";
import type { ProvenanceRecord } from "./provenance.js";

const IPTC_BASE = "http://cv.iptc.org/newscodes/digitalsourcetype/";
export const SOURCE_SYNTHETIC = `${IPTC_BASE}trainedAlgorithmicMedia`;
export const SOURCE_COMPOSITE = `${IPTC_BASE}compositeSynthetic`;

const TIMEOUT_MS = 30_000;

/** True when `exiftool -ver` runs and exits 0. */
export function exiftoolAvailable(): boolean {
  const r = spawnSync("exiftool", ["-ver"], { encoding: "utf8", timeout: TIMEOUT_MS });
  return !r.error && r.status === 0;
}

/**
 * IPTC DigitalSourceType for a document's provenance: compositeSynthetic when
 * any logged run used a generative edit (the image mixes captured or drawn
 * content with generated content), else trainedAlgorithmicMedia.
 */
export function sourceTypeFor(records: ProvenanceRecord[]): string {
  const edited = records.some((r) => r.identifiers.some((h) => /edit/i.test(h.identifier)));
  return edited ? SOURCE_COMPOSITE : SOURCE_SYNTHETIC;
}

/** XMP description noting the tool and the date (YYYY-MM-DD, UTC). */
export function describeAi(sourceType: string, now: Date = new Date()): string {
  const how = sourceType === SOURCE_COMPOSITE ? "edited with generative AI (composite)" : "generated with generative AI";
  return `Image ${how}; exported from Affinity by Canva via affinity-axi on ${now.toISOString().slice(0, 10)}.`;
}

export interface EmbedResult {
  ok: boolean;
  error?: string;
}

/**
 * Writes XMP tags ("Group:Name", value) into a PNG, JPEG or WebP, in place, in one exiftool call.
 * `clearXmp` deletes the existing XMP first (`-XMP:all=`); exiftool applies it before the writes.
 * Never clears other groups, so the ICC profile survives.
 */
export function writeXmp(file: string, tags: Array<[string, string]>, opts: { clearXmp?: boolean } = {}): EmbedResult {
  const args = ["-overwrite_original", ...(opts.clearXmp ? ["-XMP:all="] : []), ...tags.map(([k, v]) => `-${k}=${v}`), file];
  const r = spawnSync("exiftool", args, { encoding: "utf8", timeout: TIMEOUT_MS });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    const first = `${r.stderr}${r.stdout}`.split("\n").find((l) => l.trim() !== "") ?? `exit ${r.status}`;
    return { ok: false, error: first.trim() };
  }
  return { ok: true };
}

/** Writes XMP-iptcExt:DigitalSourceType and XMP-dc:Description into a PNG, JPEG or WebP, in place. */
export function embedAiMetadata(file: string, sourceType: string, description: string): EmbedResult {
  return writeXmp(file, [
    ["XMP-iptcExt:DigitalSourceType", sourceType],
    ["XMP-dc:Description", description],
  ]);
}
