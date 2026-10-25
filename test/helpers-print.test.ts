// axiMm, axiPrintDoc, axiPrintSheet: source hygiene, validation before any SDK call and
// geometry, with PRINT_SOURCE evaluated alone behind stubbed axi* helpers and a recording
// fake of the SDK modules. Live behaviour: test/live/print-probe.js and the helpers-print example.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { PRINT_INDEX, PRINT_INTERNAL, PRINT_SOURCE } from "../src/affinity/helpers-print.js";

type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;

// --- source hygiene ---------------------------------------------------------

describe("PRINT_SOURCE", () => {
  const declared = [...PRINT_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(PRINT_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiMm(") ? HELPERS_SOURCE : HELPERS_SOURCE + PRINT_SOURCE)).not.toThrow();
  });
  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(PRINT_SOURCE)).toEqual([]);
    expect(scanForAi(PRINT_SOURCE)).toEqual([]);
    expect(PRINT_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
    expect(PRINT_SOURCE).not.toContain("`"); // String.raw block
    expect(PRINT_SOURCE).not.toContain("${");
  });
  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of PRINT_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !PRINT_INDEX.some((h) => h.name === n)).sort()).toEqual([...PRINT_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(PRINT_INDEX.map((h) => h.name)).toEqual(["axiMm", "axiPrintDoc", "axiPrintSheet"]);
  });
  it("uses function declarations only, all prefixed axi, requires inside functions", () => {
    const top = PRINT_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
    for (const line of PRINT_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });
  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
  it("never uses a closing builder call and keeps the bleed in document units", () => {
    expect(PRINT_SOURCE).not.toMatch(/\.close\b/);
    expect(PRINT_SOURCE).toContain("op.bleed = { left: bleed, top: bleed, right: bleed, bottom: bleed }");
  });
});

// --- fake SDK and stubs -----------------------------------------------------

const STUBS = String.raw`
function axiHex(h) { return 'hex:' + h; }
function axiName(node, name) { if (name !== undefined && name !== null && node) { node.userDescription = String(name); } return node; }
function axiArtboard(doc, o) { calls.push({ kind: 'artboard', o: o }); return o; }
function axiArtboards(doc, specs) { calls.push({ kind: 'artboards', specs: specs }); return [{ name: specs[0].name, x: 100, y: 50, w: specs[0].w, h: specs[0].h }]; }
function axiOn(doc, name) { calls.push({ kind: 'on', name: name }); }
`;

function rig(dpi = 300) {
  const calls: Rec[] = [];
  const requires: string[] = [];
  const created: Rec[] = [];
  const added: Rec[] = [];
  const guides: Array<[boolean, number]> = [];
  class FakeOptions {
    v: Rec = {};
    set units(x: unknown) { this.v.units = x; }
    set width(x: number) { this.v.width = x; }
    set height(x: number) { this.v.height = x; }
    set dpi(x: number) { this.v.dpi = x; }
    set bleed(x: Rec) { this.v.bleed = x; }
    set rasterFormat(x: unknown) { this.v.rasterFormat = x; }
  }
  const doc: Rec = {
    dpi,
    sessionUuid: "U-1",
    selection: { nodes: { first: null as Rec | null } },
    addNode(def: Rec) {
      const n = { def, userDescription: "", locked: false, lock() { n.locked = true; } };
      added.push(n);
      doc.selection.nodes.first = n;
    },
    addGuide(horizontal: boolean, pos: number) { guides.push([horizontal, pos]); },
  };
  const modules: Rec = {
    "/document.js": {
      NewDocumentOptions: { createDefault: () => new FakeOptions() },
      Document: { createFromOptions: (o: FakeOptions) => { created.push(o.v); return Object.assign(doc, { createdWith: o.v }); } },
    },
    "/units.js": { UnitType: { Millimetre: "UNIT:mm", Pixel: "UNIT:px" } },
    "/rasterobject.js": { RasterFormat: { CMYKA8: "FORMAT:CMYKA8" } },
    "/geometry.js": {
      Curve: { createLineXY: (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2 }) },
      PolyCurve: { create: () => { const p: Rec = { curves: [], addCurve(c: Rec) { p.curves.push(c); } }; return p; } },
    },
    "/nodes.js": { PolyCurveNodeDefinition: { create: (poly: Rec, brush: unknown, line: unknown, style: unknown, tr: unknown) => ({ poly, brush, line, style, tr }) } },
    "/fills.js": { FillDescriptor: { createNone: () => "FILL:none", createSolid: (c: unknown) => "FILL:solid:" + String(c) } },
    "/linestyle.js": { LineStyleDescriptor: { createDefault: (w: number) => ({ weight: w }) } },
  };
  const req = (id: string) => { requires.push(id); if (!modules[id]) throw new Error("SDK not available in tests: " + id); return modules[id]; };
  const body = `${STUBS}\n${PRINT_SOURCE}\nreturn { axiMm, axiPrintDoc, axiPrintSheet, axiMarkLines };`;
  const h = new Function("require", "calls", body)(req, calls) as Record<string, Fn>;
  return { h, doc, calls, requires, created, added, guides };
}

