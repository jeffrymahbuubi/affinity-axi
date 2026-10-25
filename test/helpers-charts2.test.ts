// axiGroupedBars, axiStackedBars, axiLine, axiLegend: source hygiene, validation before
// any SDK call and geometry, with CHARTS_SOURCE (for axiChartColour) and CHARTS2_SOURCE
// evaluated behind stubbed axiRect/axiText/axiEllipse/axiMeasure and a recording fake of
// the geometry, node, fill and line-style modules. Live rendering: the helpers-charts2 example.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { CHARTS_SOURCE } from "../src/affinity/helpers-charts.js";
import { CHARTS2_INDEX, CHARTS2_INTERNAL, CHARTS2_SOURCE } from "../src/affinity/helpers-charts2.js";
type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;
// --- source hygiene ---------------------------------------------------------

describe("CHARTS2_SOURCE", () => {
  const declared = [...CHARTS2_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(CHARTS2_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiLine(") ? HELPERS_SOURCE : HELPERS_SOURCE + CHARTS2_SOURCE)).not.toThrow();
  });
  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(CHARTS2_SOURCE)).toEqual([]);
    expect(scanForAi(CHARTS2_SOURCE)).toEqual([]);
    expect(CHARTS2_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
    expect(CHARTS2_SOURCE).not.toContain("`"); // String.raw block
    expect(CHARTS2_SOURCE).not.toContain("${");
    expect(CHARTS2_SOURCE).not.toContain("\\");
  });
  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of CHARTS2_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !CHARTS2_INDEX.some((h) => h.name === n)).sort()).toEqual([...CHARTS2_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(CHARTS2_INDEX.map((h) => h.name)).toEqual(["axiGroupedBars", "axiStackedBars", "axiLine", "axiLegend"]);
  });
  it("uses function declarations only, all prefixed axi, requires inside functions", () => {
    const top = CHARTS2_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
    for (const line of CHARTS2_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });
  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
  it("reuses axiChartColour from charts 1, never closes a path and builds polylines with beginXY and lineToXY", () => {
    expect(CHARTS2_SOURCE).not.toContain("function axiChartColour(");
    expect(CHARTS2_SOURCE).toContain("axiChartColour(");
    expect(CHARTS2_SOURCE).not.toMatch(/\.close\b|closePie|setShape/);
    expect(CHARTS2_SOURCE).toContain("beginXY");
    expect(CHARTS2_SOURCE).toContain("lineToXY");
    expect(CHARTS2_SOURCE).toContain("FillDescriptor.createNone()");
  });
});

// --- fake SDK and stubs -----------------------------------------------------

const STUBS = String.raw`
function axiHex(h) { return 'hex:' + h; }
function axiSurface(doc) { calls.push({ kind: 'surface' }); }
function axiName(node, name) { if (name !== undefined && name !== null) { node.userDescription = String(name); } return node; }
function axiRect(doc, o) { const n = Object.assign({ kind: 'rect', box: { x: o.x, y: o.y, w: o.w, h: o.h } }, o); calls.push(n); doc.selection.nodes.first = n; return n; }
function axiEllipse(doc, o) { const n = Object.assign({ kind: 'ellipse', box: { x: o.x, y: o.y, w: o.w, h: o.h } }, o); calls.push(n); doc.selection.nodes.first = n; return n; }
function axiText(doc, o) {
  const w = String(o.text).length * o.size * 0.5;
  const x = o.align === 'c' ? o.x - w / 2 : o.align === 'r' ? o.x - w : o.x;
  const n = Object.assign({ kind: 'text', box: { x: x, y: o.y - o.size, w: w, h: o.size } }, o);
  calls.push(n); doc.selection.nodes.first = n; return n;
}
function axiMeasure(doc) { return doc.selection.nodes.first.box; }
`;

type Rig = ReturnType<typeof rig>;

