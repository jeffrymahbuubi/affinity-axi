// axiBars, axiDonut, axiProgress: source hygiene, validation before any SDK call and
// geometry, with CHARTS_SOURCE evaluated alone behind stubbed axiRect/axiText and a
// recording fake of /shapes.js and /nodes.js. Live rendering: the helpers-charts example.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { CHARTS_INDEX, CHARTS_INTERNAL, CHARTS_SOURCE } from "../src/affinity/helpers-charts.js";

type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;

// --- source hygiene ---------------------------------------------------------

describe("CHARTS_SOURCE", () => {
  const declared = [...CHARTS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(CHARTS_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiBars(") ? HELPERS_SOURCE : HELPERS_SOURCE + CHARTS_SOURCE)).not.toThrow();
  });
  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(CHARTS_SOURCE)).toEqual([]);
    expect(scanForAi(CHARTS_SOURCE)).toEqual([]);
    expect(CHARTS_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js|closePie/);
    expect(CHARTS_SOURCE).not.toContain("`"); // String.raw block
    expect(CHARTS_SOURCE).not.toContain("${");
  });
  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of CHARTS_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !CHARTS_INDEX.some((h) => h.name === n)).sort()).toEqual([...CHARTS_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(CHARTS_INDEX.map((h) => h.name)).toEqual(["axiBars", "axiDonut", "axiProgress"]);
  });
  it("uses function declarations only, all prefixed axi, requires inside functions", () => {
    const top = CHARTS_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
    for (const line of CHARTS_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });
  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
  it("sets startAngle before sweep before innerRadius and never calls closePie or setShape", () => {
    const at = ["pie.startAngle", "pie.sweep", "pie.innerRadius"].map((k) => CHARTS_SOURCE.indexOf(k));
    expect(at[0]).toBeGreaterThan(0);
    expect(at[1]).toBeGreaterThan(at[0]!);
    expect(at[2]).toBeGreaterThan(at[1]!);
    expect(CHARTS_SOURCE).not.toMatch(/closePie|setShape/);
  });
});

// --- fake SDK and stubs -----------------------------------------------------

const STUBS = String.raw`
function axiHex(h) { return 'hex:' + h; }
function axiSurface(doc) { calls.push({ kind: 'surface' }); }
function axiName(node, name) { if (name !== undefined && name !== null) { node.userDescription = String(name); } return node; }
function axiRect(doc, o) { const n = Object.assign({ kind: 'rect', box: { x: o.x, y: o.y, w: o.w, h: o.h } }, o); calls.push(n); doc.selection.nodes.first = n; return n; }
function axiText(doc, o) {
  const w = String(o.text).length * o.size * 0.5;
  const x = o.align === 'c' ? o.x - w / 2 : o.align === 'r' ? o.x - w : o.x;
  const n = Object.assign({ kind: 'text', box: { x: x, y: o.y - o.size, w: w, h: o.size } }, o);
  calls.push(n); doc.selection.nodes.first = n; return n;
}
function axiMeasure(doc) { return doc.selection.nodes.first.box; }
function axiMove(doc, dx, dy) { doc.selection.nodes.first.box.x += dx; moves.push([dx, dy]); }
`;

type Rig = ReturnType<typeof rig>;

