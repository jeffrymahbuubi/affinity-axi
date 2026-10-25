// axiPattern, axiPatternSeam, axiCellTransform: source hygiene, validation before any SDK
// call and cell geometry, with PATTERN_SOURCE evaluated alone behind stubbed axiRect and
// axiNodesOf, a fake node tree and an affine Transform stub. Live behaviour (moving copies
// into a picture frame, pixel readback): test/live/tile-probe.js and the helpers-pattern example.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { PATTERN_INDEX, PATTERN_INTERNAL, PATTERN_SOURCE } from "../src/affinity/helpers-pattern.js";

type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;

// --- source hygiene ---------------------------------------------------------

describe("PATTERN_SOURCE", () => {
  const declared = [...PATTERN_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(PATTERN_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiPattern(") ? HELPERS_SOURCE : HELPERS_SOURCE + PATTERN_SOURCE)).not.toThrow();
  });
  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(PATTERN_SOURCE)).toEqual([]);
    expect(scanForAi(PATTERN_SOURCE)).toEqual([]);
    expect(PATTERN_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
    expect(PATTERN_SOURCE).not.toContain("`"); // String.raw block
    expect(PATTERN_SOURCE).not.toContain("${");
  });
  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of PATTERN_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !PATTERN_INDEX.some((h) => h.name === n)).sort()).toEqual([...PATTERN_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    expect(PATTERN_INDEX.map((h) => h.name)).toEqual(["axiPattern", "axiPatternSeam"]);
    expect([...PATTERN_INTERNAL]).toEqual(["axiCellTransform"]);
  });
  it("uses function declarations only, all prefixed axi, requires inside functions", () => {
    const top = PATTERN_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
    for (const line of PATTERN_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });
  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
  it("calls only helpers that exist, and reuses axiRect, axiNodesOf rather than redeclaring them", () => {
    const known = new Set([...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm), ...PATTERN_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!));
    for (const m of PATTERN_SOURCE.matchAll(/\b(axi[A-Z]\w*)\(/g)) expect(known.has(m[1]!)).toBe(true);
    expect(declared).not.toContain("axiRect");
    expect(declared).not.toContain("axiNodesOf");
    expect(PATTERN_SOURCE).toMatch(/axiRect\(doc, \{[^}]*frame: true/);
  });
  it("uses createMoveNodes with NodeMoveType.Inside and never bitmap fills or generative calls", () => {
    expect(PATTERN_SOURCE).toContain("createMoveNodes(");
    expect(PATTERN_SOURCE).toContain("NodeMoveType.Inside");
    expect(PATTERN_SOURCE).not.toMatch(/BitmapFill|generat/i);
  });
});

// --- fakes ------------------------------------------------------------------

const STUBS = String.raw`
function axiRect(doc, o) {
  const n = rec.node('frame');
  n.pictureFrameEnabled = !!o.frame;
  n.rectOpts = o;
  if (o.name !== undefined) { n.userDescription = o.name; }
  rec.rects.push(n);
  doc.selection.nodes.first = n;
  return n;
}
function axiNodesOf(doc, refs, who) {
  rec.refs.push(refs);
  return refs.map(function (r) { return typeof r === 'string' ? rec.named[r] : r; });
}
`;

/** A 2x3 affine matrix in the Transform shape the SDK uses: multiply(o) applies o first. */
class Tf {
  constructor(public a = 1, public b = 0, public c = 0, public d = 1, public e = 0, public f = 0) {}
  static createIdentity() { return new Tf(); }
  static createTranslate(x: number, y: number) { return new Tf(1, 0, 0, 1, x, y); }
  static createScale(x: number, y: number) { return new Tf(x, 0, 0, y, 0, 0); }
  static createRotate(r: number) { return new Tf(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0); }
  multiply(o: Tf) {
    return new Tf(
      this.a * o.a + this.c * o.b, this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d, this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e, this.b * o.e + this.d * o.f + this.f,
    );
  }
  applyToPoint(p: { x: number; y: number }) { return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f }; }
}
const at = (t: Tf | null, x: number, y: number) => {
  const p = (t ?? Tf.createIdentity()).applyToPoint({ x, y });
  return { x: Math.round(p.x * 1e6) / 1e6, y: Math.round(p.y * 1e6) / 1e6 };
};

