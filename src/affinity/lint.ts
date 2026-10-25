// Design checks on an Inventory (the `inspect` walker's output). Pure and
// offline: `lint <doc>` fetches one inventory, then every rule runs here.
//
// Contrast is approximate by design: the background is the nearest solid fill
// below the text in stacking order (shape, then the artboard's own fill, then
// assumed white). Photos and gradients are not measured; the text over them is
// skipped and counted.

import { contrastRatio, ratioText, type BrandKit } from "./brand.js";
import type { Inventory, InventoryNode } from "./manifest-types.js";
import { findPlatform, PLATFORMS, type PlatformRow, type SafeInsets } from "./platforms.js";

export type Severity = "error" | "warning";

export interface Finding {
  severity: Severity;
  check: "contrast" | "safe-zone" | "min-font" | "slot" | "off-kit";
  /** The element name, or `<path> "<text>"` / `<path>` when it has none. */
  node: string;
  /** Index path in the inventory, e.g. "0/0/2". */
  path: string;
  detail: string;
}

export interface LintOptions {
  /** A `PLATFORMS` key whose safe insets apply to the artboards in scope. */
  platform?: string;
  /** Only this artboard (exact name) and what it contains. */
  artboard?: string;
  /** Text below this size (px) is a warning. */
  minFont: number;
  /** Warnings become errors. */
  strict: boolean;
  kit?: BrandKit;
}

/**
 * Stacking order in the inventory. The live probe (Affinity 3.3.1.4940) showed
 * rows list lower nodes first: a rectangle drawn before a text comes before it.
 * Flip this constant if a later release reverses that.
 */
export const BELOW_IS_EARLIER = true;

const SLOT_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SAFE_ZONE_NAME = "axi-safe-zone";
const SOLID = /^#[0-9A-Fa-f]{6}$/;

/**
 * Text size in px. The probe showed `font` already prints px on a px document
 * ("Helvetica-Bold 48" for a 48 px text), so this only parses the trailing
 * number. It is the one place to scale if another unit ever shows up.
 */
export function fontPx(row: InventoryNode, _inv: Inventory): number | null {
  const m = /\s(\d+(?:\.\d+)?)$/.exec(row.font ?? "");
  return m ? Number(m[1]) : null;
}

const hiddenCache = new WeakMap<Inventory, string[]>();

/** Paths of hidden nodes and of safe-zone guides; their subtrees are not designs. */
function offPaths(inv: Inventory): string[] {
  let p = hiddenCache.get(inv);
  if (!p) {
    p = inv.nodes.filter((n) => !n.visible || n.name === SAFE_ZONE_NAME).map((n) => n.path);
    hiddenCache.set(inv, p);
  }
  return p;
}

function active(inv: Inventory, n: InventoryNode): boolean {
  return !offPaths(inv).some((p) => n.path === p || n.path.startsWith(p + "/"));
}

function contains(box: [number, number, number, number], cx: number, cy: number): boolean {
  return cx >= box[0] && cx <= box[0] + box[2] && cy >= box[1] && cy <= box[1] + box[3];
}

/** Nodes below `text`, nearest first. */
function below(inv: Inventory, text: InventoryNode): InventoryNode[] {
  const i = inv.nodes.findIndex((n) => n.path === text.path);
  if (i < 0) return [];
  return BELOW_IS_EARLIER ? inv.nodes.slice(0, i).reverse() : inv.nodes.slice(i + 1);
}

function centre(text: InventoryNode): [number, number] {
  return [text.box[0] + text.box[2] / 2, text.box[1] + text.box[3] / 2];
}

/** The colour behind a text node: nearest solid fill below it, else its artboard's fill, else white. */
export function backgroundFor(inv: Inventory, text: InventoryNode): { hex: string; assumed: boolean; from: string } {
  const [cx, cy] = centre(text);
  for (const n of below(inv, text)) {
    if (n.text !== undefined || n.type === "Artboard" || !n.fill || !SOLID.test(n.fill)) continue;
    if (active(inv, n) && contains(n.box, cx, cy)) return { hex: n.fill.toUpperCase(), assumed: false, from: `${n.type.toLowerCase()} ${n.path}` };
  }
  const ab = text.artboard !== undefined ? inv.artboards.find((a) => a.name === text.artboard) : undefined;
  const abRow = ab ? inv.nodes.find((n) => n.path === ab.path) : undefined;
  if (abRow?.fill && SOLID.test(abRow.fill)) return { hex: abRow.fill.toUpperCase(), assumed: false, from: `artboard ${ab!.name}` };
  return { hex: "#FFFFFF", assumed: true, from: "assumed" };
}

/** True when a photo or gradient covers the text centre before any solid fill does. */
function overPhoto(inv: Inventory, text: InventoryNode): boolean {
  const [cx, cy] = centre(text);
  for (const n of below(inv, text)) {
    if (n.text !== undefined || n.type === "Artboard" || !active(inv, n) || !contains(n.box, cx, cy)) continue;
    if (n.fill && SOLID.test(n.fill)) return false;
    if (n.fill === "gradient" || n.fill === "bitmap" || n.type === "Image") return true;
  }
  return false;
}

function label(n: InventoryNode): string {
  if (n.name !== "") return n.name;
  return n.text !== undefined ? `${n.path} "${n.text}"` : n.path;
}