function rig() {
  const calls: Rec[] = [];
  const pies: Rec[] = [];
  const moves: number[][] = [];
  const requires: string[] = [];
  class FakePie {
    order: string[] = [];
    v: Rec = {};
    private put(k: string, x: number) { this.order.push(k); this.v[k] = x; }
    set startAngle(x: number) { this.put("startAngle", x); }
    set sweep(x: number) { this.put("sweep", x); }
    set innerRadius(x: number) { this.put("innerRadius", x); }
  }
  const modules: Record<string, Rec> = {
    "/shapes.js": { ShapePie: { create: () => new FakePie() } },
    "/nodes.js": {
      ShapeNodeDefinition: {
        create(shape: FakePie, rect: Rec, fill: string, st: unknown, ls: unknown) {
          const p = { kind: "pie", shape, rect, fill, st, ls, userDescription: "" };
          pies.push(p);
          return p;
        },
      },
    },
  };
  const doc: Rec = {
    selection: { nodes: { first: null as Rec | null } },
    addNode(def: Rec) { calls.push(def); doc.selection.nodes.first = def; },
  };
  const body = `${STUBS}\n${CHARTS_SOURCE}\nreturn { axiBars, axiDonut, axiProgress, axiPieSlice, axiChartColour };`;
  const req = (id: string) => { requires.push(id); if (!modules[id]) throw new Error("SDK not available in tests: " + id); return modules[id]; };
  const h = new Function("require", "calls", "moves", body)(req, calls, moves) as Record<string, Fn>;
  return { h, doc, calls, pies, moves, requires };
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

const TAU = 2 * Math.PI;
/** Screen angle (radians clockwise from 3 o'clock, mod 2PI) a stored pie covers from. */
function screenStart(p: Rec): number {
  const a = -(p.shape.v.startAngle + p.shape.v.sweep);
  return ((a % TAU) + TAU) % TAU;
}
const mod = (a: number) => ((a % TAU) + TAU) % TAU;
const rects = (r: Rig, name?: string) => r.calls.filter((c) => c.kind === "rect" && (!name || String(c.name).includes(name)));
const texts = (r: Rig) => r.calls.filter((c) => c.kind === "text");

// --- axiBars -----------------------------------------------------------------

const bars = { x: 10, y: 20, w: 600, h: 300, values: [4, 8, 2], colour: "#4C8DFF" };

describe("axiBars validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing x", { ...bars, x: undefined }, /x and y are required/],
    ["zero width", { ...bars, w: 0 }, /w and h are required/],
    ["negative height", { ...bars, h: -1 }, /w and h are required/],
    ["no values", { ...bars, values: [] }, /values must be a non-empty array/],
    ["negative value", { ...bars, values: [1, -2] }, /value 1 must be a number of 0 or more/],
    ["gap 1", { ...bars, gap: 1 }, /gap must be 0 or more and less than 1/],
    ["negative radius", { ...bars, radius: -4 }, /radius must be 0 or more/],
    ["all zero, no max", { ...bars, values: [0, 0] }, /max must be a positive number/],
    ["max zero", { ...bars, max: 0 }, /max must be a positive number/],
    ["value above max", { ...bars, max: 5 }, /value 8 is above max 5/],
    ["labels wrong length", { ...bars, labels: ["a"], labelFont: "Helvetica" }, /one entry per value \(3\)/],
    ["labels without a font", { ...bars, labels: ["a", "b", "c"] }, /labelFont is required/],
    ["valueLabels without a font", { ...bars, valueLabels: true }, /labelFont is required/],
    ["no colour at all", { ...bars, colour: undefined }, /colours \(an array\) or colour \(one hex\) is required/],
    ["bad colour", { ...bars, colour: "blue" }, /colour must be a hex string/],
    ["bad colour in an item", { ...bars, values: [{ value: 1, colour: "nope" }] }, /colour must be a hex string/],
  ];
  rejectsAll("axiBars", bad);
});