function rig(opts: { failMove?: boolean } = {}) {
  const log: Rec[] = [];
  const requires: string[] = [];
  const dups: Rec[] = [];
  const applied: Rec[] = [];
  const rec: Rec = { rects: [], refs: [], named: {} };
  class FakeNode {
    isNode = true;
    userDescription = "";
    pictureFrameEnabled = false;
    children: FakeNode[] = [];
    rectOpts: Rec | undefined;
    xf: Tf | null = null;
    source: FakeNode | null = null;
    constructor(public tag: string) {}
    get selfSelection() { return { node: this }; }
    duplicate(xf: Tf) {
      const c = new FakeNode(this.tag + "-copy");
      c.xf = xf;
      c.source = this;
      dups.push(c);
      return c;
    }
    isSameNode(o: FakeNode) { return o === this; }
  }
  rec.node = (tag: string) => new FakeNode(tag);
  const modules: Record<string, Rec> = {
    "/geometry.js": { Transform: Tf },
    "/commands.js": {
      NodeMoveType: { Inside: "Inside", After: "After" },
      NodeChildType: { Main: "Main" },
      DocumentCommand: { createMoveNodes: (sel: Rec, frame: FakeNode, move: string, child: string) => ({ sel, frame, move, child }) },
    },
  };
  const doc: Rec = {
    selection: { nodes: { first: null as Rec | null } },
    executeCommand(cmd: Rec) {
      log.push({ kind: "move", move: cmd.move, child: cmd.child, node: cmd.sel.node, frame: cmd.frame });
      if (!opts.failMove) cmd.frame.children.push(cmd.sel.node);
    },
    applyTransform(xf: Tf, node: Rec) { applied.push({ xf, node }); },
  };
  const body = `${STUBS}\n${PATTERN_SOURCE}\nreturn { axiPattern, axiPatternSeam, axiCellTransform };`;
  const req = (id: string) => { requires.push(id); if (!modules[id]) throw new Error("SDK not available in tests: " + id); return modules[id]; };
  const h = new Function("require", "rec", body)(req, rec) as Record<string, Fn>;
  return { h, doc, rec, log, requires, dups, applied, modules };
}

/** A draw callback that records its cells and makes one node per call. */
function drawer(r: ReturnType<typeof rig>, perCell = 1) {
  const cells: Rec[] = [];
  const nodes: Rec[] = [];
  const draw = (d: Rec, c: Rec) => {
    cells.push(c);
    const made = Array.from({ length: perCell }, (_, k) => {
      const n = r.rec.node(`draw-${c.i}-${c.j}-${k}`);
      nodes.push(n);
      return n;
    });
    d.selection.nodes.first = made[made.length - 1];
    return perCell === 1 ? made[0] : made;
  };
  return { draw, cells, nodes };
}

const BOX = { x: 0, y: 0, w: 1080, h: 1080, tile: { w: 180, h: 180 } };

// --- axiPattern validation ----------------------------------------------------

describe("axiPattern validation (nothing touched before it passes)", () => {
  const draw = () => undefined;
  const motif = "motif";
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing x", { ...BOX, x: undefined, draw }, /x and y are required/],
    ["a zero width", { ...BOX, w: 0, draw }, /w and h are required and must be positive/],
    ["no tile", { ...BOX, tile: undefined, draw }, /tile \{w,h\} is required/],
    ["neither draw nor motif", { ...BOX }, /exactly one of draw/],
    ["both draw and motif", { ...BOX, draw, motif }, /exactly one of draw/],
    ["a draw that is not a function", { ...BOX, draw: "no" }, /draw must be a function/],
    ["an unknown offset", { ...BOX, draw, offset: "wide" }, /offset must be 'none' or 'half'/],
    ["a rotate that is not degrees", { ...BOX, draw, rotate: "alternate" }, /rotate must be degrees/],
    ["an object rotate without degrees", { ...BOX, draw, rotate: { alternate: true } }, /rotate must be degrees/],
    ["a zero scale", { ...BOX, draw, scale: 0 }, /scale must be a positive number/],
    ["a clip that is not a boolean", { ...BOX, draw, clip: "yes" }, /clip must be true or false/],
    ["a fill that is not hex", { ...BOX, draw, fill: "red" }, /fill must be a hex string/],
    ["too many cells", { ...BOX, w: 200, h: 190, tile: { w: 10, h: 10 }, draw }, /21 x 20 = 420 cells is above the limit of 400/],
  ];
  for (const [label, o, re] of bad) {
    it(`rejects ${label}`, () => {
      const r = rig();
      expect(() => r.h.axiPattern!(r.doc, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.rec.rects).toEqual([]);
      expect(r.log).toEqual([]);
    });
  }
  it("accepts exactly 400 cells", () => {
    const r = rig();
    const d = drawer(r);
    const out = r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 190, h: 190, tile: { w: 10, h: 10 }, draw: d.draw, clip: false });
    expect(out.cols * out.rows).toBe(400);
    expect(d.cells).toHaveLength(400);
  });
});

