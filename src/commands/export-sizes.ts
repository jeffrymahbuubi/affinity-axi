// Pure support for `export --sizes`, `--densities`, `--base` and `--safe-zone`:
// flag specs, validation before any connection, path expansion and the report.
// No connection and no disk access.

import { extname } from "node:path";
import type { Parsed } from "../cli/args.js";
import type { FlagSpec } from "../cli/spec.js";
import { MAX_SIDE } from "../affinity/export-area.js";
import type { SafeResult } from "../affinity/png-alpha.js";
import { shown } from "../affinity/paths.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList } from "../output/toon.js";
import { altText, type Plan, type Target, type Written } from "./export-parts.js";

export const DENSITIES: ReadonlyArray<{ key: string; factor: number }> = [
  { key: "ldpi", factor: 0.75 },
  { key: "mdpi", factor: 1 },
  { key: "hdpi", factor: 1.5 },
  { key: "xhdpi", factor: 2 },
  { key: "xxhdpi", factor: 3 },
  { key: "xxxhdpi", factor: 4 },
];

export const SAFE_CIRCLES: Readonly<Record<string, number>> = { "android-adaptive": 66 / 108, "pwa-maskable": 0.8 };

export const SIZES_FLAG: FlagSpec = {
  name: "sizes",
  type: "string",
  description: "comma-separated pixel sizes, one file each, the longer side fitted like --square; the path needs {size}",
};
export const DENSITIES_FLAG: FlagSpec = {
  name: "densities",
  type: "string",
  description:
    "comma-separated Android densities (ldpi, mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi), one file each at --base times the density factor; the path needs {density}",
};
export const BASE_FLAG: FlagSpec = {
  name: "base",
  type: "string",
  description: "size in dp at mdpi for --densities (default 48, the launcher icon; 108 for an adaptive layer)",
};
export const SAFE_ZONE_FLAG: FlagSpec = {
  name: "safe-zone",
  type: "string",
  description:
    "after a PNG export, check that every painted pixel is inside a centred circle: android-adaptive, pwa-maskable or a fraction of the shorter side (0-1); exit 1 when outside",
};

export interface SizeItem {
  px: number;
  density?: string;
}
export interface SizePlan {
  kind: "sizes" | "densities";
  items: SizeItem[];
  base?: number;
}
export interface SizedTarget extends Target {
  px: number;
  density?: string;
}

const RASTER_EXTS = [".png", ".jpg", ".jpeg", ".webp"];
const MAX_ENTRIES = 12;
const DEFAULT_BASE = 48;
const MAX_BASE = 4096;
const WHOLE = /^\d+$/;

function entries(raw: string, flag: string, hint: string): string[] {
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.length < 1 || parts.length > MAX_ENTRIES || parts.some((p) => p === "")) {
    throw new UsageError(`invalid --${flag} '${raw}'`, hint);
  }
  return parts;
}

function parseSizes(raw: string): SizeItem[] {
  const hint = `list 1 to ${MAX_ENTRIES} different whole pixel sizes from 1 to ${MAX_SIDE}, e.g. --sizes 192,512`;
  const parts = entries(raw, "sizes", hint);
  const px = parts.map((p) => (WHOLE.test(p) ? Number(p) : NaN));
  if (px.some((n) => !(n >= 1 && n <= MAX_SIDE)) || new Set(px).size !== px.length) {
    throw new UsageError(`invalid --sizes '${raw}'`, hint);
  }
  return px.map((n) => ({ px: n }));
}

function parseBase(parsed: Parsed): number {
  const raw = parsed.flags["base"];
  if (raw === undefined) return DEFAULT_BASE;
  const s = String(raw);
  if (!WHOLE.test(s) || Number(s) < 1 || Number(s) > MAX_BASE) {
    throw new UsageError(`invalid --base '${s}'`, `use a whole number of dp from 1 to ${MAX_BASE}, e.g. --base 48`);
  }
  return Number(s);
}

/** Replaces {size} and {density} in a path template for one item. */
function expand(template: string, item: SizeItem): string {
  return template.split("{size}").join(String(item.px)).split("{density}").join(item.density ?? "");
}

/** A path with the size placeholders filled in, for checks that need a real path before connecting. */
export function probePath(template: string): string {
  return template.split("{size}").join("1").split("{density}").join("mdpi");
}

