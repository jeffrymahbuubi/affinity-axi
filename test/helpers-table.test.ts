// Table helper: source hygiene, validation before any SDK call, and the cell
// bookkeeping against stubbed SDK modules. The live behaviour (cell starts on
// a real table text node, formatting, run time) is covered by the example.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { CORE_SOURCE } from "../src/affinity/helpers-core.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { TABLE_INDEX, TABLE_INTERNAL, TABLE_SOURCE } from "../src/affinity/helpers-table.js";

type Fn = (...a: any[]) => any;

// --- source hygiene ---------------------------------------------------------

describe("TABLE_SOURCE", () => {
  const declared = [...TABLE_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(TABLE_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + TABLE_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(TABLE_SOURCE)).toEqual([]);
    expect(scanForAi(TABLE_SOURCE)).toEqual([]);
    expect(TABLE_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(TABLE_SOURCE).not.toContain("`");
    expect(TABLE_SOURCE).not.toContain("${");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of TABLE_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !TABLE_INDEX.some((h) => h.name === n)).sort()).toEqual([...TABLE_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = TABLE_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("has every require inside a function", () => {
    for (const l of TABLE_SOURCE.split("\n").filter((x) => x.includes("require("))) expect(l).toMatch(/^\s+/);
  });

  it("every index entry has a signature naming the helper and a summary", () => {
    for (const h of TABLE_INDEX) {
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary.length).toBeGreaterThan(10);
    }
  });
});

// --- a fake SDK ---------------------------------------------------------------

/** Hard-break glyph marker the fake story reports. */
const CELL = { value: 7 };

/** A story of cells: positions follow the real layout, one break glyph between cells. */
function storyOf(cells: string[]) {
  const glyphs: Array<{ ch: string; brk: boolean }> = [];
  cells.forEach((c, i) => {
    for (const ch of c) glyphs.push({ ch, brk: false });
    if (i < cells.length - 1) glyphs.push({ ch: "|", brk: true });
  });
  return {
    glyphs,
    get length() {
      return glyphs.length;
    },
    getHardBreakType(i: number) {
      return glyphs[i]!.brk ? CELL : null;
    },
  };
}

interface Env {
  fn: Record<string, Fn>;
  doc: any;
  log: string[];
  table: any;
  texts(): string[];
  /** Fake table width: `width` is what getSpreadVisibleBox reports, `onFormat` sees each format call, `throws` makes the read fail. */
  state: { width: number; reads: number; throws: boolean; onFormat?: (kinds: string[]) => void };
}

/** Evaluates the core helpers and the table block with a stubbed `require` and a fake document. */
function setup(cols: number, rowsN: number): Env {
  const log: string[] = [];
  const cellsEmpty = Array.from({ length: cols * rowsN }, () => "");
  const story = storyOf(cellsEmpty);
  const state: Env["state"] = { width: 900, reads: 0, throws: false };
  const table: any = {
    story,
    userDescription: "",
    getSpreadVisibleBox() {
      state.reads++;
      if (state.throws) throw new Error("no box");
      return { width: state.width, height: 500 };
    },
  };

  // Cell contents derived from the story so range maths can be checked.
  const texts = (): string[] => {
    const out: string[] = [""];
    for (const g of story.glyphs) {
      if (g.brk) out.push("");
      else out[out.length - 1] += g.ch;
    }
    return out;
  };

  const doc: any = {
    selection: { nodes: { first: table } },
    addNode(def: any) {
      log.push(`addNode:${def.cols}x${def.rows}@${def.box.x},${def.box.y},${def.box.width},${def.box.height}`);
    },
    setText(text: string, sel: any) {
      const r = sel.range;
      log.push(`setText:${r.begin}-${r.end}:${text}`);
      story.glyphs.splice(r.begin, r.end - r.begin, ...[...text].map((ch) => ({ ch, brk: false })));
    },
    formatText(delta: any, sel: any) {
      const kinds: string[] = delta.kinds ?? [delta.kind];
      log.push(`format:${sel.range.begin}-${sel.range.end}:${kinds.join("+")}`);
      state.onFormat?.(kinds);
    },
  };

  const mods: Record<string, any> = {
    "/story.js": { HardBreakType: { TableCell: CELL } },
    "/selections.js": {
      Selection: {
        create(_d: any, node: any) {
          const s: any = { node, range: null, addSubSelectionForNode(_n: any, sub: any) { s.range = sub.range; } };
          return s;
        },
      },
      TextSelection: { create: (r: any[]) => ({ range: r[0] }) },
    },
    "/nodes.js": {
      TableTextNodeDefinition: { create: (box: any, size: any) => ({ box, cols: size.width, rows: size.height }) },
    },
    "/storydelta.js": {
      StoryDelta: {
        createFont: () => ({ kind: "font" }),
        createGlyphDouble: (_t: any, v: number) => ({ kind: `size${v}` }),
        createBrushFill: () => ({ kind: "fill" }),
        createAlignX: (v: any) => ({ kind: `align${v}` }),
        createParagraphDouble: (t: string, v: number) => ({ kind: `${t}${v}` }),
        createComposite: (ds: any[]) => ({ kinds: ds.map((d) => d.kind) }),
      },
    },
    "/fonts.js": { FontField: { PostscriptName: 1, FamilyName: 2 } },
    "/glyphatts.js": { GlyphAttDoubleType: { Height: 0 } },
    "/fills.js": { FillDescriptor: { createSolid: (c: any) => ({ c }) } },
    "/colours.js": { RGBA8: (...a: number[]) => a },
    "/paragraphatts.js": {
      ParagraphAlignXType: { Left: "L", Centre: "C", Right: "R", JustifyLeft: "J" },
      ParagraphAttDoubleType: { LeftIndent: "LeftIndent", RightIndent: "RightIndent", FirstLineIndent: "FirstLineIndent", SpaceBefore: "SpaceBefore", SpaceAfter: "SpaceAfter" },
    },
  };
  const req = (m: string) => {
    if (!mods[m]) throw new Error(`SDK module ${m} touched`);
    return mods[m];
  };
  const names = [...(CORE_SOURCE + TABLE_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${CORE_SOURCE}\n${TABLE_SOURCE}\naxiFont = function (n) { return { ps: n }; };\nreturn { ${names.join(", ")} };`;
  const fn = new Function("require", body)(req) as Record<string, Fn>;
  return { fn, doc, log, table, texts, state };
}

const good = { x: 90, y: 330, w: 900, h: 500, font: "Helvetica", size: 32, padding: 0, rows: [["Room", "Hourly"], ["A", "40"], ["B", "55"]] };

// --- validation ----------------------------------------------------------------

describe("axiTable validation", () => {
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["empty rows", { rows: [] }, /rows must be a non-empty array/],
    ["rows not an array", { rows: "a" }, /rows must be a non-empty array/],
    ["empty first row", { rows: [[]] }, /row 0 must be a non-empty array/],
    ["ragged row (names the index)", { rows: [["a", "b"], ["c"]] }, /row 1 has 1 cells, expected 2/],
    ["ragged later row", { rows: [["a"], ["b"], ["c", "d"]] }, /row 2 has 2 cells, expected 1/],
    ["a row that is not an array", { rows: [["a"], "b"] }, /row 1 is not an array/],
    ["more than 400 cells", { rows: Array.from({ length: 21 }, () => Array.from({ length: 20 }, () => "x")) }, /420 cells; at most 400/],
    ["no x", { x: undefined }, /x and y are required/],
    ["zero width", { w: 0 }, /w and h must be positive/],
    ["no font", { font: undefined }, /font .* is required/],
    ["zero size", { size: 0 }, /size must be a positive number/],
    ["bad colour", { colour: "red" }, /colour must be a hex string/],
    ["bad header", { header: "bold" }, /header must be false or/],
    ["bad header size", { header: { size: -1 } }, /header.size must be a positive number/],
    ["bad header colour", { header: { colour: "#12" } }, /header.colour must be a hex string/],
    ["unknown align", { align: "x" }, /align must be l, c, r or j/],
  ];
  for (const [label, patch, re] of bad) {
    it(`rejects ${label} before touching the SDK`, () => {
      const e = setup(2, 3);
      expect(() => e.fn.axiTable!(e.doc, { ...good, ...patch })).toThrow(re);
      expect(e.log).toEqual([]);
    });
  }

  it("accepts exactly 400 cells", () => {
    const e = setup(20, 20);
    const rows = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => ""));
    expect(() => e.fn.axiTable!(e.doc, { ...good, rows })).not.toThrow();
  });

  it("rejects missing options", () => {
    const e = setup(2, 3);
    expect(() => e.fn.axiTable!(e.doc)).toThrow(/options are required/);
  });
});

// --- cell starts and range -----------------------------------------------------------

describe("axiCellStarts", () => {
  it("finds the first glyph of every cell by the break markers", () => {
    const e = setup(1, 1);
    expect(e.fn.axiCellStarts!(storyOf(["ab", "", "cde", "f"]))).toEqual([0, 3, 4, 8]);
  });

  it("one cell gives [0]; an empty table of 3 cells gives 0,1,2", () => {
    const e = setup(1, 1);
    expect(e.fn.axiCellStarts!(storyOf(["abc"]))).toEqual([0]);
    expect(e.fn.axiCellStarts!(storyOf(["", "", ""]))).toEqual([0, 1, 2]);
  });
});

describe("axiCellRange", () => {
  it("selects the table with a text sub-selection", () => {
    const e = setup(1, 1);
    const sel = e.fn.axiCellRange!(e.doc, e.table, 3, 9);
    expect(sel.node).toBe(e.table);
    expect(sel.range).toEqual({ begin: 3, end: 9 });
  });
});

// --- building ---------------------------------------------------------------------------

describe("axiTable build", () => {
  it("creates the table with cols x rows at the box and returns the named node", () => {
    const e = setup(2, 3);
    const n = e.fn.axiTable!(e.doc, { ...good, name: "prices" });
    expect(n).toBe(e.table);
    expect(n.userDescription).toBe("prices");
    expect(e.log[0]).toBe("addNode:2x3@90,330,900,500");
  });

  it("fills cells last to first and puts each text in its own cell", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, good);
    const sets = e.log.filter((l) => l.startsWith("setText:")).map((l) => l.split(":")[2]);
    expect(sets).toEqual(["55", "B", "40", "A", "Hourly", "Room"]);
    expect(e.texts()).toEqual(["Room", "Hourly", "A", "40", "B", "55"]);
  });

  it("stringifies numbers, skips empty cells and null", () => {
    const e = setup(2, 2);
    e.fn.axiTable!(e.doc, { ...good, rows: [["k", "v"], [7, null]] });
    expect(e.texts()).toEqual(["k", "v", "7", ""]);
    expect(e.log.filter((l) => l.startsWith("setText:"))).toHaveLength(3);
  });

  it("styles the whole story first, then the header cells only", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, { ...good, colour: "#F2F5F9", header: { font: "Helvetica-Bold", size: 36, colour: "#4C8DFF" } });
    const f = e.log.filter((l) => l.startsWith("format:"));
    // story "Room|Hourly|A|40|B|55" -> header = cells 0..1 = positions 0..11 ("Room|Hourly" is 11 glyphs)
    expect(f).toEqual(["format:0-21:font+size32+fill", "format:0-11:font+size36+fill"]);
  });

  it("header:false skips the header format", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, { ...good, header: false });
    expect(e.log.filter((l) => l.startsWith("format:"))).toHaveLength(1);
  });

  it("no header options means no header format either (the first row is just the first row)", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, good);
    expect(e.log.filter((l) => l.startsWith("format:"))).toHaveLength(1);
  });

  it("a single-row table styles the header to the end of the story", () => {
    const e = setup(2, 1);
    e.fn.axiTable!(e.doc, { ...good, rows: [["a", "b"]], header: { size: 40 } });
    const f = e.log.filter((l) => l.startsWith("format:"));
    expect(f[1]).toBe("format:0-3:size40");
  });

  it("align adds one paragraph format over the whole story", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, { ...good, align: "c" });
    expect(e.log.filter((l) => l.startsWith("format:"))).toContain("format:0-21:alignC");
  });

  it("throws when the table does not have the expected number of cells", () => {
    const e = setup(2, 2);
    expect(() => e.fn.axiTable!(e.doc, good)).toThrow(/expected 6 cells, the table has 4/);
  });
});

// --- padding: first-line indent and the width guard -------------------------------------

describe("axiTable padding guard", () => {
  const padded = { ...good, padding: 12 };
  const padFormats = (log: string[]) => log.filter((l) => l.includes("FirstLineIndent"));

  it("padding adds five paragraph deltas including FirstLineIndent, once when the width fits", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, padded);
    expect(padFormats(e.log)).toEqual(["format:0-21:LeftIndent12+RightIndent12+FirstLineIndent12+SpaceBefore6+SpaceAfter6"]);
    expect(e.state.reads).toBe(1);
  });

  it("a width of w + 0.5 still counts as fitting", () => {
    const e = setup(2, 3);
    e.state.width = 900.5;
    e.fn.axiTable!(e.doc, padded);
    expect(padFormats(e.log)).toHaveLength(1);
  });

  it("a too-wide table steps the padding down by 2 until it fits", () => {
    const e = setup(2, 3);
    e.state.width = 906;
    e.state.onFormat = (kinds) => {
      if (kinds.some((k) => k.startsWith("FirstLineIndent"))) {
        const pad = Number(kinds.find((k) => k.startsWith("FirstLineIndent"))!.slice("FirstLineIndent".length));
        e.state.width = 906 - ((12 - pad) / 2) * 3;
      }
    };
    e.state.width = 906;
    e.fn.axiTable!(e.doc, padded);
    const f = padFormats(e.log);
    expect(f.map((l) => l.match(/FirstLineIndent(\d+)/)![1])).toEqual(["12", "10", "8"]);
    expect(f[2]).toContain("LeftIndent8+RightIndent8+FirstLineIndent8+SpaceBefore4+SpaceAfter4");
  });

  it("a table that never fits ends at padding 0 (a final format with 0) and stops", () => {
    const e = setup(2, 3);
    e.state.width = 5000;
    e.fn.axiTable!(e.doc, { ...padded, padding: 5 });
    const f = padFormats(e.log);
    expect(f.map((l) => l.match(/FirstLineIndent(\d+)/)![1])).toEqual(["5", "3", "1", "0"]);
  });

  it("padding 0 writes no paragraph format and never reads the box", () => {
    const e = setup(2, 3);
    e.fn.axiTable!(e.doc, good);
    expect(padFormats(e.log)).toEqual([]);
    expect(e.state.reads).toBe(0);
  });

  it("a width read that throws ends the loop after the first format", () => {
    const e = setup(2, 3);
    e.state.throws = true;
    expect(() => e.fn.axiTable!(e.doc, padded)).not.toThrow();
    expect(padFormats(e.log)).toHaveLength(1);
  });
});