// --- axiPattern geometry -------------------------------------------------------

describe("axiPattern with draw", () => {
  it("calls draw once per cell with {x,y,w,h,i,j}, row by row, one extra column and row", () => {
    const r = rig();
    const d = drawer(r);
    const out = r.h.axiPattern!(r.doc, { ...BOX, draw: d.draw });
    expect(out.cols).toBe(7);
    expect(out.rows).toBe(7);
    expect(out.count).toBe(49);
    expect(d.cells).toHaveLength(49);
    expect(d.cells[0]).toEqual({ x: 0, y: 0, w: 180, h: 180, i: 0, j: 0 });
    expect(d.cells[1]).toEqual({ x: 180, y: 0, w: 180, h: 180, i: 1, j: 0 });
    expect(d.cells[7]).toEqual({ x: 0, y: 180, w: 180, h: 180, i: 0, j: 1 });
    expect(d.cells[48]).toEqual({ x: 1080, y: 1080, w: 180, h: 180, i: 6, j: 6 });
  });
  it("shifts odd rows left by half a tile under offset 'half' and not otherwise", () => {
    const half = rig();
    const dh = drawer(half);
    half.h.axiPattern!(half.doc, { ...BOX, offset: "half", draw: dh.draw });
    const row = (j: number) => dh.cells.filter((c) => c.j === j).map((c) => c.x);
    expect(row(0)[0]).toBe(0);
    expect(row(1)[0]).toBe(-90);
    expect(row(2)[0]).toBe(0);
    expect(row(3)[0]).toBe(-90);
    expect(row(1)[6]).toBe(990);
    const none = rig();
    const dn = drawer(none);
    none.h.axiPattern!(none.doc, { ...BOX, offset: "none", draw: dn.draw });
    expect(dn.cells.filter((c) => c.j === 1)[0]!.x).toBe(0);
  });
  it("covers the box with a half-drop: every row reaches both edges", () => {
    const r = rig();
    const d = drawer(r);
    r.h.axiPattern!(r.doc, { ...BOX, offset: "half", draw: d.draw });
    for (let j = 0; j < 7; j += 1) {
      const xs = d.cells.filter((c) => c.j === j).map((c) => c.x);
      expect(Math.min(...xs)).toBeLessThanOrEqual(0);
      expect(Math.max(...xs) + 180).toBeGreaterThanOrEqual(1080);
    }
  });
  it("moves the drawn nodes into the frame with Inside / Main and returns them as cells", () => {
    const r = rig();
    const d = drawer(r);
    const out = r.h.axiPattern!(r.doc, { ...BOX, fill: "#F2F5F9", name: "pat", draw: d.draw });
    const frame = out.nodes.frame;
    expect(frame.pictureFrameEnabled).toBe(true);
    expect(frame.rectOpts).toMatchObject({ x: 0, y: 0, w: 1080, h: 1080, fill: "#F2F5F9", frame: true, name: "pat-frame" });
    expect(r.rec.rects).toEqual([frame]);
    expect(frame.children).toHaveLength(49);
    expect(r.log).toHaveLength(49);
    for (const m of r.log) {
      expect(m.move).toBe("Inside");
      expect(m.child).toBe("Main");
      expect(m.frame).toBe(frame);
    }
    expect(out.nodes.cells).toEqual(d.nodes);
    expect(r.doc.selection).toBe(frame);
  });
  it("names the frame and cells <name>-frame and <name>-cell-<i>-<j>, with -<k> for several nodes", () => {
    const r = rig();
    const d = drawer(r);
    const out = r.h.axiPattern!(r.doc, { ...BOX, name: "pat", draw: d.draw });
    expect(out.nodes.frame.userDescription).toBe("pat-frame");
    expect(out.nodes.cells[0].userDescription).toBe("pat-cell-0-0");
    expect(out.nodes.cells[48].userDescription).toBe("pat-cell-6-6");
    const r2 = rig();
    const d2 = drawer(r2, 2);
    const out2 = r2.h.axiPattern!(r2.doc, { ...BOX, name: "pat", draw: d2.draw });
    expect(out2.nodes.cells).toHaveLength(98);
    expect(out2.nodes.cells.slice(0, 2).map((n: Rec) => n.userDescription)).toEqual(["pat-cell-0-0-0", "pat-cell-0-0-1"]);
  });
  it("takes the selected node when draw returns nothing, and throws when there is none", () => {
    const r = rig();
    const made: Rec[] = [];
    const out = r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 100, h: 100, tile: { w: 100, h: 100 }, clip: false, draw: (d: Rec) => { const n = r.rec.node("sel"); made.push(n); d.selection.nodes.first = n; } });
    expect(out.nodes.cells).toEqual(made);
    const r2 = rig();
    expect(() => r2.h.axiPattern!(r2.doc, { x: 0, y: 0, w: 100, h: 100, tile: { w: 100, h: 100 }, clip: false, draw: () => undefined })).toThrow(/draw made no node for cell 0,0/);
  });
  it("clip:false draws no frame and moves nothing", () => {
    const r = rig();
    const d = drawer(r);
    const out = r.h.axiPattern!(r.doc, { ...BOX, clip: false, fill: "#000", draw: d.draw });
    expect(out.nodes.frame).toBeNull();
    expect(r.rec.rects).toEqual([]);
    expect(r.log).toEqual([]);
    expect(out.nodes.cells).toHaveLength(49);
    expect(r.doc.selection.nodes.first).not.toBeNull();
  });
  it("applies rotate and scale to each drawn node about the cell centre, alternating the sign on request", () => {
    const r = rig();
    const d = drawer(r);
    r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 180, h: 180, tile: { w: 180, h: 180 }, rotate: { deg: 90, alternate: true }, scale: 0.5, clip: false, draw: d.draw });
    expect(r.applied).toHaveLength(4);
    const byNode = (j: number, i: number) => r.applied.find((a) => a.node === d.nodes.find((n) => n.tag === `draw-${i}-${j}-0`))!.xf as Tf;
    // cell (0,0): centre (90,90); a point 40 right of it goes 20 down (+90 degrees, half size)
    expect(at(byNode(0, 0), 130, 90)).toEqual({ x: 90, y: 110 });
    expect(at(byNode(0, 0), 90, 90)).toEqual({ x: 90, y: 90 });
    // cell (1,0): centre (270,90); odd cell, so -90 degrees
    expect(at(byNode(0, 1), 310, 90)).toEqual({ x: 270, y: 70 });
    // cell (1,1): even again
    expect(at(byNode(1, 1), 310, 270)).toEqual({ x: 270, y: 290 });
  });
  it("a plain rotate number turns every cell the same way; no rotate or scale applies no transform", () => {
    const r = rig();
    const d = drawer(r);
    r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 180, h: 100, tile: { w: 90, h: 100 }, rotate: 90, clip: false, draw: d.draw });
    expect(r.applied).toHaveLength(6);
    expect(r.applied.every((a) => Math.round(a.xf.b) === 1)).toBe(true);
    const plain = rig();
    plain.h.axiPattern!(plain.doc, { ...BOX, clip: false, draw: drawer(plain).draw });
    expect(plain.applied).toEqual([]);
  });
});