function rig() {
  const calls: Rec[] = [];
  const builders: Array<{ begin: number[][]; line: number[][]; closed: number }> = [];
  const requires: string[] = [];
  class FakeBuilder {
    rec = { begin: [] as number[][], line: [] as number[][], closed: 0 };
    constructor() { builders.push(this.rec); }
    beginXY(x: number, y: number) { this.rec.begin.push([x, y]); return this; }
    lineToXY(x: number, y: number) { this.rec.line.push([x, y]); return this; }
    close() { this.rec.closed += 1; return this; }
    createCurve() { return { curve: this.rec }; }
  }
  const modules: Record<string, Rec> = {
    "/geometry.js": { CurveBuilder: FakeBuilder, PolyCurve: { create: () => ({ curves: [] as unknown[], addCurve(c: unknown) { this.curves.push(c); } }) } },
    "/nodes.js": { PolyCurveNodeDefinition: { create: (pc: Rec, brush: unknown, pen: unknown, style: unknown, tr: unknown) => ({ kind: "polyline", pc, brush, pen, style, tr, box: { x: 0, y: 0, w: 1, h: 1 } }) } },
    "/fills.js": { FillDescriptor: { createNone: () => ({ fill: "none" }), createSolid: (c: unknown) => ({ fill: "solid", c }) } },
    "/linestyle.js": { LineStyle: { create: (o: Rec) => ({ ls: o }) }, LineStyleDescriptor: { create: (l: Rec) => ({ lsd: l }) } },
  };
  const doc: Rec = {
    selection: { nodes: { first: null as Rec | null } },
    addNode(def: Rec) { calls.push(def); doc.selection.nodes.first = def; },
  };
  const body = `${STUBS}\n${CHARTS_SOURCE}\n${CHARTS2_SOURCE}\nreturn { axiGroupedBars, axiStackedBars, axiLine, axiLegend, axiSeriesCheck, axiPolyline };`;
  const req = (id: string) => { requires.push(id); if (!modules[id]) throw new Error("SDK not available in tests: " + id); return modules[id]; };
  const h = new Function("require", "calls", body)(req, calls) as Record<string, Fn>;
  return { h, doc, calls, builders, requires };
}

