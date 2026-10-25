// Brand kits: a per-project JSON file the CLI validates offline and injects
// into a script as `const AXI_BRAND = {...};` on line 1 (the same mechanism as
// ARGS). Scripts never read the file themselves, so the Desktop-only file
// rule stays out of them and run, batch and fill can log the same BrandRef.
//
// Resolution (per project, no global store): --brand, then $AFFINITY_AXI_BRAND,
// then ./brand.json. A reference containing '/' or ending in .json is a path;
// anything else is a name under ./brands/<name>.brand.json.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { UsageError } from "../output/errors.js";
import type { BrandRef } from "./manifest-types.js";

export const BRAND_SCHEMA = "affinity-axi/brand/1";

export interface BrandKit {
  schema: "affinity-axi/brand/1";
  name: string;
  colours: Record<string, string>;
  fonts: Record<string, string>;
  type?: Record<string, { font: string; size: number; leading?: number; spacing?: number }>;
  space?: number[];
  radius?: Record<string, number>;
  logo?: Record<string, string>;
  pairs?: [string, string][];
}

export const BRAND_FLAG = {
  name: "brand",
  type: "string" as const,
  description: "brand kit: a .brand.json path or a name under ./brands/ (default $AFFINITY_AXI_BRAND, then ./brand.json)",
};

const KNOWN_KEYS = ["schema", "name", "colours", "fonts", "type", "space", "radius", "logo", "pairs"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const TOKEN_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const RASTER = /\.(png|jpe?g)$/i;
const FIX = "fix the field or run: affinity-axi brand init <name>";

/** The brand file a run should use, as an absolute path, or null when none applies. */
export function resolveBrandRef(flag: string | undefined, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const fromEnv = env["AFFINITY_AXI_BRAND"];
  const ref = flag !== undefined && flag !== "" ? flag : fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
  if (ref !== undefined) {
    if (ref.includes("/") || ref.endsWith(".json")) return resolve(cwd, ref);
    return resolve(cwd, "brands", `${ref}.brand.json`);
  }
  const local = resolve(cwd, "brand.json");
  return existsSync(local) ? local : null;
}

function bad(file: string, field: string, why: string): never {
  throw new UsageError(`brand kit ${file}: ${field} ${why}`, FIX);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringMap(v: unknown, file: string, field: string, min: number, max: number, check: (val: string, key: string) => string | null): Record<string, string> {
  if (!isObject(v)) bad(file, field, "must be an object");
  const keys = Object.keys(v);
  if (keys.length < min || keys.length > max) bad(file, field, `must have ${min} to ${max} entries (has ${keys.length})`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!TOKEN_KEY.test(k)) bad(file, `${field}.${k}`, "has a bad key (letters, digits, - and _, starting with a letter)");
    const val = v[k];
    if (typeof val !== "string") bad(file, `${field}.${k}`, "must be a string");
    const why = check(val, k);
    if (why) bad(file, `${field}.${k}`, why);
    out[k] = val;
  }
  return out;
}

function positive(v: unknown, file: string, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(file, field, "must be a positive number");
  return v;
}

/** Validates a parsed kit and returns it with the known fields typed. Throws UsageError naming the field path. */
export function validateKit(json: unknown, file: string): BrandKit {
  if (!isObject(json)) bad(file, "(root)", "must be a JSON object");
  if (json["schema"] !== BRAND_SCHEMA) bad(file, "schema", `must be "${BRAND_SCHEMA}"`);
  const name = json["name"];
  if (typeof name !== "string" || name.trim() === "") bad(file, "name", "must be a non-empty string");

  const colours = stringMap(json["colours"], file, "colours", 1, 32, (v) => (HEX.test(v) ? null : "must be #RRGGBB"));
  const fonts = stringMap(json["fonts"], file, "fonts", 1, 16, (v) => (v.trim() === "" ? "must be a postscript name" : null));
  for (const role of ["headline", "body"]) if (!(role in fonts)) bad(file, `fonts.${role}`, "is required");

  const kit: BrandKit = { schema: BRAND_SCHEMA, name, colours, fonts };
  // Unknown top-level keys are kept (and reported by `brand show`).
  const copy = kit as unknown as Record<string, unknown>;
  for (const k of Object.keys(json)) if (!KNOWN_KEYS.includes(k)) copy[k] = json[k];

  if (json["type"] !== undefined) {
    const t = json["type"];
    if (!isObject(t)) bad(file, "type", "must be an object");
    const type: NonNullable<BrandKit["type"]> = {};
    for (const [k, s] of Object.entries(t)) {
      const at = `type.${k}`;
      if (!TOKEN_KEY.test(k)) bad(file, at, "has a bad key");
      if (!isObject(s)) bad(file, at, "must be an object {font, size}");
      if (typeof s["font"] !== "string" || !(s["font"] in fonts)) bad(file, `${at}.font`, `must name a role in fonts (${Object.keys(fonts).join(", ")})`);
      const entry: { font: string; size: number; leading?: number; spacing?: number } = { font: s["font"], size: positive(s["size"], file, `${at}.size`) };
      if (s["leading"] !== undefined) entry.leading = positive(s["leading"], file, `${at}.leading`);
      if (s["spacing"] !== undefined) {
        if (typeof s["spacing"] !== "number" || !Number.isFinite(s["spacing"])) bad(file, `${at}.spacing`, "must be a number");
        entry.spacing = s["spacing"];
      }
      type[k] = entry;
    }
    kit.type = type;
  }

  if (json["space"] !== undefined) {
    const sp = json["space"];
    if (!Array.isArray(sp) || sp.length < 2 || sp.length > 16) bad(file, "space", "must be an array of 2 to 16 numbers");
    sp.forEach((n, i) => {
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) bad(file, `space[${i}]`, "must be a number of px, 0 or more");
      if (i > 0 && n <= (sp[i - 1] as number)) bad(file, `space[${i}]`, "must be larger than the one before (ascending)");
    });
    kit.space = sp as number[];
  }

  if (json["radius"] !== undefined) {
    const r = json["radius"];
    if (!isObject(r)) bad(file, "radius", "must be an object of px values");
    const radius: Record<string, number> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!TOKEN_KEY.test(k)) bad(file, `radius.${k}`, "has a bad key");
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(file, `radius.${k}`, "must be a number of px, 0 or more");
      radius[k] = v;
    }
    kit.radius = radius;
  }

  if (json["logo"] !== undefined) {
    kit.logo = stringMap(json["logo"], file, "logo", 1, 16, (v) => (RASTER.test(v) ? null : "must be a PNG or JPEG file (the vector mark stays in the document)"));
  }

  if (json["pairs"] !== undefined) {
    const ps = json["pairs"];
    if (!Array.isArray(ps)) bad(file, "pairs", "must be an array of [foreground, background] colour keys");
    kit.pairs = ps.map((p, i) => {
      if (!Array.isArray(p) || p.length !== 2) bad(file, `pairs[${i}]`, "must be [foreground, background]");
      for (const key of p) if (typeof key !== "string" || !(key in colours)) bad(file, `pairs[${i}]`, `names an unknown colour key ${JSON.stringify(key)} (have ${Object.keys(colours).join(", ")})`);
      return [p[0] as string, p[1] as string] as [string, string];
    });
  }
  return kit;
}

