// Shape helpers (axiPolygon, axiPath, axiWedge, axiRotate, axiLens): source hygiene,
// validation before any SDK call, and the SDK calls made against stubbed modules.
// Live behaviour: test/live/vector-probe.js RESULT block.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { VECTOR_SOURCE } from "../src/affinity/helpers-vector.js";
import { SHAPES_INDEX, SHAPES_INTERNAL, SHAPES_SOURCE } from "../src/affinity/helpers-shapes.js";

type Fn = (...a: any[]) => any;

describe("SHAPES_SOURCE", () => {
  const declared = [...SHAPES_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(SHAPES_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + SHAPES_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and never closes anything", () => {
    expect(scanForBlocking(SHAPES_SOURCE)).toEqual([]);
    expect(scanForAi(SHAPES_SOURCE)).toEqual([]);
    expect(SHAPES_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick, dollar-brace or backslash (it lives in a String.raw block)", () => {
    expect(SHAPES_SOURCE).not.toContain("`");
    expect(SHAPES_SOURCE).not.toContain("${");
    expect(SHAPES_SOURCE).not.toContain("\\");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of SHAPES_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !SHAPES_INDEX.some((h) => h.name === n)).sort()).toEqual([...SHAPES_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = SHAPES_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("collides with no name in the existing helpers", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("every index entry has a signature naming the helper and a summary", () => {
    for (const h of SHAPES_INDEX) {
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary.length).toBeGreaterThan(10);
    }
  });

  it("keeps SDK requires inside functions and states units and direction", () => {
    expect(SHAPES_SOURCE.split("\n").filter((l) => /^\S/.test(l) && l.includes("require("))).toEqual([]);
    const text = (n: string) => SHAPES_INDEX.find((h) => h.name === n)!.summary;
    expect(text("axiRotate")).toMatch(/clockwise/);
    expect(text("axiWedge")).toMatch(/12 o'clock/);
    expect(text("axiPolygon")).toMatch(/axiBool subtract/);
  });
});

// --- stubs ----------------------------------------------------------------------

class FakeNode {
  isNode = true;
  children: FakeNode[] = [];
  isArtboardEnabled = false;
  userDescription = "";
  constructor(public box = { x: 0, y: 0, w: 100, h: 50 }) {}
  get baseBoxInterface() {
    return { baseBox: { x: this.box.x, y: this.box.y, width: this.box.w, height: this.box.h } };
  }
  get transform() {
    return { applyToPoint: (p: { x: number; y: number }) => p };
  }
}

interface Ctx {
  doc: Record<string, any>;
  events: any[];
  required: string[];
  nodes: FakeNode[];
}

function load() {
  const names = [...(HELPERS_SOURCE + NAMED_SOURCE + VECTOR_SOURCE + SHAPES_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${NAMED_SOURCE}\n${VECTOR_SOURCE}\n${SHAPES_SOURCE}\nreturn { ${names.join(", ")} };`;
  const events: any[] = [];
  const required: string[] = [];
  const nodes: FakeNode[] = [];
  const state = { selected: [] as FakeNode[] };

  class CurveBuilder {
    calls: any[] = [];
    beginXY(x: number, y: number) { this.calls.push(["begin", x, y]); return this; }
    lineToXY(x: number, y: number) { this.calls.push(["line", x, y]); return this; }
    addBezierXY(...a: number[]) { this.calls.push(["bezier", ...a]); return this; }
    createCurve() { return { builder: this }; }
  }
  const PolyCurve = { create: () => ({ curves: [] as any[], addCurve(c: any) { this.curves.push(c); } }) };
  const sdk: Record<string, any> = {
    "/geometry.js": {
      CurveBuilder,
      PolyCurve,
      Transform: {
        createTranslate: (x: number, y: number) => ({ t: [x, y], multiply(o: any) { return { seq: [this, o], multiply(p: any) { return { seq: [this, p] }; } }; } }),
        createRotate: (r: number) => ({ rot: r }),
      },
    },
    "/nodes.js": { PolyCurveNodeDefinition: { create: (...a: any[]) => ({ def: "poly", args: a }) }, ShapeNodeDefinition: { create: (...a: any[]) => ({ def: "shape", args: a }) } },
    "/fills.js": { FillDescriptor: { createNone: () => "none", createSolid: (c: any) => ({ solid: c }) } },
    "/linestyle.js": { LineStyle: { create: (o: any) => ({ ls: o }) }, LineStyleDescriptor: { create: (l: any) => ({ lsd: l }) } },
    "/colours.js": { RGBA8: (r: number, g: number, b: number, a: number) => [r, g, b, a] },
    "/shapes.js": { ShapeEllipse: { create: () => ({ ellipse: true }) }, ShapePie: { create: () => ({ pie: true }) } },
    "/commands.js": { DocumentCommand: { createTransform: (sel: any, xf: any) => ({ cmd: "transform", sel, xf }) } },
    "/selections.js": { Selection: { create: (_d: unknown, items: FakeNode | FakeNode[]) => ({ nodes: Array.isArray(items) ? items : [items] }) } },
  };
  const req = (id: string) => {
    required.push(id);
    if (!sdk[id]) throw new Error(`SDK module ${id} not available in tests`);
    return sdk[id];
  };
  const fns = new Function("require", body)(req) as Record<string, Fn>;

  const doc: Record<string, any> = {
    spreads: [],
    get selection() {
      return { nodes: { first: state.selected[0], [Symbol.iterator]: () => state.selected[Symbol.iterator]() } };
    },
    set selection(_v: unknown) {},
    addNode(def: any) {
      const n = new FakeNode(def.def === "shape" ? { x: def.args[1].x, y: def.args[1].y, w: def.args[1].width, h: def.args[1].height } : undefined);
      nodes.push(n);
      state.selected = [n];
      events.push({ add: def });
    },
    executeCommand(c: any) { events.push({ exec: c }); },
    boolOpIntersect(sel: { nodes: FakeNode[] }) {
      events.push({ intersect: sel.nodes });
      const r = new FakeNode();
      nodes.push(r);
      state.selected = [r];
    },
  };
  return { h: fns, ctx: { doc, events, required, nodes } as Ctx };
}

const build = (b: any) => b.curves[0].builder.calls;

// --- axiPolygon -----------------------------------------------------------------

describe("axiPolygon", () => {
  const tri: any[] = [[0, 0], { x: 100, y: 0 }, [50, 80]];

  it("walks points given as arrays and objects in order and ends with a line back to the start", () => {
    const { h, ctx } = load();
    const n = h.axiPolygon(ctx.doc, tri, { fill: "#112233", name: "tri" });
    const def = ctx.events[0].add;
    expect(build(def.args[0])).toEqual([["begin", 0, 0], ["line", 100, 0], ["line", 50, 80], ["line", 0, 0]]);
    expect(n.userDescription).toBe("tri");
    expect(n).toBe(ctx.nodes[0]);
  });

  it("never passes null: brush, pen, style and transparency are descriptors", () => {
    const { h, ctx } = load();
    h.axiPolygon(ctx.doc, tri, { fill: "#112233" });
    const [, brush, pen, style, transp] = ctx.events[0].add.args;
    expect(brush).toEqual({ solid: [0x11, 0x22, 0x33, 255] });
    expect(pen).toBe("none");
    expect(style).toEqual({ lsd: { ls: { weight: 1 } } });
    expect(transp).toBe("none");
  });

  it("sends fillAlpha through axiHex and uses stroke colour and width for the pen", () => {
    const { h, ctx } = load();
    h.axiPolygon(ctx.doc, tri, { fill: "#000000", fillAlpha: 0.5, stroke: "#ff0000", strokeWidth: 6 });
    const a = ctx.events[0].add.args;
    expect(a[1]).toEqual({ solid: [0, 0, 0, 128] });
    expect(a[2]).toEqual({ solid: [255, 0, 0, 255] });
    expect(a[3]).toEqual({ lsd: { ls: { weight: 6 } } });
  });

  it("closed:false adds no closing line and needs stroke", () => {
    const { h, ctx } = load();
    h.axiPolygon(ctx.doc, [[0, 0], [10, 10]], { stroke: "#000", closed: false });
    expect(build(ctx.events[0].add.args[0])).toEqual([["begin", 0, 0], ["line", 10, 10]]);
    expect(() => h.axiPolygon(ctx.doc, [[0, 0], [10, 10]], { fill: "#000", closed: false })).toThrow("closed:false needs stroke");
  });

  it("validates before any require or node", () => {
    const { h, ctx } = load();
    expect(() => h.axiPolygon(ctx.doc, [[0, 0], [1, 1]], { fill: "#000" })).toThrow("axiPolygon: at least 3 points are required");
    expect(() => h.axiPolygon(ctx.doc, [[0, 0], [1, 1], [1, "x"]], { fill: "#000" })).toThrow("axiPolygon: point 2 needs numbers x and y");
    expect(() => h.axiPolygon(ctx.doc, tri, {})).toThrow("axiPolygon: fill or stroke is required");
    expect(() => h.axiPolygon(ctx.doc, tri, { stroke: "#000", strokeWidth: 0 })).toThrow("strokeWidth must be positive");
    expect(ctx.required).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });
});

// --- axiPath --------------------------------------------------------------------

describe("axiPath", () => {
  it("maps M, L and C to beginXY, lineToXY and addBezierXY in SDK order, and Z to a line back", () => {
    const { h, ctx } = load();
    h.axiPath(ctx.doc, [["M", 0, 0], ["C", 0, 100, 100, 100, 100, 0], ["L", 50, -20], ["Z"]], { fill: "#abc", name: "p" });
    expect(build(ctx.events[0].add.args[0])).toEqual([["begin", 0, 0], ["bezier", 0, 100, 100, 100, 100, 0], ["line", 50, -20], ["line", 0, 0]]);
    expect(ctx.nodes[0]!.userDescription).toBe("p");
  });

  it("adds no line for Z when the pen is already at the start", () => {
    const { h, ctx } = load();
    h.axiPath(ctx.doc, [["M", 0, 0], ["L", 10, 0], ["L", 0, 0], ["Z"]], { stroke: "#000" });
    expect(build(ctx.events[0].add.args[0])).toEqual([["begin", 0, 0], ["line", 10, 0], ["line", 0, 0]]);
  });

  it("throws the frozen errors before any require", () => {
    const { h, ctx } = load();
    expect(() => h.axiPath(ctx.doc, [["L", 0, 0]], { fill: "#000" })).toThrow("axiPath: the first segment must be ['M', x, y]");
    expect(() => h.axiPath(ctx.doc, [], { fill: "#000" })).toThrow("axiPath: the first segment");
    expect(() => h.axiPath(ctx.doc, [["M", 0, 0], ["Q", 1, 1]], { fill: "#000" })).toThrow("axiPath: segment 1 must be L, C or a final Z");
    expect(() => h.axiPath(ctx.doc, [["M", 0, 0], ["C", 1, 1, 2, 2], ["L", 1, 1]], { fill: "#000" })).toThrow("segment 1 must be L, C or a final Z");
    expect(() => h.axiPath(ctx.doc, [["M", 0, 0], ["Z"], ["L", 1, 1]], { fill: "#000" })).toThrow("segment 1 must be L, C or a final Z");
    expect(() => h.axiPath(ctx.doc, [["M", 0, 0], ["L", 1, 1]], {})).toThrow("axiPath: fill or stroke is required");
    expect(ctx.required).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });
});

// --- axiWedge -------------------------------------------------------------------

describe("axiWedge", () => {
  it("draws a pie shape through axiPieSlice with the screen angles", () => {
    const { h, ctx } = load();
    h.axiWedge(ctx.doc, { cx: 50, cy: 60, r: 40, sweep: 90, fill: "#123456", name: "q" });
    const def = ctx.events[0].add;
    expect(def.args[1]).toEqual({ x: 10, y: 20, width: 80, height: 80 });
    expect(ctx.nodes[0]!.userDescription).toBe("q");
  });

  it("sets the stored angle from start and sweep (start 0, sweep 90: -(-PI/2 + PI/2) = 0; sweep 360: a full ring)", () => {
    const { h, ctx } = load();
    let pie: any = null;
    const orig = (ctx.doc as any).addNode;
    ctx.doc.addNode = (def: any) => { pie = def.args[0]; orig(def); };
    h.axiWedge(ctx.doc, { cx: 0, cy: 0, r: 10, sweep: 90, fill: "#000" });
    expect(pie.sweep).toBeCloseTo(Math.PI / 2, 10);
    expect(pie.startAngle).toBeCloseTo(0, 10);
    h.axiWedge(ctx.doc, { cx: 0, cy: 0, r: 10, sweep: 360, inner: 0.5, fill: "#000" });
    expect(pie.sweep).toBeCloseTo(2 * Math.PI, 10);
    expect(pie.innerRadius).toBe(0.5);
  });

  it("throws the frozen errors before any require", () => {
    const { h, ctx } = load();
    const ok = { cx: 0, cy: 0, r: 5, sweep: 90, fill: "#000" };
    expect(() => h.axiWedge(ctx.doc, { ...ok, sweep: 0 })).toThrow("axiWedge: sweep must be above 0 and at most 360");
    expect(() => h.axiWedge(ctx.doc, { ...ok, sweep: 361 })).toThrow("axiWedge: sweep must be above 0 and at most 360");
    expect(() => h.axiWedge(ctx.doc, { ...ok, inner: 0.96 })).toThrow("axiWedge: inner must be 0 to 0.95");
    expect(() => h.axiWedge(ctx.doc, { ...ok, fill: undefined })).toThrow("fill");
    expect(() => h.axiWedge(ctx.doc, { ...ok, r: 0 })).toThrow("r is required");
    expect(ctx.required).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });
});

// --- axiRotate ------------------------------------------------------------------

function seq(xf: any): any[] {
  return xf.seq ? xf.seq.flatMap(seq) : [xf];
}

describe("axiRotate", () => {
  it("builds T(c) R T(-c) about the box centre, converts degrees to radians and returns the node", () => {
    const { h, ctx } = load();
    const n = new FakeNode({ x: 10, y: 20, w: 200, h: 100 });
    const out = h.axiRotate(ctx.doc, n, 90);
    expect(out).toBe(n);
    const cmd = ctx.events[0].exec;
    expect(cmd.sel.nodes).toEqual([n]);
    const parts = seq(cmd.xf);
    expect(parts[0].t).toEqual([110, 70]);
    expect(parts[1].rot).toBeCloseTo(Math.PI / 2, 10);
    expect(parts[2].t).toEqual([-110, -70]);
  });

  it("rotates about {cx, cy} when given, and by a negative angle", () => {
    const { h, ctx } = load();
    const n = new FakeNode();
    h.axiRotate(ctx.doc, n, -45, { cx: 5, cy: 6 });
    const parts = seq(ctx.events[0].exec.xf);
    expect(parts[0].t).toEqual([5, 6]);
    expect(parts[1].rot).toBeCloseTo(-Math.PI / 4, 10);
    expect(parts[2].t).toEqual([-5, -6]);
  });

  it("returns the node untouched for 0 and runs no command", () => {
    const { h, ctx } = load();
    const n = new FakeNode();
    expect(h.axiRotate(ctx.doc, n, 0)).toBe(n);
    expect(ctx.events).toEqual([]);
    expect(ctx.required).toEqual([]);
  });

  it("throws on bad degrees, pivot or ref before any SDK module is required", () => {
    const { h, ctx } = load();
    const n = new FakeNode();
    expect(() => h.axiRotate(ctx.doc, n, NaN)).toThrow("axiRotate: degrees must be a finite number");
    expect(() => h.axiRotate(ctx.doc, n, "90")).toThrow("axiRotate: degrees must be a finite number");
    expect(() => h.axiRotate(ctx.doc, n, 10, { cx: Infinity })).toThrow("cx and cy must be finite numbers");
    expect(() => h.axiRotate(ctx.doc, 42, 10)).toThrow("axiRotate: each ref must be");
    expect(ctx.required).toEqual([]);
  });
});

// --- axiLens --------------------------------------------------------------------

describe("axiLens", () => {
  it("draws two circles at cx -+ d/2, intersects exactly those two nodes, and applies name", () => {
    const { h, ctx } = load();
    const out = h.axiLens(ctx.doc, { cx: 100, cy: 80, r: 50, d: 40, fill: "#336699", fillAlpha: 0.5, name: "lens" });
    const [a, b] = [ctx.events[0].add, ctx.events[1].add];
    expect(a.args[1]).toEqual({ x: 30, y: 30, width: 100, height: 100 });
    expect(b.args[1]).toEqual({ x: 70, y: 30, width: 100, height: 100 });
    expect(a.args[2]).toEqual([0x33, 0x66, 0x99, 128]);
    expect(ctx.events[2].intersect).toEqual([ctx.nodes[0], ctx.nodes[1]]);
    expect(out).toBe(ctx.nodes[2]);
    expect(out.userDescription).toBe("lens");
    expect(ctx.events.some((e) => e.exec)).toBe(false);
  });

  it("rotates the result about cx,cy only when rotate is set", () => {
    const { h, ctx } = load();
    const out = h.axiLens(ctx.doc, { cx: 100, cy: 80, r: 50, d: 40, fill: "#000", rotate: 45 });
    const cmd = ctx.events.find((e) => e.exec)!.exec;
    expect(cmd.sel.nodes).toEqual([out]);
    const parts = seq(cmd.xf);
    expect(parts[0].t).toEqual([100, 80]);
    expect(parts[1].rot).toBeCloseTo(Math.PI / 4, 10);
  });

  it("throws the frozen errors before any require or node", () => {
    const { h, ctx } = load();
    const ok = { cx: 0, cy: 0, r: 10, d: 5, fill: "#000" };
    expect(() => h.axiLens(ctx.doc, { ...ok, d: 0 })).toThrow("axiLens: d must be above 0 and below 2 * r");
    expect(() => h.axiLens(ctx.doc, { ...ok, d: 20 })).toThrow("axiLens: d must be above 0 and below 2 * r");
    expect(() => h.axiLens(ctx.doc, { ...ok, r: -1 })).toThrow("r is required");
    expect(() => h.axiLens(ctx.doc, { ...ok, rotate: NaN })).toThrow("rotate must be a finite number");
    expect(() => h.axiLens(ctx.doc, { ...ok, fill: undefined })).toThrow("fill");
    expect(ctx.required).toEqual([]);
    expect(ctx.nodes).toEqual([]);
  });
});