describe("axiPattern with motif", () => {
  it("keeps the original as cell 0,0 and duplicates the rest with a translation to each cell", () => {
    const r = rig();
    const m = r.rec.node("motif");
    const out = r.h.axiPattern!(r.doc, { ...BOX, motif: m, name: "pat" });
    expect(r.dups).toHaveLength(48);
    expect(r.applied).toEqual([]); // the original needs no transform
    expect(out.nodes.cells).toHaveLength(49);
    expect(out.nodes.cells[0]).toBe(m);
    expect(m.userDescription).toBe("pat-cell-0-0");
    // the copy for cell (2,1) lands at x 360, y 180
    const copy = out.nodes.cells.find((n: Rec) => n.userDescription === "pat-cell-2-1");
    expect(at(copy.xf, 0, 0)).toEqual({ x: 360, y: 180 });
    expect(copy.source).toBe(m);
    expect(r.doc.selection).toBe(out.nodes.frame);
  });
  it("moves the original and every copy into the frame, copies first", () => {
    const r = rig();
    const m = r.rec.node("motif");
    const out = r.h.axiPattern!(r.doc, { ...BOX, motif: m });
    expect(out.nodes.frame.children).toHaveLength(49);
    expect(r.log[0]!.node).toBe(m);
    expect(r.log.every((x) => x.move === "Inside" && x.child === "Main")).toBe(true);
  });
  it("offsets odd rows by half a tile under offset 'half'", () => {
    const r = rig();
    const m = r.rec.node("motif");
    const out = r.h.axiPattern!(r.doc, { ...BOX, motif: m, offset: "half", name: "pat" });
    const copy = out.nodes.cells.find((n: Rec) => n.userDescription === "pat-cell-2-1");
    expect(at(copy.xf, 0, 0)).toEqual({ x: 270, y: 180 });
    const even = out.nodes.cells.find((n: Rec) => n.userDescription === "pat-cell-2-2");
    expect(at(even.xf, 0, 0)).toEqual({ x: 360, y: 360 });
  });
  it("rotates and scales about the cell centre, the original included", () => {
    const r = rig();
    const m = r.rec.node("motif");
    const out = r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 180, h: 180, tile: { w: 180, h: 180 }, motif: m, rotate: { deg: 90, alternate: true }, scale: 0.5, name: "pat" });
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0]!.node).toBe(m);
    expect(at(r.applied[0]!.xf, 130, 90)).toEqual({ x: 90, y: 110 });
    const odd = out.nodes.cells.find((n: Rec) => n.userDescription === "pat-cell-1-0");
    // the copy starts in cell (0,0): its centre (90,90) maps to cell (1,0)'s centre (270,90)
    expect(at(odd.xf, 90, 90)).toEqual({ x: 270, y: 90 });
    expect(at(odd.xf, 130, 90)).toEqual({ x: 270, y: 70 });
  });
  it("resolves a name or ref through axiNodesOf and takes an array of motifs", () => {
    const r = rig();
    const a = r.rec.node("a");
    const b = r.rec.node("b");
    r.rec.named["petal"] = a;
    const out = r.h.axiPattern!(r.doc, { x: 0, y: 0, w: 100, h: 100, tile: { w: 100, h: 100 }, motif: ["petal", b], name: "p" });
    expect(r.rec.refs[0]).toEqual(["petal", b]);
    expect(out.nodes.cells).toHaveLength(8);
    expect(r.dups).toHaveLength(6);
    expect(out.nodes.cells.slice(0, 2)).toEqual([a, b]);
    expect(a.userDescription).toBe("p-cell-0-0-0");
    expect(b.userDescription).toBe("p-cell-0-0-1");
    const single = rig();
    const m = single.rec.node("m");
    single.h.axiPattern!(single.doc, { ...BOX, motif: m });
    expect(single.rec.refs[0]).toEqual([m]);
  });
  it("throws a named error and stops when a copy cannot be moved into the frame", () => {
    const r = rig({ failMove: true });
    const m = r.rec.node("motif");
    expect(() => r.h.axiPattern!(r.doc, { ...BOX, motif: m })).toThrow(/cannot move a cell into the frame on this Affinity build; pass clip:false/);
    expect(r.log).toHaveLength(1);
  });
});

