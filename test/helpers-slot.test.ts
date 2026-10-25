// Text and table helpers the fill command builds on: axiText anchoring, axiSetText
// on an empty value, axiAlignOf, axiBoardBox, axiShrinkText and axiTable padding.
// Evaluated in plain Node against stubbed SDK modules; the live behaviour is
// covered by the sweep re-tests (docs/plans/2026-11-01-live-sweep-fixes-plan.md).

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { CORE_INDEX, CORE_SOURCE } from "../src/affinity/helpers-core.js";
import { LAYOUT_INDEX, LAYOUT_SOURCE } from "../src/affinity/helpers-layout.js";
import { NAMED_INDEX, NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { TABLE_INDEX, TABLE_SOURCE } from "../src/affinity/helpers-table.js";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

// --- source hygiene ---------------------------------------------------------

describe("touched helper blocks", () => {
  const blocks: Array<[string, string, readonly { name: string }[]]> = [
    ["CORE_SOURCE", CORE_SOURCE, CORE_INDEX],
    ["LAYOUT_SOURCE", LAYOUT_SOURCE, LAYOUT_INDEX],
    ["NAMED_SOURCE", NAMED_SOURCE, NAMED_INDEX],
    ["TABLE_SOURCE", TABLE_SOURCE, TABLE_INDEX],
  ];
  for (const [label, src, index] of blocks) {
    const declared = [...src.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    it(`${label} parses and has no backtick, dollar-brace, backslash, close or dialog call`, () => {
      expect(() => new Script(src)).not.toThrow();
      expect(() => new Script(HELPERS_SOURCE)).not.toThrow();
      expect(src).not.toContain("`");
      expect(src).not.toContain("${");
      expect(src).not.toContain("\\");
      expect(src).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
      expect(scanForBlocking(src)).toEqual([]);
      expect(scanForAi(src)).toEqual([]);
    });
    it(`${label} declares each index entry once and lists every other function as internal`, () => {
      const all = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
      for (const h of index) expect(all).toContain(h.name);
      expect(new Set(declared).size).toBe(declared.length);
      const known = new Set([...HELPER_INDEX.map((h) => h.name), ...INTERNAL_HELPERS]);
      for (const n of declared) expect(known.has(n)).toBe(true);
    });
    it(`${label} has function declarations only and every require inside a function`, () => {
      const top = src.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
      for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
      for (const l of src.split("\n").filter((x) => x.includes("require("))) expect(l).toMatch(/^\s+/);
    });
  }

  it("indexes axiShrinkText publicly and keeps axiAlignOf and axiBoardBox internal", () => {
    expect(LAYOUT_INDEX.map((h) => h.name)).toContain("axiShrinkText");
    expect(INTERNAL_HELPERS).toContain("axiAlignOf");
    expect(INTERNAL_HELPERS).toContain("axiBoardBox");
    expect(NAMED_INDEX.map((h) => h.name)).not.toContain("axiAlignOf");
    const text = (n: string) => HELPER_INDEX.find((h) => h.name === n)!.summary;
    expect(text("axiText")).toMatch(/re-flows about x/);
    expect(text("axiText")).toMatch(/anchored at x natively/);
    expect(text("axiSetText")).toMatch(/empty string keeps the style \(a zero-width space is written\)/);
    expect(text("axiTable")).toMatch(/padding/);
  });
});

// --- a fake SDK ---------------------------------------------------------------

const ENUM = { Left: { value: 0 }, Centre: { value: 1 }, Right: { value: 2 }, JustifyLeft: { value: 3 } };

/** Evaluates all helpers with `mods` answering require(); `tail` runs in the same scope (stubs). */
function load(mods: Record<string, unknown>, tail = ""): Record<string, Fn> {
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${tail}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)((id: string) => {
    if (id in mods) return mods[id];
    throw new Error(`SDK module ${id} not available in tests`);
  }) as Record<string, Fn>;
}

// --- axiText ---------------------------------------------------------------------

describe("axiText anchors", () => {
  function run(align: string | undefined, maxW?: number) {
    const log: string[] = [];
    const made: any = { userDescription: "" };
    // The line is 100 wide and starts at 0 whatever the alignment, so the shift is x - 100 (r).
    const doc: any = { selection: { nodes: { first: made } }, addNode: () => log.push("addNode"), deleteSelection: () => log.push("delete") };
    const mods = {
      "/nodes.js": { ArtTextNodeDefinition: { createFromStoryBuilder: () => ({}) } },
      "/storydelta.js": { StoryDelta: { createAlignX: (v: any) => (log.push(`createAlignX:${v === ENUM.Right ? "Right" : v === ENUM.Centre ? "Centre" : "?"}`), { align: v }) } },
      "/paragraphatts.js": { ParagraphAlignXType: ENUM },
    };
    const h = load(mods, `axiSurface = function () {};
      axiStyled = function () { return { addText: function () {}, applyParagraphDelta: function (d) { LOGGER.push('para'); } }; };
      axiMeasure = function () { return { x: 0, y: 0, w: 100, h: 20 }; };
      axiMove = function (d, dx) { LOGGER.push('move:' + dx); };`.replace(/LOGGER/g, "globalThis.__log"));
    (globalThis as any).__log = log;
    h.axiText!(doc, { x: 500, y: 100, text: "t", font: "F", size: 20, align, maxW });
    return log;
  }

  it("align r applies createAlignX(Right) to the story and makes no shift (anchored at x natively)", () => {
    expect(run("r")).toEqual(["createAlignX:Right", "para", "addNode"]);
  });

  it("align c applies createAlignX(Centre) and makes no shift", () => {
    expect(run("c")).toEqual(["createAlignX:Centre", "para", "addNode"]);
  });

  it("maxW with align r re-makes at the scaled size and still makes no shift", () => {
    expect(run("r", 50)).toEqual(["createAlignX:Right", "para", "addNode", "delete", "para", "addNode"]);
  });

  it("align l (and none) applies no paragraph alignment", () => {
    expect(run("l")).toEqual(["addNode", "move:500"]);
    expect(run(undefined)).toEqual(["addNode", "move:500"]);
  });
});

// --- axiSetText ------------------------------------------------------------------

describe("axiSetText with an empty string", () => {
  it("writes a zero-width space and still restyles the first run", () => {
    const log: string[] = [];
    const node: any = {
      userDescription: "slot:price",
      description: "",
      children: [],
      text: "Rp 1",
      story: { length: 4, getGlyphAttRunsFrom: () => [{ glyphAtts: { font: "F-Bold", height: 64, brushFill: "navy" } }] },
    };
    const spread: any = { isSpreadNode: true, children: [node], isSameNode: (o: any) => o === spread };
    node.parent = spread;
    const doc: any = {
      spreads: [spread],
      currentSpread: spread,
      setText: (t: string) => log.push(`setText:${[...t].map((c) => c.charCodeAt(0)).join(",")}`),
      formatText: (d: any) => log.push(`format:${d.all.map((x: any) => x.font ?? x.value ?? x.brush).join("|")}`),
    };
    const h = load({
      "/storydelta.js": {
        StoryDelta: {
          createFont: (_f: number, font: any) => ({ font }),
          createGlyphDouble: (_k: number, value: number) => ({ value }),
          createBrushFill: (brush: any) => ({ brush }),
          createComposite: (all: any[]) => ({ all }),
        },
      },
      "/fonts.js": { FontField: { PostscriptName: 1, FamilyName: 2 } },
      "/glyphatts.js": { GlyphAttDoubleType: { Height: 7 } },
      "/selections.js": { Selection: { create: () => ({ addSubSelectionForNode() {} }) }, TextSelection: { create: () => ({}) } },
    });
    h.axiSetText!(doc, "slot:price", "");
    expect(log).toEqual(["setText:8203", "format:F-Bold|64|navy"]);
    log.length = 0;
    h.axiSetText!(doc, "slot:price", "Rp 2");
    expect(log[0]).toBe("setText:82,112,32,50");
  });
});

// --- axiAlignOf and axiBoardBox ----------------------------------------------------

describe("axiAlignOf", () => {
  const h = load({ "/paragraphatts.js": { ParagraphAlignXType: ENUM } });
  const nodeWith = (t: unknown) => ({ story: { getParagraphAtts: () => ({ alignXType: t }) } });

  it("maps Left, Centre and Right by identity", () => {
    expect(h.axiAlignOf!(nodeWith(ENUM.Left))).toBe("l");
    expect(h.axiAlignOf!(nodeWith(ENUM.Centre))).toBe("c");
    expect(h.axiAlignOf!(nodeWith(ENUM.Right))).toBe("r");
    expect(h.axiAlignOf!(nodeWith(ENUM.JustifyLeft))).toBe("l");
  });

  it("compares by .value when the enum comes back as another object", () => {
    expect(h.axiAlignOf!(nodeWith({ value: 2 }))).toBe("r");
    expect(h.axiAlignOf!(nodeWith({ value: 1 }))).toBe("c");
  });

  it("returns l when getParagraphAtts throws or the module is missing", () => {
    expect(h.axiAlignOf!({ story: { getParagraphAtts: () => { throw new Error("no"); } } })).toBe("l");
    expect(load({}).axiAlignOf!(nodeWith(ENUM.Right))).toBe("l");
  });
});

describe("axiBoardBox", () => {
  const h = load({});
  const box = (x: number, y: number, w: number, hh: number) => ({
    baseBoxInterface: { baseBox: { x: 0, y: 0, width: w, height: hh } },
    transform: { applyToPoint: (p: { x: number; y: number }) => ({ x: p.x + x, y: p.y + y }) },
  });

  it("returns the nearest artboard ancestor's box and name", () => {
    const outer: any = { isArtboardEnabled: true, userDescription: "outer", ...box(0, 0, 9000, 9000), parent: null };
    const board: any = { isArtboardEnabled: true, userDescription: "ig-square", ...box(1180, 0, 1080, 1080), parent: outer };
    const group: any = { isArtboardEnabled: false, parent: board };
    const text: any = { parent: group };
    expect(h.axiBoardBox!({ widthPixels: 5, heightPixels: 5 }, text)).toEqual({ x: 1180, y: 0, w: 1080, h: 1080, name: "ig-square" });
  });

  it("falls back to the layer description when the artboard has no name", () => {
    const board: any = { isArtboardEnabled: true, userDescription: "", description: "Artboard 2", ...box(0, 0, 10, 20), parent: null };
    expect(h.axiBoardBox!({}, { parent: board }).name).toBe("Artboard 2");
  });

  it("returns the document size with an empty name when there is no artboard", () => {
    const spread: any = { isArtboardEnabled: false, parent: null };
    expect(h.axiBoardBox!({ widthPixels: 1080, heightPixels: 1350 }, { parent: spread })).toEqual({ x: 0, y: 0, w: 1080, h: 1350, name: "" });
  });
});

// --- axiShrinkText ----------------------------------------------------------------------

/** A text node whose ink box is `perPx` wide per px of size and 1.2 x size high, one line. */
function shrinkEnv(size: number, perPx = 10) {
  const log: string[] = [];
  const node: any = {
    userDescription: "slot:headline",
    description: "",
    children: [],
    text: "A headline",
    size,
    parent: null,
    story: {
      length: 10,
      getGlyphAttRunsFrom: () => [{ glyphAtts: { height: node.size } }],
    },
    getExactSpreadVisibleBox: () => ({ x: 0, y: 0, width: node.size * perPx, height: node.size * 1.2 }),
  };
  const spread: any = { isSpreadNode: true, children: [node], isSameNode: (o: any) => o === spread };
  node.parent = spread;
  const doc: any = {
    spreads: [spread],
    currentSpread: spread,
    formatText: (d: any) => {
      node.size = d.height;
      log.push(`format:${d.height}`);
    },
  };
  const h = load({
    "/storydelta.js": { StoryDelta: { createGlyphDouble: (_k: number, v: number) => ({ height: v }) } },
    "/glyphatts.js": { GlyphAttDoubleType: { Height: 7 } },
    "/selections.js": { Selection: { create: () => ({ addSubSelectionForNode() {} }) }, TextSelection: { create: () => ({}) } },
  });
  return { h, doc, node, log };
}

describe("axiShrinkText", () => {
  it("does not touch a text that already fits (from === size, no formatText)", () => {
    const e = shrinkEnv(32);
    expect(e.h.axiShrinkText!(e.doc, "slot:headline", { w: 400, h: 100 })).toEqual({ from: 32, size: 32, fits: true });
    expect(e.log).toEqual([]);
  });

  it("finds the largest 0.5 step that fits and leaves the node there", () => {
    const e = shrinkEnv(64);
    expect(e.h.axiShrinkText!(e.doc, "slot:headline", { w: 400, h: 1e9 })).toEqual({ from: 64, size: 40, fits: true });
    expect(e.node.size).toBe(40);
    const half = shrinkEnv(64);
    expect(half.h.axiShrinkText!(half.doc, "slot:headline", { w: 405.5, h: 1e9 })).toEqual({ from: 64, size: 40.5, fits: true });
    expect(half.node.size).toBe(40.5);
  });

  it("honours the height as well as the width", () => {
    const e = shrinkEnv(64);
    const r = e.h.axiShrinkText!(e.doc, "slot:headline", { w: 10000, h: 48 });
    expect(r).toEqual({ from: 64, size: 40, fits: true });
  });

  it("stops at minSize with fits false when nothing fits (default half the size)", () => {
    const e = shrinkEnv(64);
    expect(e.h.axiShrinkText!(e.doc, "slot:headline", { w: 100, h: 1e9 })).toEqual({ from: 64, size: 32, fits: false });
    expect(e.node.size).toBe(32);
    const own = shrinkEnv(64);
    expect(own.h.axiShrinkText!(own.doc, "slot:headline", { w: 100, h: 1e9, minSize: 20 })).toEqual({ from: 64, size: 20, fits: false });
  });

  it("has a floor of 8 px and never grows a small text", () => {
    const e = shrinkEnv(10);
    expect(e.h.axiShrinkText!(e.doc, "slot:headline", { w: 20, h: 1e9 })).toEqual({ from: 10, size: 8, fits: false });
    const tiny = shrinkEnv(6);
    expect(tiny.h.axiShrinkText!(tiny.doc, "slot:headline", { w: 20, h: 1e9 })).toEqual({ from: 6, size: 6, fits: false });
    expect(tiny.log).toEqual([]);
  });

  it("rejects bad options and non-text nodes before any edit", () => {
    const e = shrinkEnv(32);
    expect(() => e.h.axiShrinkText!(e.doc, "slot:headline", { w: 0, h: 10 })).toThrow(/w and h must be positive/);
    expect(() => e.h.axiShrinkText!(e.doc, "slot:headline", { w: 10, h: -1 })).toThrow(/w and h must be positive/);
    expect(() => e.h.axiShrinkText!(e.doc, "slot:headline")).toThrow(/options/);
    expect(() => e.h.axiShrinkText!(e.doc, "slot:headline", { w: 10, h: 10, minSize: 0 })).toThrow(/minSize/);
    e.node.text = null;
    expect(() => e.h.axiShrinkText!(e.doc, "slot:headline", { w: 10, h: 10 })).toThrow(/not a text node/);
    expect(e.log).toEqual([]);
  });
});

// --- axiTable padding --------------------------------------------------------------------

describe("axiTable padding", () => {
  const CELL = { value: 7 };

  function setup() {
    const log: string[] = [];
    const glyphs: Array<{ ch: string; brk: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      if (i > 0) glyphs.push({ ch: "|", brk: true });
    }
    const story = {
      get length() {
        return glyphs.length;
      },
      getHardBreakType: (i: number) => (glyphs[i]!.brk ? CELL : null),
    };
    const table: any = { story, userDescription: "", getSpreadVisibleBox: () => ({ width: 900 }) };
    const doc: any = {
      selection: { nodes: { first: table } },
      addNode: () => log.push("addNode"),
      setText: (text: string, sel: any) => {
        const r = sel.range;
        glyphs.splice(r.begin, r.end - r.begin, ...[...text].map((ch) => ({ ch, brk: false })));
      },
      formatText: (d: any, sel: any) => log.push(`format:${sel.range.begin}-${sel.range.end}:${(d.kinds ?? [d.kind]).join("+")}`),
    };
    const h = load({
      "/story.js": { HardBreakType: { TableCell: CELL } },
      "/selections.js": {
        Selection: { create: (_d: any, node: any) => ({ node, range: null, addSubSelectionForNode(_n: any, sub: any) { this.range = sub.range; } }) },
        TextSelection: { create: (r: any[]) => ({ range: r[0] }) },
      },
      "/nodes.js": { TableTextNodeDefinition: { create: () => ({}) } },
      "/storydelta.js": {
        StoryDelta: {
          createFont: () => ({ kind: "font" }),
          createGlyphDouble: (_t: any, v: number) => ({ kind: `size${v}` }),
          createBrushFill: () => ({ kind: "fill" }),
          createAlignX: () => ({ kind: "align" }),
          createParagraphDouble: (t: string, v: number) => ({ kind: `${t}${v}` }),
          createComposite: (ds: any[]) => ({ kinds: ds.map((d) => d.kind) }),
        },
      },
      "/fonts.js": { FontField: { PostscriptName: 1, FamilyName: 2 } },
      "/glyphatts.js": { GlyphAttDoubleType: { Height: 0 } },
      "/fills.js": { FillDescriptor: { createSolid: (c: any) => ({ c }) } },
      "/colours.js": { RGBA8: (...a: number[]) => a },
      "/paragraphatts.js": { ParagraphAttDoubleType: { LeftIndent: "L", RightIndent: "R", FirstLineIndent: "F", SpaceBefore: "B", SpaceAfter: "A" }, ParagraphAlignXType: ENUM },
    }, "axiFont = function (n) { return { ps: n }; };");
    return { h, doc, log };
  }

  const good = { x: 90, y: 330, w: 900, h: 500, font: "Helvetica", size: 32, rows: [["a", "b"], ["c", "d"]] };

  it("defaults to a 12 px indent each side and on the first line and 6 px above and below over the whole story", () => {
    const e = setup();
    e.h.axiTable!(e.doc, good);
    const f = e.log.filter((l) => l.startsWith("format:"));
    expect(f).toEqual(["format:0-7:font+size32", "format:0-7:L12+R12+F12+B6+A6"]);
  });

  it("padding 20 gives 20 and 10", () => {
    const e = setup();
    e.h.axiTable!(e.doc, { ...good, padding: 20 });
    expect(e.log.filter((l) => l.startsWith("format:"))).toContain("format:0-7:L20+R20+F20+B10+A10");
  });

  it("padding 0 skips the call (the old look)", () => {
    const e = setup();
    e.h.axiTable!(e.doc, { ...good, padding: 0 });
    expect(e.log.filter((l) => l.startsWith("format:"))).toEqual(["format:0-7:font+size32"]);
  });

  it("rejects a negative or non-numeric padding before any SDK call", () => {
    for (const padding of [-1, "12", NaN]) {
      const e = setup();
      expect(() => e.h.axiTable!(e.doc, { ...good, padding })).toThrow(/padding must be a number >= 0/);
      expect(e.log).toEqual([]);
    }
  });
});