/** Each bad option set throws before any SDK module is required or any node is added. */
function rejectsAll(fn: string, bad: Array<[string, Rec | undefined, RegExp]>) {
  for (const [label, o, re] of bad) {
    it(`rejects ${label}`, () => {
      const r = rig();
      expect(() => r.h[fn]!(r.doc, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.calls).toEqual([]);
    });
  }
}

const rects = (r: Rig) => r.calls.filter((c) => c.kind === "rect");
const texts = (r: Rig) => r.calls.filter((c) => c.kind === "text");

const SKY = "#4C8DFF";
const SUN = "#FFC857";
const INK = "#1F2A44";

const two = [
  { name: "a", values: [4, 8], colour: SKY },
  { name: "b", values: [2, 6], colour: SUN },
];
const box = { x: 0, y: 0, w: 400, h: 200 };

function sharedBad(base: Rec): Array<[string, Rec | undefined, RegExp]> {
  const m: number = base.series[0].values.length;
  const all = Array.from({ length: m }, (_, i) => "c" + i);
  return [
    ["no options", undefined, /options .* are required/],
    ["missing x", { ...base, x: undefined }, /x and y are required/],
    ["zero width", { ...base, w: 0 }, /w and h are required/],
    ["negative height", { ...base, h: -1 }, /w and h are required/],
    ["no series", { ...base, series: undefined }, /series must be an array of/],
    ["more than six series", { ...base, series: Array.from({ length: 7 }, () => ({ values: [1, 2], colour: SKY })) }, /series must be an array of \d to 6 entries/],
    ["a series without values", { ...base, series: [{ values: [], colour: SKY }, { values: [], colour: SUN }] }, /series 0 needs a non-empty values array/],
    ["length mismatch", { ...base, series: [{ values: [1, 2], colour: SKY }, { values: [1], colour: SUN }] }, /series 1 has 1 values but series 0 has 2/],
    ["negative value", { ...base, series: [{ values: [1, -2], colour: SKY }, { values: [1, 2], colour: SUN }] }, /series 0 value 1 must be a number of 0 or more/],
    ["a series with no colour and no colours", { ...base, series: [{ values: [1, 2] }, { values: [1, 2], colour: SUN }] }, /colours \(an array\) or colour \(one hex\) is required/],
    ["a bad colour", { ...base, series: [{ values: [1, 2], colour: "blue" }, { values: [1, 2], colour: SUN }] }, /colour must be a hex string/],
    ["labels of the wrong length", { ...base, labels: ["a"], labelFont: "Helvetica" }, new RegExp(`one entry per category \\(${m}\\)`)],
    ["labels without a font", { ...base, labels: all }, /labelFont is required/],
  ];
}

// --- axiGroupedBars ---------------------------------------------------------

const grouped = { ...box, series: two, gap: 0.25, inner: 0 };

describe("axiGroupedBars validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ...sharedBad(grouped),
    ["a single series", { ...grouped, series: [two[0]] }, /series must be an array of 2 to 6 entries/],
    ["gap 1", { ...grouped, gap: 1 }, /gap must be 0 or more and less than 1/],
    ["inner that leaves no room", { ...grouped, inner: 1 }, /inner must be 0 or more and leave room for 2 bars/],
    ["negative radius", { ...grouped, radius: -4 }, /radius must be 0 or more/],
    ["all zero, no max", { ...grouped, series: [{ values: [0, 0], colour: SKY }, { values: [0, 0], colour: SUN }] }, /max must be a positive number/],
    ["a value above max", { ...grouped, max: 5 }, /value 8 is above max 5/],
    ["valueLabels without a font", { ...grouped, valueLabels: true }, /labelFont is required/],
  ];
  rejectsAll("axiGroupedBars", bad);
});