describe("axiCellTransform", () => {
  it("is null when nothing changes, a plain translation without rotate and scale", () => {
    const r = rig();
    const cell = { x: 180, y: 0, w: 180, h: 180 };
    expect(r.h.axiCellTransform!(cell, 0, 1, { x: 180, y: 0 })).toBeNull();
    expect(at(r.h.axiCellTransform!(cell, 0, 1, { x: 0, y: 0 }) as Tf, 5, 5)).toEqual({ x: 185, y: 5 });
  });
  it("keeps the cell centre fixed under rotate and scale", () => {
    const r = rig();
    const cell = { x: 200, y: 100, w: 100, h: 60 };
    const xf = r.h.axiCellTransform!(cell, 37, 2, { x: 200, y: 100 }) as Tf;
    expect(at(xf, 250, 130)).toEqual({ x: 250, y: 130 });
  });
});

// --- axiPatternSeam -------------------------------------------------------------

describe("axiPatternSeam", () => {
  type Px = { r: number; g: number; b: number; alpha: number };
  const px = (r: number, g = r, b = r, alpha = 255): Px => ({ r, g, b, alpha });

  function seamRig(w: number, h: number, pixel: (x: number, y: number) => Px, fail = false) {
    const r = rig();
    const state = { disposed: 0, reads: [] as number[][], engineNode: null as unknown, format: null as unknown, copy: null as unknown };
    r.modules["/rasterobject.js"] = {
      RasterFormat: { RGBA8: "RGBA8" },
      NodeRenderingEngine: {
        createDefault(node: unknown, format: unknown) {
          state.engineNode = node;
          state.format = format;
          return { createCompatibleBitmap(copy: unknown) { state.copy = copy; return { width: w, height: h }; } };
        },
      },
    };
    r.modules["/pixelaccessor.js"] = {
      PixelReaderRGBA8: {
        create: () => ({
          readPixel(x: number, y: number) { if (fail) throw new Error("readback unavailable"); state.reads.push([x, y]); return pixel(x, y); },
          dispose() { state.disposed += 1; },
        }),
      },
    };
    return { r, state };
  }
  const node = { isNode: true };

  it("is 0 on a uniform image, renders the node as RGBA8 with contents copied, and disposes the reader", () => {
    const { r, state } = seamRig(240, 120, () => px(10));
    const out = r.h.axiPatternSeam!(r.doc, node);
    expect(out).toEqual({ left: 0, right: 0, top: 0, bottom: 0, max: 0 });
    expect(state.engineNode).toBe(node);
    expect(state.format).toBe("RGBA8");
    expect(state.copy).toBe(true);
    expect(state.disposed).toBe(1);
    expect(state.reads).toHaveLength(16 * 4);
  });
  it("compares column 0 with the last column and row 0 with the last row, at the sample positions", () => {
    const { r, state } = seamRig(100, 50, () => px(0));
    r.h.axiPatternSeam!(r.doc, node, { samples: 4 });
    const left = state.reads.filter(([x]) => x === 0).map(([, y]) => y);
    const right = state.reads.filter(([x]) => x === 99).map(([, y]) => y);
    expect(left).toEqual([6, 18, 31, 43]);
    expect(right).toEqual(left);
    const top = state.reads.filter(([, y]) => y === 0).map(([x]) => x);
    const bottom = state.reads.filter(([, y]) => y === 49).map(([x]) => x);
    expect(top).toEqual([12, 37, 62, 87]);
    expect(bottom).toEqual(top);
  });
  it("reports the largest channel difference across the left-right seam in left and right, and max", () => {
    const { r } = seamRig(100, 100, (x) => (x === 0 ? px(100, 100, 100) : px(130, 100, 100)));
    const out = r.h.axiPatternSeam!(r.doc, node, { samples: 8 });
    expect(out.left).toBe(30);
    expect(out.right).toBe(30);
    expect(out.top).toBe(0);
    expect(out.bottom).toBe(0);
    expect(out.max).toBe(30);
  });
  it("reports the top-bottom seam and counts alpha as a channel", () => {
    const { r } = seamRig(100, 100, (_x, y) => (y === 99 ? px(0, 0, 0, 200) : px(0, 0, 0, 255)));
    const out = r.h.axiPatternSeam!(r.doc, node, { samples: 8 });
    expect(out.top).toBe(55);
    expect(out.bottom).toBe(55);
    expect(out.left).toBe(0);
    expect(out.max).toBe(55);
  });
  it("splits the samples between left and right by even and odd index", () => {
    const { r } = seamRig(100, 100, (x, y) => (x === 0 && y < 20 ? px(40) : px(0))); // only row 12 (sample 0) differs
    const out = r.h.axiPatternSeam!(r.doc, node, { samples: 4 });
    expect(out.left).toBe(40);
    expect(out.right).toBe(0);
  });
  it("validates before any SDK call", () => {
    const { r } = seamRig(10, 10, () => px(0));
    expect(() => r.h.axiPatternSeam!(r.doc, null)).toThrow(/node must be a document node/);
    expect(() => r.h.axiPatternSeam!(r.doc, { nope: 1 })).toThrow(/node must be a document node/);
    expect(() => r.h.axiPatternSeam!(r.doc, node, { samples: 1 })).toThrow(/samples must be a whole number of 2 or more/);
    expect(() => r.h.axiPatternSeam!(r.doc, node, { samples: 2.5 })).toThrow(/samples must be a whole number/);
    expect(r.requires).toEqual([]);
  });
  it("wraps a readback failure in a named error and still disposes the reader", () => {
    const { r, state } = seamRig(10, 10, () => px(0), true);
    expect(() => r.h.axiPatternSeam!(r.doc, node)).toThrow(/axiPatternSeam: pixel readback failed \[readback unavailable\]/);
    expect(state.disposed).toBe(1);
  });
});
