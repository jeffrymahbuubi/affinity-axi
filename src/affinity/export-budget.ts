// File-size budget for `export --max-kb`. A pure ladder (which preset and size
// to try next) plus a loop that stops at the first file at or under the budget.
//
// The SDK has no numeric export quality, so the preset families are the only
// quality axis: JPEG Best > High > Medium > Low, WebP lossy the same, WebP
// lossless smallest then the lossy ladder from High, PNG then PNG-8 (dithered).
// Once the lowest preset is reached the size steps down (0.9 ... 0.5 of the
// requested size, never below --min-scale). Ladder presets that this Affinity
// install does not list (localized names) are skipped.

import type { Parsed } from "../cli/args.js";
import { UsageError } from "../output/errors.js";
import type { Dim } from "./export-area.js";

export interface Step {
  preset: string;
  /** Fraction of the requested size; 1 first. */
  scale: number;
}

export interface Attempt {
  preset: string;
  size: string;
  bytes: number;
  fit: boolean;
}

export const MAX_KB_FLAG = {
  name: "max-kb",
  type: "string",
  description: "largest file size in KB; steps JPEG/WebP/PNG presets down, then size (to --min-scale)",
} as const;

export const MIN_SCALE_FLAG = {
  name: "min-scale",
  type: "string",
  description: "smallest size step for --max-kb as a fraction of the requested size (default 0.5)",
} as const;

export const DEFAULT_MIN_SCALE = 0.5;
const SIZE_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5];
const MAX_KB = 10_000_000;

const JPEG_LADDER = ["JPEG (Best quality)", "JPEG (High quality)", "JPEG (Medium quality)", "JPEG (Low quality)"];
const WEBP_LADDER = ["WebP (Best Quality)", "WebP (High Quality)", "WebP (Medium Quality)", "WebP (Low Quality)"];
const WEBP_LOSSLESS = "WebP (Lossless, smallest)";
const PNG_LADDER = ["PNG", "PNG-8 (dithered)"];

const lc = (s: string): string => s.toLowerCase();

export interface Budget {
  /** Budget in bytes (KB = 1024 bytes). */
  bytes: number;
  kb: number;
  minScale: number;
}

/** Validates --max-kb and --min-scale before any connection. Null when no budget was asked for. */
export function budgetFor(parsed: Parsed): Budget | null {
  const rawKb = parsed.flags["max-kb"];
  const rawMin = parsed.flags["min-scale"];
  if (rawKb === undefined) {
    if (rawMin !== undefined) throw new UsageError("--min-scale needs --max-kb", "add --max-kb <n>, or drop --min-scale");
    return null;
  }
  const kbText = String(rawKb);
  if (!/^[1-9]\d*$/.test(kbText) || Number(kbText) > MAX_KB) {
    throw new UsageError(`invalid --max-kb '${kbText}'`, "use a whole number of KB (1 KB = 1024 bytes), e.g. --max-kb 150");
  }
  let minScale = DEFAULT_MIN_SCALE;
  if (rawMin !== undefined) {
    const s = String(rawMin);
    const n = Number(s);
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s) || n < 0.1 || n > 1) {
      throw new UsageError(`invalid --min-scale '${s}'`, "use a fraction from 0.1 to 1, e.g. --min-scale 0.7");
    }
    minScale = n;
  }
  const kb = Number(kbText);
  return { bytes: kb * 1024, kb, minScale };
}

type Family = "jpeg" | "webp" | "webp-lossless" | "png";

function familyOf(preset: string): Family | null {
  if (preset.startsWith("JPEG (")) return "jpeg";
  if (preset.startsWith("WebP (Lossless")) return "webp-lossless";
  if (preset.startsWith("WebP (")) return "webp";
  if (preset.startsWith("PNG")) return "png";
  return null;
}

/** True for the JPEG, WebP and PNG preset families (the only ones --max-kb can step). */
export function isRasterPreset(preset: string): boolean {
  return familyOf(preset) !== null;
}