describe("axiGroupedBars geometry", () => {
  it("lays out [4, 8] / [2, 6] in 400x200 with gap 0.25, inner 0 from the baseline", () => {
    const r = rig();
    const res = r.h.axiGroupedBars(r.doc, { ...grouped, name: "g" });
    const rs = rects(r);
    expect(rs).toHaveLength(4);
    // pitch 200, group 150, bar 75, group inset 25
    expect(rs.map((c) => c.w)).toEqual([75, 75, 75, 75]);
    expect(rs.map((c) => c.h)).toEqual([100, 200, 50, 150]); // series-major: s0 j0, s0 j1, s1 j0, s1 j1
    expect(rs.map((c) => c.x)).toEqual([25, 225, 100, 300]);
    expect(rs.map((c) => c.y + c.h)).toEqual([200, 200, 200, 200]);
    expect(rs.map((c) => c.name)).toEqual(["g-s0-bar-0", "g-s0-bar-1", "g-s1-bar-0", "g-s1-bar-1"]);
    expect(rs.map((c) => c.fill)).toEqual([SKY, SKY, SUN, SUN]);
    expect(res.max).toBe(8);
    expect(res.nodes.bars).toHaveLength(2);
    expect(res.nodes.bars[0]).toHaveLength(2);
    expect(res.nodes.labels).toEqual([]);
    expect(res.nodes.values).toEqual([]);
    expect(r.requires).toEqual([]); // axiRect is stubbed, the grouped bars never need the SDK themselves
  });
  it("defaults gap to 0.25 and inner to 0.08", () => {
    const r = rig();
    r.h.axiGroupedBars(r.doc, { ...box, series: two });
    const rs = rects(r);
    const group = 150;
    const between = 0.08 * group;
    expect(rs[0]!.w).toBeCloseTo((group - between) / 2, 9);
    expect(rs[0]!.x).toBe(25);
  });
  it("honours a max override and leaves the room above", () => {
    const r = rig();
    const res = r.h.axiGroupedBars(r.doc, { ...grouped, max: 16 });
    expect(rects(r).map((c) => c.h)).toEqual([50, 100, 25, 75]);
    expect(res.max).toBe(16);
  });
  it("falls back to colours for a series without one, and an own colour wins", () => {
    const r = rig();
    r.h.axiGroupedBars(r.doc, { ...grouped, colours: [INK, SUN], series: [{ values: [1, 2] }, { values: [1, 2], colour: SKY }, { values: [1, 2] }] });
    expect(rects(r).map((c) => c.fill)).toEqual([INK, INK, SKY, SKY, INK, INK]); // series 2 takes colours[2 % 2]
  });
  it("draws no rect for a zero value but keeps its slot", () => {
    const r = rig();
    const res = r.h.axiGroupedBars(r.doc, { ...grouped, series: [{ values: [0, 4], colour: SKY }, { values: [2, 0], colour: SUN }] });
    expect(res.nodes.bars[0][0]).toBeNull();
    expect(res.nodes.bars[1][1]).toBeNull();
    expect(rects(r)).toHaveLength(2);
  });
  it("places category labels centred under each cluster and value labels above each bar", () => {
    const r = rig();
    const res = r.h.axiGroupedBars(r.doc, { ...grouped, labels: ["Q1", "Q2"], labelFont: "Helvetica", labelSize: 20, labelColour: INK, valueLabels: true, name: "c" });
    const labels = texts(r).filter((t) => /-label-/.test(t.name));
    const values = texts(r).filter((t) => /-value-/.test(t.name));
    expect(labels.map((t) => t.text)).toEqual(["Q1", "Q2"]);
    expect(labels.map((t) => t.x)).toEqual([100, 300]); // pitch centres
    for (const t of labels) { expect(t.y).toBe(200 + 20 * 1.35); expect(t.align).toBe("c"); expect(t.colour).toBe(INK); }
    expect(values.map((t) => t.text)).toEqual(["4", "8", "2", "6"]);
    expect(values.map((t) => t.name)).toEqual(["c-value-s0-0", "c-value-s0-1", "c-value-s1-0", "c-value-s1-1"]);
    expect(values.map((t) => t.x)).toEqual([62.5, 262.5, 137.5, 337.5]); // bar centres
    expect(res.nodes.labels).toHaveLength(2);
    expect(res.nodes.values).toHaveLength(2);
    expect(res.nodes.values[0]).toHaveLength(2);
    expect(labels.map((t) => t.name)).toEqual(["c-label-0", "c-label-1"]);
  });
});

// --- axiStackedBars ---------------------------------------------------------

const stacked = { ...box, series: [{ values: [1, 3], colour: SKY }, { values: [1, 1], colour: SUN }], gap: 0.25 };

describe("axiStackedBars validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ...sharedBad(stacked),
    ["a single series", { ...stacked, series: [two[0]] }, /series must be an array of 2 to 6 entries/],
    ["gap 1", { ...stacked, gap: 1 }, /gap must be 0 or more and less than 1/],
    ["negative radius", { ...stacked, radius: -1 }, /radius must be 0 or more/],
    ["all zero, no max", { ...stacked, series: [{ values: [0, 0], colour: SKY }, { values: [0, 0], colour: SUN }] }, /max must be a positive number/],
    ["a column total above max", { ...stacked, max: 3 }, /column total 4 is above max 3/],
  ];
  rejectsAll("axiStackedBars", bad);
});