describe("axiBars geometry", () => {
  it("lays out [4, 8, 2] in a 600x300 box with gap 0.3 from the baseline", () => {
    const r = rig();
    const res = r.h.axiBars(r.doc, { ...bars, name: "b" });
    const rs = rects(r);
    expect(rs).toHaveLength(3);
    // pitch 200, thickness 140, inset 30
    expect(rs.map((c) => c.w)).toEqual([140, 140, 140]);
    expect(rs.map((c) => c.h)).toEqual([150, 300, 75]);
    expect(rs.map((c) => c.x)).toEqual([40, 240, 440]);
    expect(rs.map((c) => c.y + c.h)).toEqual([320, 320, 320]); // baseline = y + h
    expect(rs.map((c) => c.name)).toEqual(["b-bar-0", "b-bar-1", "b-bar-2"]);
    expect(res.max).toBe(8);
    expect(res.nodes.bars).toHaveLength(3);
    expect(res.nodes.labels).toEqual([null, null, null]);
    expect(res.nodes.values).toEqual([]);
    expect(r.requires).toEqual([]); // axiRect is stubbed, bars never need the SDK themselves
  });
  it("honours a max override and leaves the room above", () => {
    const r = rig();
    const res = r.h.axiBars(r.doc, { ...bars, max: 16 });
    expect(rects(r).map((c) => c.h)).toEqual([75, 150, 37.5]);
    expect(res.max).toBe(16);
  });
  it("cycles colours, lets an item override its colour, and passes the radius", () => {
    const r = rig();
    r.h.axiBars(r.doc, { ...bars, colour: undefined, colours: ["#111111", "#222222"], values: [1, 2, { value: 3, colour: "#333333" }], radius: 12 });
    expect(rects(r).map((c) => c.fill)).toEqual(["#111111", "#222222", "#333333"]);
    expect(rects(r).map((c) => c.radius)).toEqual([12, 12, 12]);
  });
  it("swaps the axes when horizontal: bars grow right from x, stacked down the box", () => {
    const r = rig();
    r.h.axiBars(r.doc, { ...bars, horizontal: true });
    const rs = rects(r);
    // pitch 100, thickness 70, inset 15
    expect(rs.map((c) => c.h)).toEqual([70, 70, 70]);
    expect(rs.map((c) => c.w)).toEqual([300, 600, 150]);
    expect(rs.map((c) => c.x)).toEqual([10, 10, 10]);
    expect(rs.map((c) => c.y)).toEqual([35, 135, 235]);
  });
  it("draws no rect for a zero value but keeps its slot and label", () => {
    const r = rig();
    const res = r.h.axiBars(r.doc, { ...bars, values: [0, 5], labels: ["a", "b"], labelFont: "Helvetica", labelSize: 20 });
    expect(res.nodes.bars[0]).toBeNull();
    expect(rects(r)).toHaveLength(1);
    expect(texts(r).map((t) => t.text)).toEqual(["a", "b"]);
  });
  it("places labels under the baseline and value labels above each bar", () => {
    const r = rig();
    const res = r.h.axiBars(r.doc, { ...bars, labels: ["W1", "W2", "W3"], labelFont: "Helvetica", labelSize: 20, labelColour: "#000000", valueLabels: true, name: "c" });
    const labels = texts(r).filter((t) => /-label-/.test(t.name));
    const values = texts(r).filter((t) => /-value-/.test(t.name));
    expect(labels.map((t) => t.text)).toEqual(["W1", "W2", "W3"]);
    expect(labels.map((t) => t.x)).toEqual([110, 310, 510]); // bar centres
    for (const t of labels) { expect(t.y).toBe(320 + 20 * 1.35); expect(t.align).toBe("c"); expect(t.maxW).toBe(190); }
    expect(values.map((t) => t.text)).toEqual(["4", "8", "2"]);
    expect(values.map((t) => t.y)).toEqual([170 - 8, 20 - 8, 245 - 8]); // bar tops minus 0.4 * size
    expect(res.nodes.labels).toHaveLength(3);
    expect(res.nodes.values).toHaveLength(3);
    expect(labels[0]!.font).toBe("Helvetica");
  });
  it("defaults the label size to half the pitch, capped at 32, and uses item labels first", () => {
    const r = rig();
    r.h.axiBars(r.doc, { ...bars, values: [{ value: 1, label: "own" }, 2, 3], labels: ["x", "y", "z"], labelFont: "Helvetica" });
    expect(texts(r).map((t) => t.text)).toEqual(["own", "y", "z"]);
    expect(texts(r)[0]!.size).toBe(32); // pitch 200 -> 100, capped
    const r2 = rig();
    r2.h.axiBars(r2.doc, { x: 0, y: 0, w: 60, h: 100, values: [1, 2, 3], labels: ["a", "b", "c"], labelFont: "Helvetica", colour: "#000000" });
    expect(texts(r2)[0]!.size).toBe(10); // pitch 20 -> 10
  });
  it("puts horizontal labels left of x, right-aligned, and value labels past the bar end", () => {
    const r = rig();
    r.h.axiBars(r.doc, { ...bars, horizontal: true, labels: ["a", "b", "c"], labelFont: "Helvetica", labelSize: 20, valueLabels: true });
    const lab = texts(r).filter((t) => t.align === "r");
    const val = texts(r).filter((t) => t.align === "l");
    expect(lab.map((t) => t.x)).toEqual([10 - 12, 10 - 12, 10 - 12]);
    expect(val.map((t) => t.x)).toEqual([320, 620, 170]);
  });
});