/** Top-level keys the schema does not know (kept in the kit, reported by `brand show`). */
export function extraKeys(kit: BrandKit): string[] {
  return Object.keys(kit).filter((k) => !KNOWN_KEYS.includes(k));
}

/** Reads and validates a kit; logo paths become absolute (relative to the kit's folder). The file is not rewritten. */
export function loadBrand(path: string, cwd: string = process.cwd()): { kit: BrandKit; ref: BrandRef } {
  const abs = resolve(cwd, path);
  const shown = relative(cwd, abs) || abs;
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    throw new UsageError(`cannot read brand kit '${shown}'`, "pass --brand <path to a .brand.json | name under ./brands/>, or create one with: affinity-axi brand init <name>");
  }
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new UsageError(`brand kit ${shown}: not valid JSON (${err instanceof Error ? err.message : String(err)})`, FIX);
  }
  const kit = validateKit(json, shown);
  if (kit.logo) {
    const dir = dirname(abs);
    kit.logo = Object.fromEntries(Object.entries(kit.logo).map(([k, p]) => [k, isAbsolute(p) ? p : resolve(dir, p)]));
  }
  return { kit, ref: { name: kit.name, path: shown, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

/** Prepends `const AXI_BRAND = {...}; ` on line 1 (no newline added, so user line numbers hold). */
export function injectBrand(source: string, kit: BrandKit): string {
  const compact = JSON.stringify(kit)
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
  return `const AXI_BRAND = ${compact}; ${source}`;
}

function channel(hex: string, from: number): number {
  const c = parseInt(hex.slice(from, from + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  return 0.2126 * channel(h, 0) + 0.7152 * channel(h, 2) + 0.0722 * channel(h, 4);
}

/** WCAG 2 contrast ratio of two #RRGGBB colours, 1 to 21. */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const a = luminance(fgHex);
  const b = luminance(bgHex);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Round to two decimals for display. */
export function ratioText(r: number): string {
  return (Math.round(r * 100) / 100).toFixed(2);
}