function notRaster(preset: string): UsageError {
  return new UsageError(
    `--max-kb needs a JPEG, WebP or PNG preset, got '${preset}'`,
    "vector and PDF presets have no quality steps; pick e.g. 'JPEG (High quality)' or 'WebP (High Quality)'",
  );
}

/** The quality ladder of the requested preset, best first, from the requested one down (unfiltered). */
function qualityChain(preset: string): string[] {
  const from = (ladder: string[]): string[] => {
    const i = ladder.findIndex((n) => lc(n) === lc(preset));
    return i >= 0 ? ladder.slice(i) : [preset];
  };
  switch (familyOf(preset)) {
    case "jpeg":
      return from(JPEG_LADDER);
    case "webp":
      return from(WEBP_LADDER);
    case "webp-lossless":
      // Lossless has one smaller step; after that only lossy WebP gets smaller.
      return [preset, ...(lc(preset) === lc(WEBP_LOSSLESS) ? [] : [WEBP_LOSSLESS]), ...WEBP_LADDER.slice(1)];
    case "png":
      return from(PNG_LADDER);
    default:
      throw notRaster(preset);
  }
}

/**
 * Presets then sizes to try, in order. The requested preset at scale 1 comes
 * first; ladder presets missing from `live` are skipped; then the lowest
 * preset repeats at 0.9, 0.8 ... down to `minScale`. Throws a UsageError for
 * a preset that is not JPEG, WebP or PNG.
 */
export function ladderFor(preset: string, live: string[], minScale: number): Step[] {
  const names = new Map(live.map((n) => [lc(n), n]));
  const chain = qualityChain(preset).flatMap((n, i) => {
    const hit = i === 0 ? preset : names.get(lc(n));
    return hit === undefined ? [] : [hit];
  });
  const steps: Step[] = chain.map((p) => ({ preset: p, scale: 1 }));
  const last = chain[chain.length - 1]!;
  for (const s of SIZE_STEPS) if (s >= minScale - 1e-9) steps.push({ preset: last, scale: s });
  return steps;
}

/** One line when the final preset changed format (lossless to lossy, PNG to a palette), else null. */
export function formatChange(requested: string, final: string): string | null {
  const a = familyOf(requested);
  const b = familyOf(final);
  if (a === "webp-lossless" && b === "webp") return `${requested} stepped to lossy WebP (${final})`;
  if (a === "png" && lc(requested) !== lc(final) && lc(final).startsWith("png-8")) return `PNG stepped to an 8-bit palette (${final})`;
  return null;
}

/** Runs the attempts in order and stops at the first result at or under the budget. */
export async function fitBudget(
  steps: Step[],
  budgetBytes: number,
  attempt: (s: Step) => Promise<{ bytes: number; size: string }>,
): Promise<{ attempts: Attempt[]; fit: Attempt | null }> {
  const attempts: Attempt[] = [];
  for (const s of steps) {
    const r = await attempt(s);
    const a: Attempt = { preset: s.preset, size: r.size, bytes: r.bytes, fit: r.bytes <= budgetBytes };
    attempts.push(a);
    if (a.fit) return { attempts, fit: a };
  }
  return { attempts, fit: null };
}

/** Pixel size of a step: the requested size times the step's scale (at least 1 px per side). */
export function scaledDim(base: Dim, scale: number): Dim {
  const r = (n: number): number => Math.max(1, Math.round(n * scale));
  return { width: r(base.width), height: r(base.height) };
}

/** `cannot fit <path> under <n> KB (smallest <k> KB at <preset> <size>)` for the last (smallest) attempt. */
export function noFitMessage(path: string, kb: number, last: Attempt): string {
  return `cannot fit ${path} under ${kb} KB (smallest ${(last.bytes / 1024).toFixed(1)} KB at ${last.preset} ${last.size})`;
}

export const NO_FIT_SUGGESTION = "raise --max-kb, lower --min-scale, or simplify the artwork (fewer gradients and photos)";