// --- axiDonut ----------------------------------------------------------------

const donut = { cx: 300, cy: 400, r: 100, values: [1, 1, 2], colours: ["#111111", "#222222"] };

describe("axiDonut validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing cx", { ...donut, cx: undefined }, /cx and cy are required/],
    ["zero r", { ...donut, r: 0 }, /r is required and must be positive/],
    ["no values", { ...donut, values: [] }, /values must be a non-empty array/],
    ["zero value", { ...donut, values: [1, 0] }, /value 1 must be a number above 0/],
    ["negative value", { ...donut, values: [-1, 2] }, /value 0 must be a number above 0/],
    ["no colours", { ...donut, colours: undefined }, /colours must be a non-empty array/],
    ["empty colours", { ...donut, colours: [] }, /colours must be a non-empty array/],
    ["bad colour", { ...donut, colours: ["#111111", "teal"] }, /colour must be a hex string/],
    ["inner 0.95", { ...donut, inner: 0.95 }, /inner must be 0 or more and less than 0.95/],
    ["gap negative", { ...donut, gap: -1 }, /gap must be 0 or more degrees/],
    ["gap swallows a slice", { ...donut, values: [1, 99], gap: 10 }, /leaves no room for the smallest slice/],
    ["start not a number", { ...donut, start: "up" }, /start must be a number/],
    ["label not an object", { ...donut, label: "100" }, /label must be/],
    ["label without a font", { ...donut, label: { text: "100" } }, /label needs text and font/],
  ];
  rejectsAll("axiDonut", bad);
});

