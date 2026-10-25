// axiArcText and axiSeal: source hygiene, validation before any SDK call, the
// arc geometry (centred on the wanted angle, top clockwise, bottom reversed),
// and the seal's radii, names, burst and centre stacking against a recording
// fake SDK. Rendering is covered by the helpers-seal example and the live probe
// (test/live/arc-probe.js).

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { SEAL_INDEX, SEAL_INTERNAL, SEAL_SOURCE } from "../src/affinity/helpers-seal.js";

type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;

// --- source hygiene ---------------------------------------------------------

describe("SEAL_SOURCE", () => {
  const declared = [...SEAL_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(SEAL_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiSeal(") ? HELPERS_SOURCE : HELPERS_SOURCE + SEAL_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(SEAL_SOURCE)).toEqual([]);
    expect(scanForAi(SEAL_SOURCE)).toEqual([]);
    expect(SEAL_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(SEAL_SOURCE).not.toContain("`");
    expect(SEAL_SOURCE).not.toContain("${");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of SEAL_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !SEAL_INDEX.some((h) => h.name === n)).sort()).toEqual([...SEAL_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = SEAL_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
  });

  it("keeps every require() inside a function", () => {
    for (const line of SEAL_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });

  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("does not use the generative or document-closing APIs", () => {
    expect(SEAL_SOURCE).not.toMatch(/generat|\.close\b/i);
  });
});

// --- fake SDK ---------------------------------------------------------------

interface Rig {
  h: Record<string, Fn>;
  doc: Rec;
  requires: string[];
  added: Rec[];
  arcs: Rec[];
  texts: Rec[];
  ellipses: Rec[];
  stories: Rec[];
  stars: Rec[];
  order: string[];
}

/**
 * opts.noArc: the fake geometry module has no addArc. opts.stubArc: axiArcText is replaced by a
 * recorder (for the axiSeal tests); opts.noBottom makes the stub throw the P3.3 message for the
 * bottom side. opts.maxInner: the fake star's maxInnerRadius.
 */
function rig(opts: { noArc?: boolean; stubArc?: boolean; noBottom?: boolean; otherError?: boolean; maxInner?: number } = {}): Rig {
  const requires: string[] = [];
  const added: Rec[] = [];
  const arcs: Rec[] = [];
  const texts: Rec[] = [];
  const ellipses: Rec[] = [];
  const stories: Rec[] = [];
  const stars: Rec[] = [];
  const order: string[] = [];

  class CurveBuilder {
    calls: Rec[] = [];
    beginXY(x: number, y: number) {
      this.calls.push({ begin: { x, y } });
      return this;
    }
    createCurve() {
      return { _curve: this.calls };
    }
  }
  if (!opts.noArc) {
    (CurveBuilder.prototype as Rec).addArc = function (this: CurveBuilder, a0: number, a1: number, r: number, reverse: boolean) {
      this.calls.push({ arc: { a0, a1, r, reverse } });
      return this;
    };
  }
  const modules: Record<string, Rec> = {
    "/geometry.js": {
      CurveBuilder,
      PolyCurve: class {
        static create() {
          return { curves: [] as Rec[], addCurve(c: Rec) { this.curves.push(c); } };
        }
      },
    },
    "/nodes.js": {
      CurvePathTextNodeDefinition: { createFromStoryBuilder: (path: Rec, sb: Rec) => ({ kind: "arc", path, sb }) },
      ShapeNodeDefinition: { create: (s: Rec, box: Rec, fill: unknown, st: unknown, ls: unknown) => ({ kind: "shape", s, box, fill, st, ls }) },
    },
    "/storydelta.js": { StoryDelta: { createAlignX: (v: unknown) => ({ alignX: v }) } },
    "/paragraphatts.js": { ParagraphAlignXType: { Centre: "centre" } },
    "/shapes.js": {
      ShapeStar: {
        create() {
          const s: Rec = { _kind: "star", maxInnerRadius: opts.maxInner ?? 0.99 };
          stars.push(s);
          return s;
        },
      },
    },
  };
  const doc: Rec = {
    selection: { nodes: { first: null as Rec | null } },
    addNode(def: Rec) {
      const node: Rec = { def, userDescription: "" };
      added.push(node);
      order.push(def.kind === "shape" ? def.s._kind : def.kind);
      doc.selection.nodes.first = node;
    },
  };
  // Stubs for the helpers the seal composes, declared in the same scope as the source.
  const extra = `
    axiSurface = function () {};
    axiHex = function (h) { return 'rgb:' + h; };
    axiStyled = function (doc, o) {
      const rec = { o: o, deltas: [], text: null };
      STORIES.push(rec);
      return { applyParagraphDelta: function (d) { rec.deltas.push(d); }, addText: function (t) { rec.text = t; } };
    };
    axiEllipse = function (doc, o) { ELLIPSES.push(o); ORDER.push('ellipse'); const n = { userDescription: o.name, o: o }; return n; };
    axiText = function (doc, o) { TEXTS.push(o); ORDER.push('text'); return { userDescription: o.name, o: o }; };
    ${opts.stubArc ? `
    axiArcText = function (doc, o) {
      if (${opts.otherError ? "true" : "false"} && o.side === 'bottom') { throw new Error('boom'); }
      if (${opts.noBottom ? "true" : "false"} && o.side === 'bottom') { throw new Error('axiArcText: bottom text is not supported on this build'); }
      ARCS.push(o); ORDER.push('arc-' + o.side); return { userDescription: o.name, o: o };
    };` : ""}
  `;
  const src = HELPERS_SOURCE.includes("function axiSeal(") ? HELPERS_SOURCE : HELPERS_SOURCE + SEAL_SOURCE;
  const names = [...new Set([...src.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!))];
  const body = `${src}\n${extra}\nreturn { ${names.join(", ")} };`;
  const h = new Function("require", "STORIES", "ELLIPSES", "TEXTS", "ARCS", "ORDER", body)(
    (id: string) => {
      requires.push(id);
      const m = modules[id];
      if (!m) throw new Error("SDK not available in tests: " + id);
      return m;
    },
    stories,
    ellipses,
    texts,
    arcs,
    order,
  ) as Record<string, Fn>;
  return { h, doc, requires, added, arcs, texts, ellipses, stories, stars, order };
}

const deg = (rad: number) => (rad * 180) / Math.PI;
const arcOf = (node: Rec) => {
  const calls = node.def.path.curves[0]._curve as Rec[];
  return { begin: calls[0]!.begin as { x: number; y: number }, ...(calls[1]!.arc as { a0: number; a1: number; r: number; reverse: boolean }) };
};
const okArc = { cx: 500, cy: 400, r: 300, text: "LUMEN", font: "Helvetica-Bold", size: 40 };
const okSeal = { cx: 540, cy: 540, r: 300, font: "Helvetica-Bold" };

// --- axiArcText validation ---------------------------------------------------

describe("axiArcText validation", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing cx", { ...okArc, cx: undefined }, /cx and cy are required/],
    ["non-finite cy", { ...okArc, cy: NaN }, /cx and cy are required/],
    ["missing r", { ...okArc, r: undefined }, /r is required and must be positive/],
    ["zero r", { ...okArc, r: 0 }, /r is required and must be positive/],
    ["unknown side", { ...okArc, side: "left" }, /side must be top or bottom \(got left\)/],
    ["empty text", { ...okArc, text: "" }, /text is required/],
    ["numeric text", { ...okArc, text: 5 }, /text is required/],
    ["no font", { ...okArc, font: undefined }, /font .* is required/],
    ["zero size", { ...okArc, size: 0 }, /size is required and must be positive/],
    ["string spacing", { ...okArc, spacing: "wide" }, /spacing must be a number/],
    ["string start", { ...okArc, start: "up" }, /start must be a number of degrees/],
    ["text longer than the circle", { ...okArc, r: 100, size: 40, text: "A".repeat(50) }, /text is too long for the circle \(about 1100 px of text on 628 px of circle\)/],
  ];
  for (const [label, o, re] of bad) {
    it(`rejects ${label} before touching the SDK`, () => {
      const r = rig();
      expect(() => r.h.axiArcText(r.doc, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.added).toEqual([]);
    });
  }

  it("counts tracking in the length estimate", () => {
    const r = rig();
    const o = { ...okArc, r: 100, size: 20, text: "A".repeat(50) }; // 550 px untracked, 1100 at spacing 1
    expect(() => r.h.axiArcText(r.doc, o)).not.toThrow();
    expect(() => r.h.axiArcText(r.doc, { ...o, spacing: 1 })).toThrow(/too long for the circle/);
  });
});

// --- axiArcText geometry -----------------------------------------------------

describe("axiArcText", () => {
  it("top: a clockwise arc centred on 12 o'clock, beginning on the circle, not reversed", () => {
    const r = rig();
    const node = r.h.axiArcText(r.doc, okArc);
    const a = arcOf(node);
    expect(a.r).toBe(300);
    expect(a.reverse).toBe(false);
    expect(a.a1).toBeGreaterThan(a.a0);
    expect(deg((a.a0 + a.a1) / 2)).toBeCloseTo(-90, 6); // document angle of 12 o'clock
    expect(a.begin.x).toBeCloseTo(500 + 300 * Math.cos(a.a0), 6);
    expect(a.begin.y).toBeCloseTo(400 + 300 * Math.sin(a.a0), 6);
    expect(a.begin.y).toBeLessThan(400); // the arc starts above the centre
  });

  it("bottom: a counter-clockwise (reversed) arc centred on 6 o'clock", () => {
    const r = rig();
    const a = arcOf(r.h.axiArcText(r.doc, { ...okArc, side: "bottom" }));
    expect(a.reverse).toBe(true);
    expect(a.a0).toBeGreaterThan(a.a1);
    expect(deg((a.a0 + a.a1) / 2)).toBeCloseTo(90, 6); // document angle of 6 o'clock
    expect(a.begin.x).toBeCloseTo(500 + 300 * Math.cos(a.a0), 6);
    expect(a.begin.y).toBeCloseTo(400 + 300 * Math.sin(a.a0), 6);
    expect(a.begin.y).toBeGreaterThan(400);
    expect(a.begin.x).toBeLessThan(500); // it starts at the left so the text reads left to right
  });

  it("start is the clock angle of the middle of the text, normalised to 0..360", () => {
    const r = rig();
    const mid = (o: Rec) => {
      const a = arcOf(r.h.axiArcText(r.doc, { ...okArc, ...o }));
      return (deg((a.a0 + a.a1) / 2) + 90 + 720) % 360;
    };
    expect(mid({ start: 90 })).toBeCloseTo(90, 6);
    expect(mid({ start: 450 })).toBeCloseTo(90, 6);
    expect(mid({ start: -90 })).toBeCloseTo(270, 6);
    expect(mid({ start: 45, side: "bottom" })).toBeCloseTo(45, 6);
    expect(mid({ side: "bottom" })).toBeCloseTo(180, 6); // default start for bottom
    expect(mid({})).toBeCloseTo(0, 6); // default start for top
  });

  it("makes the arc long enough for the text and never a full circle", () => {
    const r = rig();
    const span = (o: Rec) => {
      const a = arcOf(r.h.axiArcText(r.doc, { ...okArc, ...o }));
      return Math.abs(deg(a.a1 - a.a0));
    };
    expect(span({ text: "AB" })).toBeGreaterThanOrEqual(40);
    // 0.8 em per character is what the arc is sized for, so it always exceeds the text's own angle.
    expect(span({ text: "LUMEN STUDIO", size: 48 })).toBeGreaterThan(deg((0.8 * 48 * 12) / 300));
    expect(span({ text: "A".repeat(100), size: 20, r: 300 })).toBeLessThanOrEqual(359);
  });

  it("builds a centre aligned story with the font, size, colour and spacing, adds one node and names it", () => {
    const r = rig();
    const node = r.h.axiArcText(r.doc, { ...okArc, colour: "#1F2A44", spacing: 0.15, name: "seal-top" });
    expect(r.added).toHaveLength(1);
    expect(r.added[0]!.def.kind).toBe("arc");
    expect(node).toBe(r.added[0]);
    expect(node.userDescription).toBe("seal-top");
    expect(r.stories).toHaveLength(1);
    expect(r.stories[0]!.o).toEqual({ font: "Helvetica-Bold", size: 40, colour: "#1F2A44", spacing: 0.15 });
    expect(r.stories[0]!.deltas).toEqual([{ alignX: "centre" }]);
    expect(r.stories[0]!.text).toBe("LUMEN");
  });

  it("throws the 'not supported on this build' message when the SDK has no addArc", () => {
    const r = rig({ noArc: true });
    expect(() => r.h.axiArcText(r.doc, { ...okArc, side: "bottom" })).toThrow("axiArcText: bottom text is not supported on this build");
    expect(r.added).toEqual([]);
  });
});

// --- axiSeal validation ------------------------------------------------------

describe("axiSeal validation", () => {
  const bad: Array<[string, Rec | undefined, RegExp]> = [
    ["no options", undefined, /options .* are required/],
    ["missing cx", { ...okSeal, cx: undefined }, /cx and cy are required/],
    ["missing r", { ...okSeal, r: undefined }, /r is required and must be positive/],
    ["negative r", { ...okSeal, r: -3 }, /r is required and must be positive/],
    ["zero size", { ...okSeal, size: 0, top: "A" }, /size must be positive/],
    ["numeric font", { ...okSeal, font: 7 }, /font must be a postscript name/],
    ["text without a font", { cx: 1, cy: 1, r: 300, top: "LUMEN" }, /font is required/],
    ["centre line without a font", { cx: 1, cy: 1, r: 300, centre: "50%" }, /font is required/],
    ["empty top", { ...okSeal, top: "" }, /top must be a non-empty string/],
    ["numeric bottom", { ...okSeal, bottom: 5 }, /bottom must be a non-empty string/],
    ["centre line without text", { ...okSeal, centre: [{ size: 40 }] }, /centre line 0 needs text/],
    ["centre line size zero", { ...okSeal, centre: [{ text: "x", size: 0 }] }, /centre line 0 size must be positive/],
    ["burst points 2", { ...okSeal, burst: { points: 2 } }, /burst.points must be a whole number 3..120/],
    ["burst points 2.5", { ...okSeal, burst: { points: 2.5 } }, /burst.points must be a whole number/],
    ["burst depth 0", { ...okSeal, burst: { depth: 0 } }, /burst.depth must be above 0 and at most 0.5/],
    ["burst depth 0.6", { ...okSeal, burst: { depth: 0.6 } }, /burst.depth must be above 0 and at most 0.5/],
    ["burst a string", { ...okSeal, burst: "yes" }, /burst must be true, false or/],
    ["ring a number", { ...okSeal, ring: 3 }, /ring must be true, false or/],
    ["negative inset", { ...okSeal, ring: { inset: -1 } }, /ring.inset must be 0 or more/],
    ["zero stroke width", { ...okSeal, ring: { strokeWidth: 0 } }, /ring.strokeWidth must be positive/],
    ["size too large for the rings", { ...okSeal, r: 100, size: 80, top: "A", burst: true, ring: { inset: 30 } }, /size 80 is too large for r 100/],
    ["centre line too big for the circle", { ...okSeal, r: 100, centre: [{ text: "x", size: 400 }] }, /centre line 0 does not fit/],
    ["text too long for its arc", { ...okSeal, r: 100, size: 40, top: "A".repeat(80) }, /too long for the circle/],
  ];
  for (const [label, o, re] of bad) {
    it(`rejects ${label} before touching the SDK`, () => {
      const r = rig();
      expect(() => r.h.axiSeal(r.doc, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.added).toEqual([]);
      expect(r.ellipses).toEqual([]);
    });
  }
});

// --- axiSeal composition -----------------------------------------------------

describe("axiSeal", () => {
  const full = {
    cx: 540,
    cy: 540,
    r: 300,
    top: "LUMEN STUDIO",
    bottom: "EST. 2026",
    centre: [{ text: "-20%", font: "Helvetica-Bold", size: 150 }, "studio hours"],
    font: "Helvetica-Bold",
    size: 40,
    colour: "#1F2A44",
    spacing: 0.15,
    burst: { points: 28, depth: 0.1, fill: "#FFC857" },
    ring: { fill: "#F2F5F9", stroke: "#1F2A44", strokeWidth: 4, inset: 24 },
    name: "seal",
  };

  it("draws burst, ring disc, inner circle, top, bottom and centre in that order and names every part", () => {
    const r = rig({ stubArc: true });
    const res = r.h.axiSeal(r.doc, full);
    expect(r.order).toEqual(["star", "ellipse", "ellipse", "arc-top", "arc-bottom", "text", "text"]);
    expect(r.added[0]!.userDescription).toBe("seal-burst");
    expect(res.nodes.ring.userDescription).toBe("seal-ring");
    expect(res.nodes.ringInner.userDescription).toBe("seal-ring-inner");
    expect(res.nodes.top.userDescription).toBe("seal-top");
    expect(res.nodes.bottom.userDescription).toBe("seal-bottom");
    expect(res.nodes.centre.map((n: Rec) => n.userDescription)).toEqual(["seal-centre-0", "seal-centre-1"]);
    expect(res.nodes.burst).toBe(r.added[0]);
  });

  it("puts the arc texts at r - depth - inset - size (top) and one cap height further out (bottom)", () => {
    const r = rig({ stubArc: true });
    const res = r.h.axiSeal(r.doc, full);
    const textR = 300 - 30 - 24 - 40;
    expect(res.textR).toBeCloseTo(textR, 9);
    const top = r.arcs.find((a) => a.side === "top")!;
    const bottom = r.arcs.find((a) => a.side === "bottom")!;
    expect(top).toMatchObject({ cx: 540, cy: 540, text: "LUMEN STUDIO", font: "Helvetica-Bold", size: 40, colour: "#1F2A44", spacing: 0.15, start: 0 });
    expect(top.r).toBeCloseTo(textR, 9);
    expect(bottom).toMatchObject({ text: "EST. 2026", start: 180 });
    expect(bottom.r).toBeCloseTo(textR + 0.72 * 40, 9);
  });

  it("sizes the burst star to 2r, valleys at 1 - depth, and the ring disc and inner circle from the valley radius", () => {
    const r = rig({ stubArc: true });
    r.h.axiSeal(r.doc, full);
    const star = r.stars[0]!;
    expect(star.points).toBe(28);
    expect(star.innerRadius).toBeCloseTo(0.9, 9);
    expect(r.added[0]!.def.box).toEqual({ x: 240, y: 240, width: 600, height: 600 });
    expect(r.added[0]!.def.fill).toBe("rgb:#FFC857");
    expect(r.added[0]!.def.st).toBeNull();
    const [disc, inner] = r.ellipses;
    expect(disc).toMatchObject({ x: 270, y: 270, w: 540, h: 540, fill: "#F2F5F9" });
    expect(disc.stroke).toBeUndefined();
    expect(inner).toMatchObject({ x: 540 - 246, y: 540 - 246, w: 492, h: 492, stroke: "#1F2A44", strokeWidth: 4 });
    expect(inner.fill).toBeUndefined();
  });

  it("clamps the star's inner radius to just under its maximum", () => {
    const r = rig({ stubArc: true, maxInner: 0.5 });
    r.h.axiSeal(r.doc, { ...okSeal, burst: { depth: 0.01 } });
    expect(r.stars[0]!.innerRadius).toBeCloseTo(0.4995, 9);
    expect(r.stars[0]!.points).toBe(24); // default points
  });

  it("draws no burst and no ring unless asked, and then the text sits at r - size", () => {
    const r = rig({ stubArc: true });
    const res = r.h.axiSeal(r.doc, { ...okSeal, top: "ONE", bottom: "TWO", size: 30, name: "s" });
    expect(r.stars).toEqual([]);
    expect(r.ellipses).toEqual([]);
    expect(res.nodes.burst).toBeNull();
    expect(res.nodes.ring).toBeNull();
    expect(res.nodes.ringInner).toBeNull();
    expect(res.textR).toBe(270);
    expect(r.arcs.map((a) => a.side)).toEqual(["top", "bottom"]);
  });

  it("false for burst and ring is the same as leaving them out; true takes the defaults", () => {
    const off = rig({ stubArc: true });
    off.h.axiSeal(off.doc, { ...okSeal, top: "X", burst: false, ring: false });
    expect(off.stars).toEqual([]);
    expect(off.ellipses).toEqual([]);
    const on = rig({ stubArc: true });
    const res = on.h.axiSeal(on.doc, { ...okSeal, top: "X", colour: "#112233", burst: true, ring: true, name: "s" });
    expect(on.stars[0]!.points).toBe(24);
    expect(on.stars[0]!.innerRadius).toBeCloseTo(0.88, 9);
    expect(on.added[0]!.def.fill).toBe("rgb:#112233"); // burst colour defaults to the text colour
    expect(on.ellipses).toHaveLength(1); // ring true: a stroked inner circle in the text colour, no disc
    expect(on.ellipses[0]).toMatchObject({ stroke: "#112233", strokeWidth: 3 });
    expect(res.nodes.ring).toBeNull();
    expect(res.nodes.ringInner.userDescription).toBe("s-ring-inner");
  });

  it("defaults size to 0.13 r and leaves nodes unnamed without a name", () => {
    const r = rig({ stubArc: true });
    r.h.axiSeal(r.doc, { ...okSeal, top: "X" });
    expect(r.arcs[0]!.size).toBe(39);
    expect(r.arcs[0]!.name).toBeUndefined();
  });

  it("stacks centre lines on the centre: baselines 1.15 x each following size apart, centre aligned, shrunk to fit", () => {
    const r = rig({ stubArc: true });
    r.h.axiSeal(r.doc, full);
    const [a, b] = r.texts;
    const blockH = 0.72 * 150 + 1.15 * 40;
    expect(a).toMatchObject({ x: 540, text: "-20%", font: "Helvetica-Bold", size: 150, colour: "#1F2A44", align: "c", name: "seal-centre-0" });
    expect(a.y).toBeCloseTo(540 - blockH / 2 + 0.72 * 150, 9);
    expect(b).toMatchObject({ x: 540, text: "studio hours", size: 40, align: "c", name: "seal-centre-1" });
    expect(b.y - a.y).toBeCloseTo(1.15 * 40, 9);
    for (const t of [a, b]) {
      expect(t.maxW).toBeGreaterThan(0);
      expect(t.maxW).toBeLessThan(600); // narrower than the seal itself
    }
    // The chord is narrower for the line that reaches further from the centre.
    const innerR = 300 - 30 - 24 - 40 - 0.25 * 40;
    const reachA = Math.max(Math.abs(a.y - 0.72 * 150 - 540), Math.abs(a.y + 0.2 * 150 - 540));
    expect(a.maxW).toBeCloseTo(2 * Math.sqrt(innerR * innerR - reachA * reachA), 6);
  });

  it("accepts a plain string and a single object for centre, and no centre at all", () => {
    const one = rig({ stubArc: true });
    one.h.axiSeal(one.doc, { ...okSeal, centre: "SALE" });
    expect(one.texts).toHaveLength(1);
    expect(one.texts[0]!.size).toBe(39);
    expect(one.texts[0]!.y).toBeCloseTo(540 - (0.72 * 39) / 2 + 0.72 * 39, 9);
    const obj = rig({ stubArc: true });
    obj.h.axiSeal(obj.doc, { ...okSeal, centre: { text: "50%", size: 100, colour: "#FF0000" } });
    expect(obj.texts[0]).toMatchObject({ text: "50%", size: 100, colour: "#FF0000", font: "Helvetica-Bold" });
    const none = rig({ stubArc: true });
    const res = none.h.axiSeal(none.doc, { ...okSeal, top: "X" });
    expect(none.texts).toEqual([]);
    expect(res.nodes.centre).toEqual([]);
  });

  it("renders bottom as a straight centred line under the centre text when axiArcText reports P3.3", () => {
    const r = rig({ stubArc: true, noBottom: true });
    const res = r.h.axiSeal(r.doc, { ...full, name: "seal" });
    expect(r.arcs.map((a) => a.side)).toEqual(["top"]);
    expect(r.texts).toHaveLength(3);
    const line = r.texts[2]!;
    const blockH = 0.72 * 150 + 1.15 * 40;
    expect(line).toMatchObject({ x: 540, text: "EST. 2026", font: "Helvetica-Bold", size: 40, align: "c", name: "seal-bottom" });
    expect(line.y).toBeCloseTo(540 + blockH / 2 + 1.15 * 40, 9);
    expect(res.nodes.bottom.userDescription).toBe("seal-bottom");
  });

  it("rethrows any other error from the bottom text", () => {
    const r = rig({ stubArc: true, otherError: true });
    expect(() => r.h.axiSeal(r.doc, full)).toThrow("boom");
  });

  it("returns r, the text radius, the free radius and the node map", () => {
    const r = rig({ stubArc: true });
    const res = r.h.axiSeal(r.doc, full);
    expect(res.r).toBe(300);
    expect(res.innerR).toBeCloseTo(res.textR - 10, 9);
    expect(Object.keys(res.nodes).sort()).toEqual(["bottom", "burst", "centre", "ring", "ringInner", "top"]);
  });
});
