// axiTable height warning: the helper logs when the finished table is taller than h.
// The helper source runs in plain Node against stubbed SDK modules and a fake table
// whose base box and transform give the measured height; console is a capturing stub.

import { describe, expect, it } from "vitest";
import { CORE_SOURCE } from "../src/affinity/helpers-core.js";
import { NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { TABLE_INDEX, TABLE_SOURCE } from "../src/affinity/helpers-table.js";

type Fn = (...a: any[]) => any;

const CELL = { value: 7 };

function run(boxH: number | "throws"): { logs: string[]; result: any; table: any } {
  // A 2x2 table: four empty cells, three break glyphs between them.
  const glyphs: Array<{ ch: string; brk: boolean }> = [
    { ch: "|", brk: true },
    { ch: "|", brk: true },
    { ch: "|", brk: true },
  ];
  const story = {
    glyphs,
    get length() {
      return glyphs.length;
    },
    getHardBreakType: (i: number) => (glyphs[i]!.brk ? CELL : null),
  };
  const table: any = {
    story,
    userDescription: "",
    transform: { applyToPoint: (p: { x: number; y: number }) => p },
  };
  Object.defineProperty(table, "baseBoxInterface", {
    get() {
      if (boxH === "throws") throw new Error("no box");
      return { baseBox: { x: 0, y: 0, width: 400, height: boxH } };
    },
  });
  const doc: any = {
    selection: { nodes: { first: table } },
    addNode() {},
    setText(text: string, sel: any) {
      glyphs.splice(sel.range.begin, sel.range.end - sel.range.begin, ...[...text].map((ch) => ({ ch, brk: false })));
    },
    formatText() {},
  };
  const mods: Record<string, any> = {
    "/story.js": { HardBreakType: { TableCell: CELL } },
    "/selections.js": {
      Selection: {
        create: (_d: any, node: any) => {
          const s: any = { node, range: null, addSubSelectionForNode: (_n: any, sub: any) => { s.range = sub.range; } };
          return s;
        },
      },
      TextSelection: { create: (r: any[]) => ({ range: r[0] }) },
    },
    "/nodes.js": { TableTextNodeDefinition: { create: () => ({}) } },
    "/storydelta.js": {
      StoryDelta: {
        createFont: () => ({}),
        createGlyphDouble: () => ({}),
        createBrushFill: () => ({}),
        createAlignX: () => ({}),
        createParagraphDouble: () => ({}),
        createComposite: () => ({}),
      },
    },
    "/fonts.js": { FontField: { PostscriptName: 1, FamilyName: 2 } },
    "/glyphatts.js": { GlyphAttDoubleType: { Height: 0 } },
    "/fills.js": { FillDescriptor: { createSolid: () => ({}) } },
    "/paragraphatts.js": { ParagraphAlignXType: {}, ParagraphAttDoubleType: {} },
  };
  const req = (m: string) => {
    if (!mods[m]) throw new Error(`SDK module ${m} touched`);
    return mods[m];
  };
  const logs: string[] = [];
  const cons = { log: (...a: unknown[]) => logs.push(a.join(" ")) };
  const body = `${CORE_SOURCE}\n${NAMED_SOURCE}\n${TABLE_SOURCE}\naxiFont = function (n) { return { ps: n }; };\nreturn axiTable;`;
  const axiTable = new Function("require", "console", body)(req, cons) as Fn;
  const o = { x: 0, y: 0, w: 400, h: 200, font: "Helvetica", size: 28, padding: 0, rows: [["a", "b"], ["c", "d"]] };
  const result = axiTable(doc, o);
  return { logs, result, table };
}

describe("axiTable height warning", () => {
  it("logs the measured height, the excess and h when the table is taller than h", () => {
    const { logs, result, table } = run(267);
    expect(logs).toEqual([
      "axiTable: the table is 267 px tall, 67 px more than h 200; rows are squeezed and may overlap: give more height, fewer rows or a smaller size",
    ]);
    expect(result).toBe(table);
  });

  it("does not log when the table fits", () => {
    expect(run(180).logs).toEqual([]);
    expect(run(200).logs).toEqual([]);
  });

  it("tolerates up to 1 px over h", () => {
    expect(run(201).logs).toEqual([]);
    expect(run(201.5).logs).toHaveLength(1);
  });

  it("never throws when the box cannot be read, and still returns the node", () => {
    const { logs, result, table } = run("throws");
    expect(logs).toEqual([]);
    expect(result).toBe(table);
  });

  it("the index summary mentions the warning", () => {
    expect(TABLE_INDEX[0]!.summary).toMatch(/warning when .*taller than h/);
  });
});