describe("axiDonut geometry", () => {
  it("starts at 12 o'clock and sweeps pi/2, pi/2, pi for [1, 1, 2]", () => {
    const r = rig();
    const res = r.h.axiDonut(r.doc, { ...donut, name: "d" });
    expect(r.pies).toHaveLength(3);
    expect(res.total).toBe(4);
    expect(res.nodes.slices).toHaveLength(3);
    expect(r.pies.map((p) => p.shape.v.sweep)).toEqual([Math.PI / 2, Math.PI / 2, Math.PI]);
    // screen angles clockwise from 3 o'clock: 12 o'clock is -PI/2 (= 3PI/2), then 3 and 6 o'clock
    const want = [-Math.PI / 2, 0, Math.PI / 2].map(mod);
    r.pies.forEach((p, i) => expect(screenStart(p)).toBeCloseTo(want[i]!, 9));
    expect(r.pies.map((p) => p.fill)).toEqual(["hex:#111111", "hex:#222222", "hex:#111111"]);
    expect(r.doc.selection.nodes.first.userDescription).toBe("d-slice-2");
    expect(r.calls.filter((c) => c.kind === "pie").map((c) => c.userDescription)).toEqual(["d-slice-0", "d-slice-1", "d-slice-2"]);
  });
  it("stores the angle the way Affinity reads it: the mirror of the screen interval", () => {
    const r = rig();
    r.h.axiDonut(r.doc, { ...donut, values: [1, 3] });
    // first slice: screen [-90deg, 0] -> stored start 0, sweep PI/2
    expect(r.pies[0]!.shape.v.startAngle).toBeCloseTo(0, 9);
    expect(r.pies[0]!.shape.v.sweep).toBeCloseTo(Math.PI / 2, 9);
    // every stored start is wrapped into [-PI, PI)
    for (const p of r.pies) { expect(p.shape.v.startAngle).toBeGreaterThanOrEqual(-Math.PI); expect(p.shape.v.startAngle).toBeLessThan(Math.PI); }
  });
  it("sets startAngle, then sweep, then innerRadius on every slice, before create", () => {
    const r = rig();
    r.h.axiDonut(r.doc, { ...donut, inner: 0.5 });
    for (const p of r.pies) {
      expect(p.shape.order).toEqual(["startAngle", "sweep", "innerRadius"]);
      expect(p.shape.v.innerRadius).toBe(0.5);
    }
  });
  it("uses the bounding square of the circle as the rect, with no stroke", () => {
    const r = rig();
    r.h.axiDonut(r.doc, donut);
    for (const p of r.pies) {
      expect(p.rect).toEqual({ x: 200, y: 300, width: 200, height: 200 });
      expect(p.st).toBeNull();
      expect(p.ls).toBeNull();
    }
  });
  it("defaults the hole to 0.6 and treats 0 as a pie", () => {
    const r = rig();
    r.h.axiDonut(r.doc, donut);
    expect(r.pies[0]!.shape.v.innerRadius).toBe(0.6);
    const r2 = rig();
    r2.h.axiDonut(r2.doc, { ...donut, inner: 0 });
    expect(r2.pies[0]!.shape.v.innerRadius).toBe(0);
  });
  it("shrinks each sweep by the gap (4 degrees) when there is more than one slice", () => {
    const r = rig();
    r.h.axiDonut(r.doc, { ...donut, gap: 4 });
    const g = (4 * Math.PI) / 180;
    expect(r.pies.map((p) => p.shape.v.sweep)).toEqual([Math.PI / 2 - g, Math.PI / 2 - g, Math.PI - g].map((x) => expect.closeTo(x, 9)));
    // slices still start where their share starts
    const want = [-Math.PI / 2, 0, Math.PI / 2].map(mod);
    r.pies.forEach((p, i) => expect(screenStart(p)).toBeCloseTo(want[i]!, 9));
  });
  it("draws one full ring for a single value and ignores the gap", () => {
    const r = rig();
    const res = r.h.axiDonut(r.doc, { ...donut, values: [7], gap: 10 });
    expect(r.pies).toHaveLength(1);
    expect(r.pies[0]!.shape.v.sweep).toBeCloseTo(TAU, 9);
    expect(res.total).toBe(7);
  });
  it("rotates the start by the given degrees, clockwise", () => {
    const r = rig();
    r.h.axiDonut(r.doc, { ...donut, values: [1, 1], start: 90 });
    expect(screenStart(r.pies[0]!)).toBeCloseTo(mod(0), 9); // 12 o'clock + 90 deg = 3 o'clock
    expect(screenStart(r.pies[1]!)).toBeCloseTo(mod(Math.PI), 9);
  });
  it("draws the centre label and caption in the hole, with names", () => {
    const r = rig();
    const res = r.h.axiDonut(r.doc, { ...donut, inner: 0.6, label: { text: "100", sub: "sessions", font: "Helvetica-Bold", subFont: "Helvetica", colour: "#1F2A44", size: 50 }, name: "d" });
    const [main, cap] = texts(r);
    expect(main).toMatchObject({ text: "100", font: "Helvetica-Bold", size: 50, align: "c", x: 300, colour: "#1F2A44", name: "d-label" });
    expect(cap).toMatchObject({ text: "sessions", font: "Helvetica", size: 20, align: "c", x: 300, name: "d-sub" });
    expect(cap!.y).toBeGreaterThan(main!.y);
    expect(main!.maxW).toBeCloseTo(2 * 100 * 0.6 * 0.85, 9);
    expect(res.nodes.label).toBe(main);
    expect(res.nodes.sub).toBe(cap);
  });
  it("has no label nodes by default and no caption without sub", () => {
    const r = rig();
    const res = r.h.axiDonut(r.doc, { ...donut, label: { text: "9", font: "Helvetica" } });
    expect([texts(r).length, res.nodes.sub]).toEqual([1, null]);
    const r2 = rig();
    const res2 = r2.h.axiDonut(r2.doc, donut);
    expect([texts(r2).length, res2.nodes.label]).toEqual([0, null]);
  });
});

// --- axiProgress -------------------------------------------------------------

const prog = { x: 100, y: 200, w: 500, h: 40, value: 0.5, track: "#EEEEEE", fill: "#4C8DFF" };