describe("axiStackedBars geometry", () => {
  it("stacks [1, 3] and [1, 1] from the baseline: totals 2 and 4, max 4", () => {
    const r = rig();
    const res = r.h.axiStackedBars(r.doc, { ...stacked, name: "s" });
    const byName = (n: string) => rects(r).find((c) => c.name === n)!;
    // pitch 200, column 150, inset 25; scale 200 / 4 = 50 per unit
    expect(res.totals).toEqual([2, 4]);
    expect(res.max).toBe(4);
    expect(byName("s-s0-seg-0")).toMatchObject({ x: 25, w: 150, h: 50, y: 150 });
    expect(byName("s-s1-seg-0")).toMatchObject({ x: 25, w: 150, h: 50, y: 100 });
    expect(byName("s-s0-seg-1")).toMatchObject({ x: 225, w: 150, h: 150, y: 50 });
    expect(byName("s-s1-seg-1")).toMatchObject({ x: 225, w: 150, h: 50, y: 0 });
    expect(rects(r)).toHaveLength(4);
    expect(res.nodes.segments).toHaveLength(2);
    expect(res.nodes.segments[1]).toHaveLength(2);
  });
  it("scales every column to the full height with percent, and reports max 100", () => {
    const r = rig();
    const res = r.h.axiStackedBars(r.doc, { ...stacked, percent: true });
    expect(res.max).toBe(100);
    expect(res.totals).toEqual([2, 4]);
    for (const x of [25, 225]) {
      const col = rects(r).filter((c) => c.x === x);
      expect(col.reduce((a, c) => a + c.h, 0)).toBeCloseTo(200, 9);
    }
    const first = rects(r).filter((c) => c.x === 25);
    expect(first.map((c) => c.h)).toEqual([100, 100]);
    const second = rects(r).filter((c) => c.x === 225);
    expect(second.map((c) => c.h).sort((a, b) => a - b)).toEqual([50, 150]);
  });
  it("percent leaves an all-zero column empty and a max in percent mode is ignored", () => {
    const r = rig();
    const res = r.h.axiStackedBars(r.doc, { ...box, series: [{ values: [0, 2], colour: SKY }, { values: [0, 2], colour: SUN }], percent: true, max: 1 });
    expect(res.nodes.segments[0][0]).toBeNull();
    expect(rects(r)).toHaveLength(2);
    expect(res.max).toBe(100);
  });
  it("rounds only the top segment, reaching down into the one below, and draws it first", () => {
    const r = rig();
    r.h.axiStackedBars(r.doc, { ...box, series: [{ values: [2, 2], colour: SKY }, { values: [2, 2], colour: SUN }], radius: 12, name: "z" });
    const col0 = rects(r).filter((c) => c.x === 25);
    const topSeg = col0.find((c) => c.name === "z-s1-seg-0")!;
    const low = col0.find((c) => c.name === "z-s0-seg-0")!;
    expect(topSeg.radius).toBe(12);
    expect(topSeg.h).toBe(100 + 12); // 100 tall plus the reach into the segment below
    expect(topSeg.y).toBe(0);
    expect(low.radius).toBeUndefined();
    expect(col0.indexOf(topSeg)).toBeLessThan(col0.indexOf(low)); // the squared segment covers the reach
  });
  it("does not reach below the baseline when the only segment is also the top", () => {
    const r = rig();
    r.h.axiStackedBars(r.doc, { ...box, series: [{ values: [0, 2], colour: SKY }, { values: [4, 2], colour: SUN }], radius: 12, max: 4 });
    const only = rects(r).find((c) => c.x === 25)!;
    expect(only.h).toBe(200);
    expect(only.y + only.h).toBe(200);
  });
  it("places category labels under each column", () => {
    const r = rig();
    const res = r.h.axiStackedBars(r.doc, { ...stacked, labels: ["A", "B"], labelFont: "Helvetica", labelSize: 20, name: "t" });
    const labels = texts(r);
    expect(labels.map((t) => [t.name, t.text, t.x])).toEqual([["t-label-0", "A", 100], ["t-label-1", "B", 300]]);
    expect(res.nodes.labels).toHaveLength(2);
  });
});

// --- axiLine ----------------------------------------------------------------

