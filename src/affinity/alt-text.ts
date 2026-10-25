// Alt-text stubs. A pure function over the document Inventory: the visible
// text inside the exported area, columns left to right and each column
// top-down, as one short line.
// It is a starting point for a person to edit, never a finished description.

import type { Inventory, InventoryNode } from "./manifest-types.js";

export type AltArea =
  | { kind: "artboard"; name: string }
  | { kind: "spread"; spread: number }
  | { kind: "box"; box: [number, number, number, number] }
  | { kind: "all" };

/** Shared flag for `export` and `webassets`. */
export const NO_ALT_FLAG = {
  name: "no-alt",
  type: "boolean",
  description: "skip the alt-text stub (saves one inventory call)",
} as const;

/** Text length the inventory should return for alt text; `inspect` keeps its 40. */
export const ALT_TEXT_CHARS = 160;

/** Default cap of an alt-text stub, in characters. */
export const ALT_MAX = 125;

function inArea(n: InventoryNode, area: AltArea): boolean {
  switch (area.kind) {
    case "artboard":
      return n.artboard === area.name;
    case "spread":
      return n.path.startsWith(`${area.spread}/`);
    case "box": {
      const [bx, by, bw, bh] = area.box;
      const cx = n.box[0] + n.box[2] / 2;
      const cy = n.box[1] + n.box[3] / 2;
      return cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh;
    }
    case "all":
      return true;
  }
}

/** Cuts at `max`, on the last space at or before the limit; no ellipsis. */
function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  if (s[max] !== " ") {
    const space = cut.lastIndexOf(" ");
    if (space > 0) cut = cut.slice(0, space);
  }
  return cut.trimEnd().replace(/[,;:\-–—]+$/, "").trimEnd();
}

type Box = [number, number, number, number];

/**
 * Cuts `rows` at the first uncovered interval of positive width on one axis
 * (0 = x, 1 = y); [rows] when there is none. Cutting at one gap, not all, keeps
 * the rest together so the next level can still find columns.
 */
function cutAtFirstGap<T extends { box: Box }>(rows: T[], axis: 0 | 1): T[][] {
  const sorted = [...rows].sort((a, b) => a.box[axis] - b.box[axis]);
  let end = -Infinity;
  for (const [i, r] of sorted.entries()) {
    if (i > 0 && r.box[axis] > end) return [sorted.slice(0, i), sorted.slice(i)];
    end = Math.max(end, r.box[axis] + r.box[axis === 0 ? 2 : 3]);
  }
  return [sorted];
}

/**
 * Reading order by recursive XY-cut, columns first: split at any vertical gap
 * into columns left to right; else at a horizontal gap into bands top to
 * bottom; else top then left. Boxes that touch are not a gap. Recurses into
 * each part.
 */
export function readingOrder<T extends { box: Box }>(rows: T[]): T[] {
  if (rows.length < 2) return [...rows];
  for (const axis of [0, 1] as const) {
    const parts = cutAtFirstGap(rows, axis);
    if (parts.length > 1) return parts.flatMap((p) => readingOrder(p));
  }
  return [...rows].sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

/**
 * Alt text for an area: the visible text rows inside it, in reading order
 * (columns left to right, each top-down), whitespace collapsed, joined with
 * ". " (a piece already ending in . ! or ? is joined with a space), cut to
 * `max` characters on a word boundary. Empty string when the area has no text.
 */
export function altFor(inv: Inventory, area: AltArea, max = ALT_MAX): string {
  const rows = readingOrder(
    inv.nodes
      .filter((n) => n.visible && typeof n.text === "string" && inArea(n, area))
      .map((n) => ({ box: n.box, text: (n.text ?? "").replace(/\s+/g, " ").trim() }))
      .filter((r) => r.text !== ""),
  );
  let out = "";
  for (const { text } of rows) {
    if (out === "") out = text;
    else out += (/[.!?]$/.test(out) ? " " : ". ") + text;
  }
  return cap(out, max);
}