describe("axiProgress validation (nothing touched before it passes)", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["negative value", { ...prog, value: -1 }, /value must be a number of 0 or more/],
    ["zero max", { ...prog, max: 0 }, /max must be a positive number/],
    ["no fill", { ...prog, fill: undefined }, /fill \(a hex colour\) is required/],
    ["bad fill", { ...prog, fill: "red" }, /colour must be a hex string/],
    ["bad track", { ...prog, track: "grey" }, /colour must be a hex string/],
    ["no box and no ring", { value: 1, fill: "#000000" }, /x and y are required/],
    ["zero width", { ...prog, w: 0 }, /w and h are required/],
    ["negative radius", { ...prog, radius: -1 }, /radius must be 0 or more/],
    ["ring without r", { value: 1, fill: "#000000", ring: { cx: 1, cy: 1 } }, /ring needs numbers cx, cy and r/],
    ["ring inner too big", { value: 1, fill: "#000000", ring: { cx: 1, cy: 1, r: 5, inner: 0.99 } }, /ring inner must be/],
    ["label of the wrong type", { ...prog, label: 5 }, /label must be a string/],
    ["label string without a font", { ...prog, label: "half" }, /label needs a font/],
    ["label object without a font", { ...prog, label: { size: 20 } }, /label needs a font/],
  ];
  rejectsAll("axiProgress", bad);
});

describe("axiProgress bar", () => {
  it("draws a track and a fill of width w * fraction, named", () => {
    const r = rig();
    const res = r.h.axiProgress(r.doc, { ...prog, radius: 20, name: "p" });
    const [track, fill] = rects(r);
    expect(track).toMatchObject({ x: 100, y: 200, w: 500, h: 40, fill: "#EEEEEE", radius: 20, name: "p-track" });
    expect(fill).toMatchObject({ x: 100, y: 200, w: 250, h: 40, fill: "#4C8DFF", radius: 20, name: "p-fill" });
    expect(res.fraction).toBe(0.5);
    expect(res.nodes.track).toBe(track);
    expect(res.nodes.fill).toBe(fill);
    expect(res.nodes.label).toBeNull(); // no font, no default label
  });
  it("takes max into account, accepts colour for the fill and needs no track", () => {
    const r = rig();
    const res = r.h.axiProgress(r.doc, { x: 0, y: 0, w: 200, h: 10, value: 72, max: 100, colour: "#123456" });
    expect([res.fraction, rects(r).length, rects(r)[0]!.w, rects(r)[0]!.fill]).toEqual([0.72, 1, 144, "#123456"]);
  });
  it("clamps 1.2 to 1 and draws no fill rect for 0", () => {
    const r = rig();
    const over = r.h.axiProgress(r.doc, { ...prog, value: 1.2 });
    expect(over.fraction).toBe(1);
    expect(rects(r, "").pop()!.w).toBe(500);
    const r2 = rig();
    const zero = r2.h.axiProgress(r2.doc, { ...prog, value: 0, name: "z" });
    expect(zero.fraction).toBe(0);
    expect(zero.nodes.fill).toBeNull();
    expect(rects(r2).map((c) => c.name)).toEqual(["z-track"]);
  });
  it("draws the percentage by default when a font is given, right of the fill", () => {
    const r = rig();
    const res = r.h.axiProgress(r.doc, { ...prog, value: 0.25, font: "Helvetica-Bold", size: 20, labelColour: "#111111", name: "p" });
    const t = texts(r)[0]!;
    expect(t).toMatchObject({ text: "25%", font: "Helvetica-Bold", size: 20, colour: "#111111", align: "l", name: "p-label" });
    expect(t.x).toBe(100 + 125 + 10); // fill end + half the size
    expect(t.y).toBeCloseTo(220 + 7, 9); // vertically centred on the bar
    expect(res.nodes.label).toBe(t);
    expect(r.moves).toEqual([]);
  });
  it("uses a string label, an object label and false", () => {
    const r = rig();
    r.h.axiProgress(r.doc, { ...prog, label: "half way", font: "Helvetica" });
    expect(texts(r)[0]!.text).toBe("half way");
    const r2 = rig();
    r2.h.axiProgress(r2.doc, { ...prog, label: { text: "x", font: "Helvetica-Bold", colour: "#222222", size: 18 } });
    expect(texts(r2)[0]).toMatchObject({ text: "x", font: "Helvetica-Bold", colour: "#222222", size: 18 });
    const r3 = rig();
    const res = r3.h.axiProgress(r3.doc, { ...prog, label: false, font: "Helvetica" });
    expect(texts(r3)).toHaveLength(0);
    expect(res.nodes.label).toBeNull();
  });
  it("moves the label inside the fill when there is no room to its right", () => {
    const r = rig();
    r.h.axiProgress(r.doc, { ...prog, value: 0.95, font: "Helvetica", size: 20 });
    // the 3-char label is 30 wide; fill ends at 575, track ends at 600: starts at 585, overflows by 15
    expect(r.moves).toHaveLength(1);
    const t = texts(r)[0]!;
    expect(t.box.x + t.box.w).toBeCloseTo(100 + 475 - 10, 9); // right edge pad px inside the fill end
  });
  it("centres the label in the track when the fill is too short to hold it", () => {
    const r = rig();
    r.h.axiProgress(r.doc, { x: 0, y: 0, w: 40, h: 40, value: 1, max: 1, track: "#EEEEEE", fill: "#4C8DFF", label: "much too long", font: "Helvetica", size: 20 });
    const t = texts(r)[0]!;
    expect(t.box.x + t.box.w / 2).toBeCloseTo(20, 9);
  });
});