const line = { x: 0, y: 0, w: 600, h: 200, series: [{ name: "a", values: [0, 5, 10], colour: SKY }] };
const polys = (r: Rig) => r.calls.filter((c) => c.kind === "polyline");

describe("axiLine validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ...sharedBad(line),
    ["no series at all", { ...line, series: [] }, /series must be an array of 1 to 6 entries/],
    ["a single value", { ...line, series: [{ values: [3], colour: SKY }] }, /at least 2 values/],
    ["a zero stroke", { ...line, stroke: 0 }, /stroke must be a positive width/],
    ["a negative dots radius", { ...line, dots: -1 }, /dots must be a radius of 0 or more/],
    ["a fractional grid", { ...line, grid: 2.5 }, /grid must be a whole number/],
    ["all values equal to min, no max", { ...line, series: [{ values: [0, 0], colour: SKY }] }, /max must be a number above min 0 \(pass max\)/],
    ["max not above min", { ...line, max: 0 }, /max must be a number above min 0/],
    ["a value above max", { ...line, max: 8 }, /value 10 is above max 8/],
    ["a value below min", { ...line, min: 2 }, /value 0 is below min 2/],
  ];
  rejectsAll("axiLine", bad);
});

describe("axiLine geometry", () => {
  it("maps [0, 5, 10] to y + h, y + h/2, y at the pitch centres", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...line, y: 10 });
    expect(r.builders).toHaveLength(1);
    const b = r.builders[0]!;
    expect(b.begin).toEqual([[100, 210]]);
    expect(b.line.map((p) => p[1])).toEqual([110, 10]);
    expect(b.line.map((p) => p[0])).toEqual([300, 500]);
    expect(res.max).toBe(10);
    expect(res.min).toBe(0);
    expect(res.nodes.lines).toHaveLength(1);
  });
  it("records beginXY once, lineToXY n-1 times and never a close", () => {
    const r = rig();
    r.h.axiLine(r.doc, { ...box, series: [{ values: [1, 2, 3, 4, 5], colour: SKY }, { values: [5, 4, 3, 2, 1], colour: SUN }] });
    expect(r.builders).toHaveLength(2);
    for (const b of r.builders) {
      expect(b.begin).toHaveLength(1);
      expect(b.line).toHaveLength(4);
      expect(b.closed).toBe(0);
    }
  });
  it("draws an open stroked polyline: none brush and transparency, solid pen, the stroke width", () => {
    const r = rig();
    r.h.axiLine(r.doc, { ...line, stroke: 6, name: "l" });
    const p = polys(r)[0]!;
    expect(p.brush).toEqual({ fill: "none" });
    expect(p.tr).toEqual({ fill: "none" });
    expect(p.pen).toEqual({ fill: "solid", c: "hex:" + SKY });
    expect(p.style).toEqual({ lsd: { ls: { weight: 6 } } });
    expect(p.userDescription).toBe("l-s0-line");
    expect(r.requires).toEqual(["/geometry.js", "/nodes.js", "/fills.js", "/linestyle.js"]);
  });
  it("defaults the stroke to 4 and the min to 0, and honours min and max", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...box, series: [{ values: [20, 30], colour: SKY }], min: 10, max: 30 });
    expect(polys(r)[0]!.style).toEqual({ lsd: { ls: { weight: 4 } } });
    expect(r.builders[0]!.begin[0]![1]).toBe(100); // (20 - 10) / 20 of 200 above the baseline
    expect(r.builders[0]!.line[0]![1]).toBe(0);
    expect(res.min).toBe(10);
    expect(res.max).toBe(30);
  });
  it("draws one line per series, in the series colours, with no dots by default", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...box, series: two, name: "m" });
    expect(polys(r).map((p) => p.userDescription)).toEqual(["m-s0-line", "m-s1-line"]);
    expect(polys(r).map((p) => p.pen.c)).toEqual(["hex:" + SKY, "hex:" + SUN]);
    expect(r.calls.filter((c) => c.kind === "ellipse")).toHaveLength(0);
    expect(res.nodes.dots).toEqual([[], []]);
  });
  it("draws dots of the given radius centred on each point after its line", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...line, dots: 8, name: "d" });
    const dots = r.calls.filter((c) => c.kind === "ellipse");
    expect(dots.map((c) => c.name)).toEqual(["d-s0-dot-0", "d-s0-dot-1", "d-s0-dot-2"]);
    expect(dots.map((c) => [c.w, c.h])).toEqual([[16, 16], [16, 16], [16, 16]]);
    expect(dots.map((c) => c.y + 8)).toEqual([200, 100, 0]);
    expect(dots.map((c) => c.x + 8)).toEqual([100, 300, 500]);
    expect(dots.every((c) => c.fill === SKY)).toBe(true);
    expect(res.nodes.dots[0]).toHaveLength(3);
    // the polyline comes before its dots
    expect(r.calls.findIndex((c) => c.kind === "polyline")).toBeLessThan(r.calls.findIndex((c) => c.kind === "ellipse"));
  });
  it("draws grid rules first, at equal steps up to max, in labelColour at 20% alpha", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...line, grid: 4, labelColour: INK, name: "g" });
    const grid = rects(r);
    expect(grid).toHaveLength(4);
    expect(grid.map((c) => c.name)).toEqual(["g-grid-0", "g-grid-1", "g-grid-2", "g-grid-3"]);
    expect(grid.map((c) => c.y + c.h / 2)).toEqual([150, 100, 50, 0]); // quarter steps, the last at max
    for (const c of grid) { expect(c.h).toBe(1); expect(c.w).toBe(600); expect(c.fill).toBe(INK); expect(c.fillAlpha).toBe(0.2); }
    const firstPoly = r.calls.findIndex((c) => c.kind === "polyline");
    expect(r.calls.slice(0, firstPoly).filter((c) => c.kind === "rect")).toHaveLength(4);
    expect(res.nodes.grid).toHaveLength(4);
  });
  it("places category labels at the point x under the baseline", () => {
    const r = rig();
    const res = r.h.axiLine(r.doc, { ...line, labels: ["a", "b", "c"], labelFont: "Helvetica", labelSize: 20, name: "t" });
    expect(texts(r).map((t) => [t.name, t.text])).toEqual([["t-label-0", "a"], ["t-label-1", "b"], ["t-label-2", "c"]]);
    expect(texts(r).map((t) => t.x)).toEqual([100, 300, 500]);
    for (const t of texts(r)) { expect(t.y).toBe(200 + 20 * 1.35); }
    expect(res.nodes.labels).toHaveLength(3);
  });
});

