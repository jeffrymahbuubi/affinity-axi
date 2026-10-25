// INSPECT adds `ink` (the exact visible box) to text rows only, inside safe(...).
// Source checks plus runs of the script against a stub document.

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { INSPECT } from "../src/affinity/inspect-script.js";
import type { Inventory } from "../src/affinity/manifest-types.js";

type Rect = { x: number; y: number; width: number; height: number };

function fakeNode(opts: { text?: string; box: Rect; ink?: Rect | "throws" }): Record<string, unknown> {
  const n: Record<string, unknown> = {
    [Symbol.toStringTag]: opts.text !== undefined ? "ArtTextNode" : "ShapeNode",
    children: [],
    userDescription: "",
    isVisible: true,
    getSpreadVisibleBox: () => opts.box,
  };
  if (opts.text !== undefined) {
    n["text"] = opts.text;
    n["story"] = { getGlyphAttRunsFrom: () => [{ glyphAtts: { font: { postscriptName: "Helvetica" }, height: 40, brushFill: null } }] };
    n["getExactSpreadVisibleBox"] = opts.ink === "throws" ? () => { throw new Error("no ink"); } : () => opts.ink;
  }
  return n;
}

function run(nodes: unknown[]): Inventory {
  const doc = { sessionUuid: "u", title: "t", path: "", units: "Pixel", widthPixels: 1080, heightPixels: 1080, dpi: 72, spreads: [{ children: nodes }] };
  let line = "";
  const sandbox = {
    require: () => ({ Document: { current: doc, all: [doc] } }),
    console: { log: (s: string) => { line = s; } },
  };
  vm.runInNewContext(`(function(){${INSPECT("current")}\n})()`, sandbox);
  return JSON.parse(line) as Inventory;
}

describe("INSPECT ink box", () => {
  it("reads the exact visible box once, for text rows, inside safe(...)", () => {
    const s = INSPECT("current");
    expect(s.match(/getExactSpreadVisibleBox\(false, false\)/g)).toHaveLength(1);
    expect(s).toContain("safe(() => inkOf(n), undefined)");
    // row.ink is set inside the `if (isText) { ... }` block (no closing brace in between)
    expect(s).toMatch(/if \(isText\) \{[^}]*row\.ink = ink;/);
  });

  it("adds ink to text rows only", () => {
    const inv = run([
      fakeNode({ text: "Hi", box: { x: 790, y: 100, width: 299, height: 60 }, ink: { x: 788.4, y: 101, width: 280, height: 58 } }),
      fakeNode({ box: { x: 0, y: 0, width: 50, height: 50 } }),
    ]);
    expect(inv.nodes[0]!.ink).toEqual([788, 101, 280, 58]);
    expect(inv.nodes[0]!.box).toEqual([790, 100, 299, 60]);
    expect(inv.nodes[1]).not.toHaveProperty("ink");
  });

  it("omits ink when the read throws, keeping the row", () => {
    const inv = run([fakeNode({ text: "Hi", box: { x: 1, y: 2, width: 3, height: 4 }, ink: "throws" })]);
    expect(inv.nodes).toHaveLength(1);
    expect(inv.nodes[0]).not.toHaveProperty("ink");
    expect(inv.nodes[0]!.text).toBe("Hi");
  });
});