describe("axiProgress ring", () => {
  const ring = { value: 72, max: 100, track: "#EEEEEE", fill: "#4C8DFF", ring: { cx: 300, cy: 300, r: 100 } };

  it("makes two slices: a full-ring track and a value arc from 12 o'clock", () => {
    const r = rig();
    const res = r.h.axiProgress(r.doc, { ...ring, name: "rg" });
    expect(r.pies).toHaveLength(2);
    expect(r.pies[0]!.shape.v.sweep).toBeCloseTo(TAU, 9);
    expect(r.pies[1]!.shape.v.sweep).toBeCloseTo(0.72 * TAU, 9);
    expect(screenStart(r.pies[0]!)).toBeCloseTo(mod(-Math.PI / 2), 9);
    expect(screenStart(r.pies[1]!)).toBeCloseTo(mod(-Math.PI / 2), 9);
    expect(r.pies.map((p) => p.fill)).toEqual(["hex:#EEEEEE", "hex:#4C8DFF"]);
    expect(r.pies.map((p) => p.shape.v.innerRadius)).toEqual([0.8, 0.8]);
    expect(r.pies[0]!.rect).toEqual({ x: 200, y: 200, width: 200, height: 200 });
    expect(r.calls.filter((c) => c.kind === "pie").map((c) => c.userDescription)).toEqual(["rg-track", "rg-fill"]);
    expect(res.fraction).toBe(0.72);
    expect(rects(r)).toHaveLength(0);
  });
  it("draws only the track for 0 and a full second ring for 100 percent", () => {
    const r = rig();
    const zero = r.h.axiProgress(r.doc, { ...ring, value: 0 });
    expect(r.pies).toHaveLength(1);
    expect(zero.nodes.fill).toBeNull();
    const r2 = rig();
    r2.h.axiProgress(r2.doc, { ...ring, value: 150 });
    expect(r2.pies[1]!.shape.v.sweep).toBeCloseTo(TAU, 9);
  });
  it("centres the percentage in the hole, and honours inner", () => {
    const r = rig();
    const res = r.h.axiProgress(r.doc, { ...ring, ring: { cx: 300, cy: 300, r: 100, inner: 0.7 }, label: { font: "Helvetica-Bold", size: 40, colour: "#FFFFFF" }, name: "rg" });
    const t = texts(r)[0]!;
    expect(t).toMatchObject({ text: "72%", font: "Helvetica-Bold", size: 40, align: "c", x: 300, colour: "#FFFFFF", name: "rg-label" });
    expect(t.y).toBeCloseTo(300 + 14, 9);
    expect(res.nodes.label).toBe(t);
    expect(r.pies[0]!.shape.v.innerRadius).toBe(0.7);
  });
});

// --- internals ---------------------------------------------------------------

describe("axiChartColour", () => {
  it("cycles colours, falls back to colour, and validates the hex", () => {
    const r = rig();
    expect(r.h.axiChartColour({ colours: ["#111111", "#222222"] }, 3, "x")).toBe("#222222");
    expect(r.h.axiChartColour({ colour: "#333" }, 5, "x")).toBe("#333");
    expect(() => r.h.axiChartColour({}, 0, "axiX")).toThrow(/axiX: colours/);
    expect(() => r.h.axiChartColour({ colours: ["12"] }, 0, "axiX")).toThrow(/axiX: colour must be a hex string/);
    expect(r.requires).toEqual([]);
  });
});