function rejectsAll(fn: string, withDoc: boolean, bad: Array<[string, Rec | undefined, RegExp]>) {
  for (const [label, o, re] of bad) {
    it(`rejects ${label}`, () => {
      const r = rig();
      expect(() => (withDoc ? r.h[fn]!(r.doc, o) : r.h[fn]!(o))).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.created).toEqual([]);
      expect(r.added).toEqual([]);
      expect(r.calls).toEqual([]);
    });
  }
}

// --- axiMm ------------------------------------------------------------------

describe("axiMm", () => {
  it("converts millimetres at the document dpi", () => {
    expect(rig(300).h.axiMm!(rig(300).doc, 3)).toBeCloseTo(35.433, 2);
    expect(rig(72).h.axiMm!(rig(72).doc, 25.4)).toBeCloseTo(72, 6);
    expect(rig(300).h.axiMm!(rig(300).doc, 0)).toBe(0);
  });
  it("throws on a non-number and on a document without dpi", () => {
    const r = rig();
    expect(() => r.h.axiMm!(r.doc, "3")).toThrow(/mm must be a number/);
    expect(() => r.h.axiMm!(r.doc, NaN)).toThrow(/mm must be a number/);
    expect(() => r.h.axiMm!({}, 3)).toThrow(/no dpi/);
  });
});

// --- axiPrintDoc ------------------------------------------------------------

describe("axiPrintDoc", () => {
  rejectsAll("axiPrintDoc", false, [
    ["no options", undefined, /options \{w,h\}/],
    ["a bad unit", { w: 1, h: 1, unit: "cm" }, /unit must be mm or px/],
    ["a zero width", { w: 0, h: 10 }, /w and h are required/],
    ["a missing height", { w: 10 }, /w and h are required/],
    ["a dpi out of range", { w: 1, h: 1, dpi: 0 }, /dpi must be between/],
    ["a negative bleed", { w: 1, h: 1, bleed: -1 }, /bleed must be 0 or more, in mm/],
    ["a non-boolean cmyk", { w: 1, h: 1, cmyk: "yes" }, /cmyk must be true or false/],
  ]);

  it("A5 with a 3 mm bleed and CMYK: millimetre units, the bleed unchanged on all four sides, CMYKA8", () => {
    const r = rig();
    const doc = r.h.axiPrintDoc!({ w: 148, h: 210, unit: "mm", bleed: 3, cmyk: true });
    expect(r.created).toEqual([{ units: "UNIT:mm", width: 148, height: 210, dpi: 300, bleed: { left: 3, top: 3, right: 3, bottom: 3 }, rasterFormat: "FORMAT:CMYKA8" }]);
    expect(doc.axiPrint.dpi).toBe(300);
    expect(doc.axiPrint.trim.w).toBeCloseTo(1748.03, 1);
    expect(doc.axiPrint.trim.h).toBeCloseTo(2480.31, 1);
    expect(doc.axiPrint.bleed).toBeCloseTo(35.433, 2);
  });
  it("sets rasterFormat only with cmyk and a bleed only when it is above zero", () => {
    const r = rig();
    r.h.axiPrintDoc!({ w: 100, h: 50 });
    expect(r.created[0]).toEqual({ units: "UNIT:mm", width: 100, height: 50, dpi: 300 });
    expect(r.requires).not.toContain("/rasterobject.js");
  });
  it("a px document takes the bleed and the size as px at its dpi", () => {
    const r = rig();
    const doc = r.h.axiPrintDoc!({ w: 1080, h: 1350, unit: "px", dpi: 72, bleed: 24 });
    expect(r.created[0]).toEqual({ units: "UNIT:px", width: 1080, height: 1350, dpi: 72, bleed: { left: 24, top: 24, right: 24, bottom: 24 } });
    expect(doc.axiPrint).toEqual({ trim: { w: 1080, h: 1350 }, bleed: 24, dpi: 72 });
  });
});

