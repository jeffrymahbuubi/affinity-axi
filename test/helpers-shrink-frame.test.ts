// axiShrinkText on a frame text node: it fits when the ink box fits and the spread
// visible box (the one inspect reports) is no taller than h + max(4, 5% of h); that
// box's width is ignored. Evaluated in plain Node against stubbed
// SDK modules; the live behaviour is covered by the refix re-test
// (docs/plans/2026-11-04-sweep-refix-plan.md, unit U2).

import { describe, expect, it } from "vitest";
import { LAYOUT_INDEX, LAYOUT_SOURCE } from "../src/affinity/helpers-layout.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;
type Size = { width: number; height: number };

interface Opts {
  frame: boolean;
  /** Ink box of the node at a size. */
  exact: (size: number) => Size;
  /** Spread visible box of the node at a size. */
  loose: (size: number) => Size;
}

function env(size: number, o: Opts) {
  const log: string[] = [];
  const calls = { loose: 0 };
  const node: any = {
    userDescription: "slot:para",
    description: "",
    children: [],
    text: "A long paragraph",
    size,
    parent: null,
    isFrameTextNode: o.frame,
    story: { length: 16, getGlyphAttRunsFrom: () => [{ glyphAtts: { height: node.size } }] },
    getExactSpreadVisibleBox: () => ({ x: 0, y: 0, ...o.exact(node.size) }),
    getSpreadVisibleBox: () => {
      calls.loose++;
      return { x: 0, y: 0, ...o.loose(node.size) };
    },
  };
  const spread: any = { isSpreadNode: true, children: [node], isSameNode: (x: any) => x === spread };
  node.parent = spread;
  const doc: any = {
    spreads: [spread],
    currentSpread: spread,
    formatText: (d: any) => {
      node.size = d.height;
      log.push(`format:${d.height}`);
    },
  };
  const mods: Record<string, unknown> = {
    "/storydelta.js": { StoryDelta: { createGlyphDouble: (_k: number, v: number) => ({ height: v }) } },
    "/glyphatts.js": { GlyphAttDoubleType: { Height: 7 } },
    "/selections.js": { Selection: { create: () => ({ addSubSelectionForNode() {} }) }, TextSelection: { create: () => ({}) } },
  };
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`;
  const h = new Function("require", body)((id: string) => {
    if (id in mods) return mods[id];
    throw new Error(`SDK module ${id} not available in tests`);
  }) as Record<string, Fn>;
  return { h, doc, node, log, calls };
}

/** The ink box stays clipped at 400x121; the spread visible box is 405x363 at 32 px and scales with the size. */
const clipped = (frame: boolean): Opts => ({
  frame,
  exact: () => ({ width: 400, height: 121 }),
  loose: (s) => ({ width: 405 * (s / 32), height: 363 * (s / 32) }),
});

describe("axiShrinkText on a frame text node", () => {
  it("shrinks when the ink box is clipped to the frame but the spread visible box overflows", () => {
    const e = env(32, clipped(true));
    const r = e.h.axiShrinkText!(e.doc, "slot:para", { w: 400, h: 121, minSize: 8 });
    expect(r.from).toBe(32);
    expect(r.size).toBeLessThan(32);
    expect(r.fits).toBe(true);
    expect(e.log.length).toBeGreaterThan(0);
    expect(e.node.size).toBe(r.size);
    // the largest 0.5 step with 363 * s / 32 <= 121 + 6.05, i.e. s <= 11.2
    expect(r.size).toBe(11);
    expect(e.node.size * (363 / 32)).toBeLessThanOrEqual(127.05);
  });

  it("leaves a text that fits both boxes alone (no formatText)", () => {
    const e = env(32, { frame: true, exact: () => ({ width: 400, height: 121 }), loose: () => ({ width: 400, height: 121 }) });
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 400, h: 121 })).toEqual({ from: 32, size: 32, fits: true });
    expect(e.log).toEqual([]);
    expect(e.calls.loose).toBeGreaterThan(0);
  });

  it("does not shrink an art text node whatever its spread visible box says", () => {
    const e = env(32, { frame: false, exact: () => ({ width: 300, height: 40 }), loose: () => ({ width: 5000, height: 5000 }) });
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 400, h: 121 })).toEqual({ from: 32, size: 32, fits: true });
    expect(e.log).toEqual([]);
    expect(e.calls.loose).toBe(0);
  });

  it("reports fits false and leaves the frame at the floor when even the floor overflows", () => {
    const e = env(32, clipped(true));
    // the default floor is 16 px, where the spread visible box is still 181 high
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 400, h: 121 })).toEqual({ from: 32, size: 16, fits: false });
    expect(e.node.size).toBe(16);
  });

  it("leaves a short text alone when the ink box fits and the spread box is only frame chrome larger", () => {
    const e = env(32, { frame: true, exact: () => ({ width: 397, height: 120 }), loose: () => ({ width: 405, height: 122 }) });
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 400, h: 121 })).toEqual({ from: 32, size: 32, fits: true });
    expect(e.log).toEqual([]);
  });

  it("ignores the spread box width: wider than w but not taller still fits", () => {
    const e = env(40, { frame: true, exact: () => ({ width: 100, height: 20 }), loose: (s) => ({ width: s * 10, height: 20 }) });
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 300, h: 100 })).toEqual({ from: 40, size: 40, fits: true });
    expect(e.log).toEqual([]);
  });

  it("allows the spread box to be taller than h by max(4, 5% of h) and no more", () => {
    const small = env(20, { frame: true, exact: () => ({ width: 50, height: 30 }), loose: () => ({ width: 50, height: 34 }) });
    expect(small.h.axiShrinkText!(small.doc, "slot:para", { w: 400, h: 30 })).toEqual({ from: 20, size: 20, fits: true });
    const over = env(20, { frame: true, exact: () => ({ width: 50, height: 30 }), loose: (s) => ({ width: 50, height: s * 2 }) });
    // h 30: tolerance max(4, 1.5) = 4, so s * 2 <= 34 holds up to s 17
    const r = over.h.axiShrinkText!(over.doc, "slot:para", { w: 400, h: 30, minSize: 8 });
    expect(r).toEqual({ from: 20, size: 17, fits: true });
  });

  it("shrinks when the ink box is wider than w (an unbreakable word)", () => {
    const e = env(40, { frame: true, exact: (s) => ({ width: s * 10, height: 20 }), loose: () => ({ width: 100, height: 20 }) });
    expect(e.h.axiShrinkText!(e.doc, "slot:para", { w: 300, h: 100 })).toEqual({ from: 40, size: 30, fits: true });
  });
});

describe("axiShrinkText source", () => {
  it("has no backtick, dollar-brace, backslash or close call and names the frame measure in the index", () => {
    expect(LAYOUT_SOURCE).not.toContain("`");
    expect(LAYOUT_SOURCE).not.toContain("${");
    expect(LAYOUT_SOURCE).not.toContain("\\");
    expect(LAYOUT_SOURCE).not.toMatch(/close\s*\(/);
    const entry = LAYOUT_INDEX.find((h) => h.name === "axiShrinkText")!;
    expect(entry.summary).toMatch(/frame text node/);
    expect(entry.summary).toMatch(/spread visible box/);
    expect(entry.summary).toMatch(/width is ignored/);
  });
});