describe("axiPolyline", () => {
  it("rejects bad points, stroke or width before touching the SDK", () => {
    for (const [pts, o, re] of [
      [[[0, 0]], { stroke: SKY }, /at least 2 points/],
      [[[0, 0], [1]], { stroke: SKY }, /point 1 needs numbers x and y/],
      [[[0, 0], [1, 1]], undefined, /stroke \(a hex colour\) is required/],
      [[[0, 0], [1, 1]], { stroke: SKY, width: 0 }, /width must be positive/],
    ] as Array<[unknown, Rec | undefined, RegExp]>) {
      const r = rig();
      expect(() => r.h.axiPolyline!(r.doc, pts, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.calls).toEqual([]);
    }
  });
});

// --- axiLegend --------------------------------------------------------------

const legend = { x: 10, y: 20, font: "Helvetica", size: 20, items: [{ label: "Portrait", colour: SKY }, { label: "Product", colour: SUN }, { label: "Event", colour: INK }] };

describe("axiLegend validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing x", { ...legend, x: undefined }, /x and y are required/],
    ["no items", { ...legend, items: [] }, /items must be a non-empty array/],
    ["no font", { ...legend, font: undefined }, /font is required/],
    ["zero size", { ...legend, size: 0 }, /size must be positive/],
    ["more columns than items", { ...legend, columns: 4 }, /columns must be a whole number from 1 to 3/],
    ["an item without a label", { ...legend, items: [{ colour: SKY }] }, /item 0 needs a label/],
    ["an item without a colour", { ...legend, items: [{ label: "a" }] }, /colours \(an array\) or colour \(one hex\) is required/],
    ["a bad colour", { ...legend, colour: "ink" }, /colour must be a hex string/],
  ];
  rejectsAll("axiLegend", bad);
});