type Box = [number, number, number, number];

/** Which safe insets the text box crosses on this artboard, e.g. "top safe inset (250 px)". */
function crossed(row: PlatformRow, ab: Box, t: Box): string[] {
  const s: SafeInsets = row.safe ?? {};
  const out: string[] = [];
  if (s.top && t[1] < ab[1] + s.top) out.push(`top safe inset (${s.top} px)`);
  if (s.bottom && t[1] + t[3] > ab[1] + ab[3] - s.bottom) out.push(`bottom safe inset (${s.bottom} px)`);
  if (s.left && t[0] < ab[0] + s.left) out.push(`left safe inset (${s.left} px)`);
  if (s.right && t[0] + t[2] > ab[0] + ab[2] - s.right) out.push(`right safe inset (${s.right} px)`);
  return out;
}

/** The platform row for one artboard: the explicit one (only on a same-size artboard when some match), else the first row with a safe zone and the same size. */
function platformFor(ab: Box, explicit: PlatformRow | undefined, anyMatch: boolean): PlatformRow | undefined {
  if (explicit) return !anyMatch || (explicit.w === ab[2] && explicit.h === ab[3]) ? explicit : undefined;
  return PLATFORMS.find((p) => p.safe !== undefined && p.w === ab[2] && p.h === ab[3]);
}

function pathKey(p: string): number[] {
  return p.split("/").map((s) => Number(s));
}

function byPath(a: Finding, b: Finding): number {
  const x = pathKey(a.path);
  const y = pathKey(b.path);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.check.localeCompare(b.check);
}

export function lintInventory(inv: Inventory, opts: LintOptions): { findings: Finding[]; checked: number; skipped: number } {
  const all: Finding[] = [];
  const add = (severity: Severity, check: Finding["check"], n: InventoryNode, detail: string): void => {
    all.push({ severity: severity === "warning" && opts.strict ? "error" : severity, check, node: label(n), path: n.path, detail });
  };

  const inScope = (n: InventoryNode): boolean =>
    opts.artboard === undefined || n.artboard === opts.artboard || (n.type === "Artboard" && inv.artboards.some((a) => a.path === n.path && a.name === opts.artboard));
  const nodes = inv.nodes.filter((n) => n.visible && active(inv, n) && inScope(n));

  const abs = inv.artboards.filter((a) => opts.artboard === undefined || a.name === opts.artboard);
  const explicit = opts.platform !== undefined ? findPlatform(opts.platform) : undefined;
  const anyMatch = explicit !== undefined && abs.some((a) => a.box[2] === explicit.w && a.box[3] === explicit.h);

  const kitHex = opts.kit ? Object.values(opts.kit.colours).map((c) => c.toUpperCase()) : [];
  const slotSeen = new Set<string>();
  let skipped = 0;

  for (const n of nodes) {
    const inkText = n.text !== undefined && n.text.trim() !== "";
    const px = inkText ? fontPx(n, inv) : null;

    if (inkText) {
      if (n.fill && SOLID.test(n.fill) && !overPhoto(inv, n)) {
        const bg = backgroundFor(inv, n);
        const ratio = contrastRatio(n.fill, bg.hex);
        const need = px !== null && px >= 24 ? 3 : 4.5;
        if (ratio < need) {
          const where = bg.assumed ? `against ${bg.hex} (assumed)` : `on ${bg.hex} (${bg.from})`;
          add("error", "contrast", n, `${ratioText(ratio)}:1 ${n.fill.toUpperCase()} ${where} needs ${need}:1`);
        }
      } else {
        skipped += 1;
      }
      if (px !== null && px < opts.minFont) add("warning", "min-font", n, `${px} px is below the ${opts.minFont} px minimum`);

      const ab = n.artboard !== undefined ? abs.find((a) => a.name === n.artboard) : undefined;
      const row = ab ? platformFor(ab.box, explicit, anyMatch) : undefined;
      const hit = ab && row ? crossed(row, ab.box, n.box) : [];
      if (hit.length > 0) add("error", "safe-zone", n, `crosses ${hit.join(" and ")} of ${row!.key}`);
    }

    if (n.name.startsWith("slot:")) {
      const key = n.name.slice(5);
      if (key === "") add("error", "slot", n, "slot name has an empty key; use slot:<key>");
      else if (!SLOT_KEY.test(key)) add("warning", "slot", n, `slot key '${key}' should be a letter then letters, digits, - or _`);
      const id = `${n.artboard ?? ""}\u0000${n.name}`;
      if (slotSeen.has(id)) add("error", "slot", n, `slot '${n.name}' is used by more than one element${n.artboard ? ` in ${n.artboard}` : ""}`);
      slotSeen.add(id);
    }

    if (opts.kit && n.fill && SOLID.test(n.fill) && !kitHex.includes(n.fill.toUpperCase())) {
      add("warning", "off-kit", n, `${n.fill.toUpperCase()} not in kit ${opts.kit.name} (${Object.keys(opts.kit.colours).join(", ")})`);
    }
  }

  const findings = all.sort((a, b) => (a.severity === b.severity ? byPath(a, b) : a.severity === "error" ? -1 : 1));
  return { findings, checked: nodes.length, skipped };
}
