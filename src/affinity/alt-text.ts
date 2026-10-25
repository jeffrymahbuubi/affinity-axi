// Alt-text stubs. A pure function over the document Inventory: the visible
// text inside the exported area, top-down then left-right, as one short line.
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

/**
 * Alt text for an area: the visible text rows inside it, ordered by box top
 * then left, whitespace collapsed, joined with ". " (a piece already ending in
 * . ! or ? is joined with a space), cut to `max` characters on a word
 * boundary. Empty string when the area has no text.
 */
export function altFor(inv: Inventory, area: AltArea, max = ALT_MAX): string {
  const rows = inv.nodes
    .filter((n) => n.visible && typeof n.text === "string" && inArea(n, area))
    .map((n) => ({ n, text: (n.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((r) => r.text !== "")
    .sort((a, b) => a.n.box[1] - b.n.box[1] || a.n.box[0] - b.n.box[0]);
  let out = "";
  for (const { text } of rows) {
    if (out === "") out = text;
    else out += (/[.!?]$/.test(out) ? " " : ". ") + text;
  }
  return cap(out, max);
}