describe("axiLegend geometry", () => {
  it("stacks one column of swatch + label rows and measures the whole legend", () => {
    const r = rig();
    const res = r.h.axiLegend(r.doc, { ...legend, name: "lg" });
    const sw = rects(r);
    expect(sw.map((c) => c.name)).toEqual(["lg-swatch-0", "lg-swatch-1", "lg-swatch-2"]);
    expect(sw.map((c) => [c.x, c.w, c.h])).toEqual([[10, 20, 20], [10, 20, 20], [10, 20, 20]]);
    expect(sw.map((c) => c.y)).toEqual([20, 50, 80]); // row 20 + gap 10
    expect(sw.map((c) => c.fill)).toEqual([SKY, SUN, INK]);
    expect(texts(r).map((t) => [t.name, t.text, t.x])).toEqual([["lg-label-0", "Portrait", 40], ["lg-label-1", "Product", 40], ["lg-label-2", "Event", 40]]);
    expect(texts(r).map((t) => t.y)).toEqual([20 + 10 + 7, 50 + 10 + 7, 80 + 10 + 7]);
    expect(res.h).toBe(3 * 20 + 2 * 10);
    expect(res.w).toBe(30 + 8 * 20 * 0.5); // swatch + half-size gap + the widest label (Portrait, 8 chars at 10 px)
    expect(res.nodes.swatches).toHaveLength(3);
    expect(res.nodes.labels).toHaveLength(3);
  });
  it("splits the items into columns, filled down each column", () => {
    const r = rig();
    const res = r.h.axiLegend(r.doc, { ...legend, columns: 2 });
    const sw = rects(r);
    // 3 items over 2 columns: rows 2 -> column 0 holds items 0 and 1, column 1 holds item 2
    expect(sw.map((c) => c.y)).toEqual([20, 50, 20]);
    expect(sw[0]!.x).toBe(10);
    expect(sw[1]!.x).toBe(10);
    // column 0 right edge = 10 + 20 + 10 + 8 * 10 = 120; next column starts 1.5 * size further on
    expect(sw[2]!.x).toBe(120 + 30);
    expect(res.h).toBe(2 * 20 + 10);
    expect(res.w).toBe(150 - 10 + 20 + 10 + 5 * 10);
  });
  it("accepts the series array of the other helpers and colours as a fallback", () => {
    const r = rig();
    r.h.axiLegend(r.doc, { ...legend, colours: [INK, SUN], items: [{ name: "a", values: [1] }, { name: "b", values: [2], colour: SKY }] });
    expect(texts(r).map((t) => t.text)).toEqual(["a", "b"]);
    expect(rects(r).map((c) => c.fill)).toEqual([INK, SKY]);
  });
  it("honours swatch, gap and colour, and defaults the text size to 28", () => {
    const r = rig();
    r.h.axiLegend(r.doc, { x: 0, y: 0, font: "Helvetica", items: [{ label: "x", colour: SKY }, { label: "y", colour: SUN }], swatch: 10, gap: 4, colour: INK });
    expect(texts(r).every((t) => t.size === 28 && t.colour === INK)).toBe(true);
    expect(rects(r).map((c) => [c.w, c.y])).toEqual([[10, 9], [10, 9 + 28 + 4]]); // row height is the taller of swatch and text, swatch centred
  });
});