// --- axiPrintSheet ----------------------------------------------------------

describe("axiPrintSheet", () => {
  rejectsAll("axiPrintSheet", true, [
    ["no options", undefined, /options \{w,h\}/],
    ["a bad unit", { w: 1, h: 1, unit: "in" }, /unit must be mm or px/],
    ["a missing size", { w: 10 }, /w and h are required/],
    ["an empty name", { w: 10, h: 10, name: "" }, /name must be a non-empty string/],
    ["a negative bleed", { w: 10, h: 10, bleed: -1 }, /bleed must be 0 or more/],
    ["a non-boolean marks", { w: 10, h: 10, marks: 1 }, /marks must be true or false/],
    ["a zero markWeight", { w: 10, h: 10, markWeight: 0 }, /markWeight must be positive/],
    ["a bad markColour", { w: 10, h: 10, markColour: "red" }, /markColour must be a hex string/],
    ["x without y", { w: 10, h: 10, x: 5 }, /both x and y/],
    ["a slug below the mark reach", { w: 10, h: 10, slug: 4 }, /slug 4 mm is smaller than markOffset \+ markLength; use at least 8 mm/],
  ]);

  const MM = 300 / 25.4;

  it("sizes the artboard w + 2(bleed + slug), places it after the existing ones and returns nested boxes", () => {
    const r = rig();
    const out = r.h.axiPrintSheet!(r.doc, { name: "proof", w: 148, h: 210, bleed: 3, slug: 10 });
    const spec = r.calls.find((c) => c.kind === "artboards")!.specs[0];
    expect(spec.name).toBe("proof");
    expect(spec.w).toBeCloseTo((148 + 26) * MM, 6);
    expect(spec.h).toBeCloseTo((210 + 26) * MM, 6);
    expect(out.sheet).toMatchObject({ x: 100, y: 50 });
    expect(out.trim.x).toBeCloseTo(100 + 13 * MM, 6);
    expect(out.trim.w).toBeCloseTo(148 * MM, 6);
    expect(out.bleed.x).toBeCloseTo(out.trim.x - 3 * MM, 6);
    expect(out.bleed.w).toBeCloseTo((148 + 6) * MM, 6);
    expect(out.bleed.h).toBeCloseTo((210 + 6) * MM, 6);
    expect(out.sheet.x + 13 * MM).toBeCloseTo(out.trim.x, 6);
  });

  it("an explicit x,y uses axiArtboard at that spot", () => {
    const r = rig();
    const out = r.h.axiPrintSheet!(r.doc, { name: "p2", w: 100, h: 100, x: 400, y: 20 });
    expect(r.calls.find((c) => c.kind === "artboard")!.o).toMatchObject({ name: "p2", x: 400, y: 20 });
    expect(r.calls.some((c) => c.kind === "artboards")).toBe(false);
    expect(out.sheet).toMatchObject({ x: 400, y: 20 });
  });

  it("draws eight locked, named marks outside the bleed box, each horizontal or vertical, reaching the trim edges", () => {
    const r = rig();
    const out = r.h.axiPrintSheet!(r.doc, { name: "proof", w: 148, h: 210 });
    expect(out.marks).toHaveLength(8);
    expect(r.added).toHaveLength(8);
    r.added.forEach((n, i) => {
      expect(n.userDescription).toBe(`proof-mark-${i + 1}`);
      expect(n.locked).toBe(true);
      expect(n.def.brush).toBe("FILL:none");
      expect(n.def.line).toBe("FILL:solid:hex:#000000");
      expect(n.def.style.weight).toBeCloseTo((0.25 / 72) * 300, 6);
      const c = n.def.poly.curves[0];
      expect(c.x1 === c.x2 || c.y1 === c.y2).toBe(true);
      const b = out.bleed;
      for (const [x, y] of [[c.x1, c.y1], [c.x2, c.y2]]) {
        const inside = x > b.x + 1e-6 && x < b.x + b.w - 1e-6 && y > b.y + 1e-6 && y < b.y + b.h - 1e-6;
        expect(inside).toBe(false);
      }
      const len = Math.hypot(c.x2 - c.x1, c.y2 - c.y1);
      expect(len).toBeCloseTo(5 * MM, 6);
    });
    // mark 1 sits on the trim top edge, left of the bleed box by markOffset (3 mm)
    const m1 = r.added[0]!.def.poly.curves[0];
    expect(m1.y1).toBeCloseTo(out.trim.y, 6);
    expect(out.bleed.x - m1.x1).toBeCloseTo(3 * MM, 6);
  });

  it("marks: false draws none and needs no slug; colour and weight are passed through", () => {
    const a = rig();
    const none = a.h.axiPrintSheet!(a.doc, { w: 50, h: 50, marks: false, slug: 0 });
    expect(none.marks).toEqual([]);
    expect(a.added).toEqual([]);
    const b = rig();
    b.h.axiPrintSheet!(b.doc, { w: 50, h: 50, markColour: "#112233", markWeight: 1 });
    expect(b.added[0]!.def.line).toBe("FILL:solid:hex:#112233");
    expect(b.added[0]!.def.style.weight).toBeCloseTo((1 / 72) * 300, 6);
  });

  it("a px sheet takes bleed and slug as px and defaults the mark lengths from millimetres", () => {
    const r = rig(72);
    const out = r.h.axiPrintSheet!(r.doc, { name: "card", w: 360, h: 360, unit: "px", bleed: 24, slug: 48 });
    const spec = r.calls.find((c) => c.kind === "artboards")!.specs[0];
    expect(spec.w).toBe(360 + 2 * 72);
    expect(out.trim.w).toBe(360);
    expect(out.bleed.w).toBe(408);
    expect(r.added).toHaveLength(8);
    const len = Math.hypot(...(() => { const c = r.added[0]!.def.poly.curves[0]; return [c.x2 - c.x1, c.y2 - c.y1]; })());
    expect(len).toBeCloseTo((5 / 25.4) * 72, 6);
  });

  it("guides: true adds eight guides at the trim and bleed edges, spread coordinates", () => {
    const r = rig(72);
    const out = r.h.axiPrintSheet!(r.doc, { w: 360, h: 360, unit: "px", bleed: 24, slug: 48, guides: true, marks: false });
    expect(r.guides).toHaveLength(8);
    const horizontal = r.guides.filter((g) => g[0]).map((g) => g[1]).sort((a, b) => a - b);
    const vertical = r.guides.filter((g) => !g[0]).map((g) => g[1]).sort((a, b) => a - b);
    expect(horizontal).toEqual([out.bleed.y, out.trim.y, out.trim.y + 360, out.bleed.y + out.bleed.h]);
    expect(vertical).toEqual([out.bleed.x, out.trim.x, out.trim.x + 360, out.bleed.x + out.bleed.w]);
    const none = rig(72);
    none.h.axiPrintSheet!(none.doc, { w: 360, h: 360, unit: "px", bleed: 24, slug: 48 });
    expect(none.guides).toEqual([]);
  });
});