/** Validates --sizes, --densities and --base (no connection needed). Null when neither plan flag was given. */
export function parseSizePlan(parsed: Parsed, rawPath: string): SizePlan | null {
  const f = parsed.flags;
  const sizesRaw = f["sizes"] === undefined ? undefined : String(f["sizes"]);
  const densRaw = f["densities"] === undefined ? undefined : String(f["densities"]);
  if (sizesRaw === undefined && densRaw === undefined) {
    if (f["base"] !== undefined) throw new UsageError("--base needs --densities", "add --densities, e.g. --densities mdpi,xhdpi --base 48");
    if (rawPath.includes("{size}")) throw new UsageError("{size} in the path needs --sizes or --densities", "remove {size} or add --sizes 192,512");
    if (rawPath.includes("{density}")) throw new UsageError("{density} in the path needs --densities", "remove {density} or add --densities mdpi,xhdpi");
    return null;
  }
  if (sizesRaw !== undefined && densRaw !== undefined) {
    throw new UsageError("--sizes and --densities are mutually exclusive", "pick one: pixel sizes or Android densities");
  }
  if (["width", "height", "scale", "square"].some((k) => f[k] !== undefined)) {
    throw new UsageError("--sizes and --densities cannot be combined with --width, --height, --scale or --square", "the size list already decides every size");
  }
  if (f["max-kb"] !== undefined) {
    throw new UsageError("--sizes and --densities cannot be combined with --max-kb", "export without a size list to fit a file budget");
  }
  if (sizesRaw !== undefined && f["base"] !== undefined) throw new UsageError("--base needs --densities", "add --densities, or drop --base");
  let plan: SizePlan;
  if (sizesRaw !== undefined) {
    plan = { kind: "sizes", items: parseSizes(sizesRaw) };
  } else {
    const keys = DENSITIES.map((d) => d.key);
    const hint = `list 1 to ${MAX_ENTRIES} of: ${keys.join(", ")}`;
    const parts = entries(densRaw!, "densities", hint);
    for (const k of parts) {
      if (!keys.includes(k)) throw new UsageError(`unknown density '${k}'`, hint);
    }
    if (new Set(parts).size !== parts.length) throw new UsageError(`invalid --densities '${densRaw!}'`, hint);
    const base = parseBase(parsed);
    const items = parts.map((k) => ({ px: Math.round(base * DENSITIES.find((d) => d.key === k)!.factor), density: k }));
    if (items.some((i) => i.px > MAX_SIDE)) {
      throw new UsageError(`invalid --base '${base}'`, `the largest density must stay within ${MAX_SIDE} px`);
    }
    plan = { kind: "densities", items, base };
  }
  if (plan.kind === "sizes" && !rawPath.includes("{size}")) throw new UsageError("--sizes needs {size} in the path", "e.g. ~/Desktop/icons/icon-{size}.png");
  if (rawPath.includes("{density}") && plan.kind !== "densities") throw new UsageError("{density} in the path needs --densities", "remove {density} or use --densities");
  if (plan.kind === "densities" && new Set(plan.items.map((i) => expand(rawPath, i))).size < plan.items.length) {
    throw new UsageError("--densities needs {density} or {size} in the path", "e.g. ~/Desktop/res/mipmap-{density}/ic_launcher.png");
  }
  if (!RASTER_EXTS.includes(extname(rawPath).toLowerCase())) {
    throw new UsageError(
      `--sizes and --densities need a raster output path (${RASTER_EXTS.join(", ")}), got '${extname(rawPath) || "no extension"}'`,
      "use a PNG, JPEG or WebP preset and file name",
    );
  }
  return plan;
}

/** One target per base target and plan item; the base order stays outside, the items inside. */
export function sizedTargets(base: Target[], plan: SizePlan): SizedTarget[] {
  return base.flatMap((t) => plan.items.map((item) => ({ ...t, path: expand(t.path, item), px: item.px, ...(item.density !== undefined ? { density: item.density } : {}) })));
}

/** Validates --safe-zone (no connection needed). Null when the flag is absent. */
export function parseSafeZone(parsed: Parsed, rawPath: string, all: boolean): { label: string; fraction: number } | null {
  const raw = parsed.flags["safe-zone"];
  if (raw === undefined) return null;
  const s = String(raw).trim();
  let fraction: number;
  if (Object.hasOwn(SAFE_CIRCLES, s)) fraction = SAFE_CIRCLES[s]!;
  else {
    fraction = /^\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
    if (!(fraction > 0 && fraction <= 1)) {
      throw new UsageError(`invalid --safe-zone '${String(raw)}'`, `use ${Object.keys(SAFE_CIRCLES).join(", ")} or a fraction above 0 up to 1, e.g. 0.8`);
    }
  }
  if (extname(rawPath).toLowerCase() !== ".png") throw new UsageError("--safe-zone needs a .png output path", "the check reads the alpha channel of a PNG");
  if (all) throw new UsageError("--safe-zone cannot be combined with --all-artboards", "check one artboard with --artboard <name>");
  return { label: s, fraction };
}

/** The report lines of a safe-zone check. */
export function safePairs(path: string, label: string, r: SafeResult): Array<[string, string]> {
  const fraction = Object.hasOwn(SAFE_CIRCLES, label) ? SAFE_CIRCLES[label]! : Number(label);
  return [
    ["safe_zone", r.ok ? "ok" : "outside"],
    ["safe_circle", `${label} (${fraction.toFixed(3)} of the side)`],
    ["safe_checked", shown(path)],
    ["farthest_px", r.farthest.toFixed(1)],
    ["limit_px", r.limit.toFixed(1)],
    ["farthest_at", r.at ? `${r.at.x},${r.at.y}` : "-"],
  ];
}

/** The TOON report of a sized export: key lines, one row per file, then tags and the alt hint. */
export function sizesReport(
  uuid: string,
  plan: Plan,
  preset: string,
  sizes: SizePlan,
  written: Array<Written & { px: number; density?: string }>,
  tags: Array<[string, string]>,
  wantAlt: boolean,
): string {
  const head: Array<[string, string | number]> = [["doc", uuid], ["preset", preset]];
  if (plan.mode === "artboard") head.push(["artboard", written[0]?.name ?? plan.artboard ?? ""]);
  if (sizes.kind === "densities" && sizes.base !== undefined) head.push(["base_dp", sizes.base]);
  const cols = [
    ...(plan.mode === "all" ? ["artboard"] : []),
    ...(sizes.kind === "densities" ? ["density"] : []),
    "path",
    "bytes",
    "size",
    ...(wantAlt ? ["alt"] : []),
  ];
  const rows = written.map((w) => ({ artboard: w.name, density: w.density, path: shown(w.path), bytes: w.bytes, size: w.size, alt: altText(w) }));
  const parts = [emitKV(head), emitList("exports", rows, cols)];
  if (tags.length > 0) parts.push(emitKV(tags));
  if (wantAlt && written.some((w) => w.alt !== undefined)) parts.push(helpBlock(["edit the alt text before publishing"]));
  return parts.join("\n");
}
