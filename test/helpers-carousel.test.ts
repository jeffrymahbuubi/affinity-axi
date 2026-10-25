// Carousel helpers: source hygiene, validation before any SDK call, board naming,
// number and cue placement against stubbed drawing helpers, and the panorama
// split against a stubbed axiClone (the real one lives in helpers-variants.ts).
// The live behaviour is checked by running examples/helpers-carousel/script.js.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { CAROUSEL_INDEX, CAROUSEL_INTERNAL, CAROUSEL_SOURCE } from "../src/affinity/helpers-carousel.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

const CLONE_STUB = "function axiClone(doc, node, target, xf) { throw new Error('axiClone stub'); }\n";

/** Evaluates the helper block plus the carousel block; `extra` is appended in the same scope to stub declarations. */
function load(extra = "", sdk: Record<string, unknown> = {}): Record<string, any> {
  // Splice-safe: add the carousel block and the axiClone stub only when HELPERS_SOURCE lacks them.
  const spliced = HELPERS_SOURCE.includes("function axiCarousel(");
  const src = HELPERS_SOURCE + (HELPERS_SOURCE.includes("function axiClone(") ? "" : CLONE_STUB) + (spliced ? "" : CAROUSEL_SOURCE);
  const names = [...src.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${src}\n${extra}\nreturn { ${names.join(", ")}, S: typeof S === 'undefined' ? undefined : S };`;
  return new Function("require", body)((p: string) => {
    if (p in sdk) return sdk[p];
    throw new Error("SDK not available in tests: " + p);
  }) as Record<string, any>;
}

const bare = load();
const noDoc = { artboards: [] };

describe("CAROUSEL_SOURCE", () => {
  const declared = [...CAROUSEL_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(CAROUSEL_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + CAROUSEL_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and never closes a document", () => {
    expect(scanForBlocking(CAROUSEL_SOURCE)).toEqual([]);
    expect(scanForAi(CAROUSEL_SOURCE)).toEqual([]);
    expect(CAROUSEL_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(CAROUSEL_SOURCE).not.toContain("`");
    expect(CAROUSEL_SOURCE).not.toContain("${");
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = CAROUSEL_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
  });

  it("keeps every require() inside a function", () => {
    for (const line of CAROUSEL_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });

  it("declares every indexed helper, everything else is listed as internal, and no name is repeated", () => {
    for (const h of CAROUSEL_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !CAROUSEL_INDEX.some((h) => h.name === n)).sort()).toEqual([...CAROUSEL_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("draws the cue from shapes only, with no font or glyph", () => {
    const decor = CAROUSEL_SOURCE.slice(CAROUSEL_SOURCE.indexOf("function axiCarouselDecor"), CAROUSEL_SOURCE.indexOf("function axiCarousel(doc"));
    const cue = decor.slice(decor.indexOf("if (cu && i <"));
    expect(cue).not.toMatch(/axiText|axiParagraph|font/);
    expect(cue).toContain("axiEllipse");
    expect(cue).toContain("axiRect");
  });
});

describe("axiCarousel validation (before any SDK call)", () => {
  const ok = { platform: "ig-portrait", count: 5 };
  const bad: Array<[string, any, RegExp]> = [
    ["no options", undefined, /options are required/],
    ["count missing", { platform: "ig-portrait" }, /count must be a whole number from 2 to 20/],
    ["count 1", { ...ok, count: 1 }, /count must be/],
    ["count 21", { ...ok, count: 21 }, /count must be/],
    ["fractional count", { ...ok, count: 2.5 }, /count must be/],
    ["string count", { ...ok, count: "5" }, /count must be/],
    ["empty prefix", { ...ok, prefix: "" }, /prefix must be a non-empty string/],
    ["negative gap", { ...ok, gap: -1 }, /gap must be 0 or more/],
    ["bad fill", { ...ok, fill: "blue" }, /fill must be a hex colour/],
    ["no size", { count: 3 }, /give a platform key or w and h/],
    ["unknown platform", { platform: "nope", count: 3 }, /nope/],
    ["number.pos", { ...ok, number: { pos: "middle" } }, /number\.pos must be tl, tr, bl or br/],
    ["number.size", { ...ok, number: { size: 0 } }, /number\.size must be positive/],
    ["number.pad", { ...ok, number: { pad: -5 } }, /number\.pad must be 0 or more/],
    ["number.colour", { ...ok, number: { colour: "red" } }, /number\.colour must be a hex colour/],
    ["number type", { ...ok, number: "yes" }, /number must be true or an options object/],
    ["cue.size", { ...ok, cue: { size: -1 } }, /cue\.size must be positive/],
    ["cue.colour", { ...ok, cue: { glyph: "white" } }, /cue\.colour and cue\.glyph must be hex colours/],
  ];
  for (const [label, o, re] of bad) {
    it(`rejects ${label} before touching the document`, () => {
      expect(() => bare.axiCarousel(noDoc, o)).toThrow(re);
    });
  }
});

describe("axiCarousel boards", () => {
  const fake = load(`
    const S = { specs: null, opts: null, decor: [] };
    axiArtboards = function (doc, specs, opts) {
      S.specs = specs; S.opts = opts;
      return specs.map(function (s, i) { return { name: s.name, x: i * (s.w + 100), y: 0, w: s.w, h: s.h }; });
    };
    axiCarouselDecor = function (doc, boards, number, cue) { S.decor.push({ n: boards.length, number: number, cue: cue }); return []; };
  `);

  it("names boards <prefix>-01 ... with two-digit padding, and sizes them from the platform", () => {
    const r = fake.axiCarousel({}, { platform: "ig-portrait", count: 12, fill: "#F2F5F9" });
    expect(r).toHaveLength(12);
    expect(r.map((b: any) => b.name).slice(0, 3)).toEqual(["slide-01", "slide-02", "slide-03"]);
    expect(r[8].name).toBe("slide-09");
    expect(r[9].name).toBe("slide-10");
    expect(r[11].name).toBe("slide-12");
    expect(r.map((b: any) => b.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(fake.S.specs[0]).toEqual({ name: "slide-01", w: 1080, h: 1350, fill: "#F2F5F9" });
    expect(r[1]).toMatchObject({ x: 1180, y: 0, w: 1080, h: 1350 });
  });

  it("accepts the bounds 2 and 20, a custom prefix, explicit w,h and a gap", () => {
    expect(fake.axiCarousel({}, { w: 500, h: 400, count: 2, prefix: "tip", gap: 40 }).map((b: any) => b.name)).toEqual(["tip-01", "tip-02"]);
    expect(fake.S.opts).toEqual({ gap: 40 });
    expect(fake.axiCarousel({}, { platform: "ig-square", count: 20 })).toHaveLength(20);
  });

  it("validates the decor options first (dry run), then draws them once on the real boards", () => {
    fake.S.decor.length = 0;
    fake.axiCarousel({}, { platform: "ig-square", count: 3, number: true, cue: { colour: "#4C8DFF" } });
    expect(fake.S.decor.map((d: any) => d.n)).toEqual([0, 3]);
    expect(fake.S.decor[1].number).toBe(true);
    expect(fake.S.decor[1].cue).toEqual({ colour: "#4C8DFF" });
  });
});

describe("axiCarouselDecor placement", () => {
  /** A tiny scene: drawing helpers record calls; the last rect or ellipse is the selection and keeps a box. */
  const scene = () => {
    const sdk = { "/geometry.js": { Transform: { createRotate: (r: number) => ({ rot: r }), createTranslate: (x: number, y: number) => ({ dx: x, dy: y }) } } };
    const h = load(
      `
      const S = { on: [], texts: [], ellipses: [], rects: [], rotations: [], moves: [], sel: null };
      axiOn = function (doc, name) { S.on.push(name); };
      axiText = function (doc, o) { S.texts.push(o); return {}; };
      axiEllipse = function (doc, o) { S.ellipses.push(o); S.sel = { x: o.x, y: o.y, w: o.w, h: o.h }; return {}; };
      axiRect = function (doc, o) { S.rects.push(o); S.sel = { x: o.x, y: o.y, w: o.w, h: o.h }; return {}; };
      axiMeasure = function () { return { x: S.sel.x, y: S.sel.y, w: S.sel.w, h: S.sel.h }; };
      axiMove = function (doc, dx, dy) { S.moves.push([dx, dy]); S.sel = { x: S.sel.x + dx, y: S.sel.y + dy, w: S.sel.w, h: S.sel.h }; };
    `,
      sdk,
    );
    const doc = { applyTransform: (t: any) => h.S.rotations.push(t.rot) };
    return { h, doc };
  };
  const boards = [
    { name: "slide-01", x: 0, y: 0, w: 1080, h: 1350 },
    { name: "slide-02", x: 1180, y: 0, w: 1080, h: 1350 },
    { name: "slide-03", x: 2360, y: 0, w: 1080, h: 1350 },
  ];

  const corner = (pos: string) => {
    const { h, doc } = scene();
    h.axiCarouselDecor(doc, boards, { font: "Helvetica", size: 40, colour: "#1F2A44", pos, pad: 50 }, false);
    return h.S.texts as Array<Record<string, any>>;
  };

  it("writes i/N on every slide, named after the slide", () => {
    const t = corner("tr");
    expect(t.map((x) => x.text)).toEqual(["1/3", "2/3", "3/3"]);
    expect(t.map((x) => x.name)).toEqual(["slide-01-number", "slide-02-number", "slide-03-number"]);
    expect(t[0]).toMatchObject({ font: "Helvetica", size: 40, colour: "#1F2A44" });
  });

  it("anchors the number in each corner with the padding, in spread coordinates", () => {
    const base = 0.72 * 40;
    expect(corner("tl")[1]).toMatchObject({ x: 1180 + 50, y: 50 + base, align: "l" });
    expect(corner("tr")[1]).toMatchObject({ x: 1180 + 1080 - 50, y: 50 + base, align: "r" });
    expect(corner("bl")[1]).toMatchObject({ x: 1180 + 50, y: 1350 - 50, align: "l" });
    expect(corner("br")[1]).toMatchObject({ x: 1180 + 1080 - 50, y: 1350 - 50, align: "r" });
  });

  it("uses the documented defaults for number: true (tr, pad 48, size 36)", () => {
    const { h, doc } = scene();
    h.axiCarouselDecor(doc, boards, true, false);
    expect(h.S.texts[0]).toMatchObject({ x: 1080 - 48, y: 48 + 36 * 0.72, size: 36, align: "r", font: "Helvetica" });
  });

  it("selects each board before drawing on it", () => {
    const { h, doc } = scene();
    h.axiCarouselDecor(doc, boards, { pos: "tr" }, { colour: "#4C8DFF" });
    expect(h.S.on[0]).toBe("slide-01");
    expect(new Set(h.S.on)).toEqual(new Set(["slide-01", "slide-02", "slide-03"]));
  });

  it("draws the cue on every slide but the last, as a pill and two arms with no text", () => {
    const { h, doc } = scene();
    h.axiCarouselDecor(doc, boards, false, { colour: "#4C8DFF", glyph: "#FFFFFF", size: 100, pad: 20 });
    expect(h.S.texts).toEqual([]);
    expect(h.S.ellipses.map((e: any) => e.name)).toEqual(["slide-01-cue", "slide-02-cue"]);
    expect(h.S.rects.map((r: any) => r.name)).toEqual(["slide-01-cue-arm-1", "slide-01-cue-arm-2", "slide-02-cue-arm-1", "slide-02-cue-arm-2"]);
    // pill: diameter 100, 20 px from the right edge, vertically centred
    expect(h.S.ellipses[0]).toMatchObject({ x: 1080 - 20 - 100, y: 675 - 50, w: 100, h: 100, fill: "#4C8DFF" });
    expect(h.S.ellipses[1]).toMatchObject({ x: 1180 + 1080 - 20 - 100 });
    expect(h.S.rects[0]).toMatchObject({ fill: "#FFFFFF" });
    expect(h.S.ellipses.some((e: any) => e.name.startsWith("slide-03"))).toBe(false);
    expect(h.S.rects.some((r: any) => r.name.startsWith("slide-03"))).toBe(false);
  });

  it("rotates the arms +45 and -45 degrees and centres them around the pill centre", () => {
    const { h, doc } = scene();
    h.axiCarouselDecor(doc, boards, false, { size: 100, pad: 20 });
    expect(h.S.rotations.slice(0, 2)).toEqual([Math.PI / 4, -Math.PI / 4]);
    const cx = 1080 - 20 - 50;
    const cy = 675;
    const arm = (100 * 0.34) / Math.SQRT2;
    // the fake rotation keeps the box, so each move is the offset from the rect centre to the target
    const r0 = h.S.rects[0];
    const [dx0, dy0] = h.S.moves[0];
    expect(r0.x + r0.w / 2 + dx0).toBeCloseTo(cx);
    expect(r0.y + r0.h / 2 + dy0).toBeCloseTo(cy - arm / 2);
    const r1 = h.S.rects[1];
    const [dx1, dy1] = h.S.moves[1];
    expect(r1.x + r1.w / 2 + dx1).toBeCloseTo(cx);
    expect(r1.y + r1.h / 2 + dy1).toBeCloseTo(cy + arm / 2);
  });

  it("does nothing for no boards or no options, and validates even with no boards", () => {
    const { h, doc } = scene();
    expect(h.axiCarouselDecor(doc, boards, false, false)).toEqual([]);
    expect(h.axiCarouselDecor(doc, [], true, true)).toEqual([]);
    expect(h.S.texts).toEqual([]);
    expect(() => h.axiCarouselDecor(doc, [], { pos: "x" }, false)).toThrow(/number\.pos/);
  });
});

describe("axiCarouselSplit", () => {
  const kid = (name: string) => ({ userDescription: name });
  const master = (extra: any[] = []) => ({ node: { children: [kid("bg"), kid("title"), kid("photo"), ...extra] }, spreadBaseBox: { x: 40, y: 20, width: 3240, height: 1080 } });

  const make = (m: any = master()) => {
    const h = load(
      `
      const S = { clones: [], specs: null, opts: null, found: [], master: null };
      axiFindArtboard = function (doc, name) {
        S.found.push(name);
        if (name === 'pano') { return S.master; }
        return { node: { target: name } };
      };
      axiArtboards = function (doc, specs, opts) {
        S.specs = specs; S.opts = opts;
        return specs.map(function (s, i) { return { name: s.name, x: 3400 + i * (s.w + 100), y: 20, w: s.w, h: s.h }; });
      };
      axiClone = function (doc, node, target, xf) { S.clones.push({ node: node.userDescription, target: target.target, dx: xf.dx, dy: xf.dy }); return {}; };
    `,
      { "/geometry.js": { Transform: { createTranslate: (x: number, y: number) => ({ dx: x, dy: y }) } } },
    );
    h.S.master = m;
    return h;
  };

  it("clones every master child once per slide with the right translations", () => {
    const h = make();
    const r = h.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 3 });
    expect(r.map((b: any) => b.name)).toEqual(["slide-01", "slide-02", "slide-03"]);
    expect(r.map((b: any) => b.index)).toEqual([1, 2, 3]);
    expect(h.S.clones).toHaveLength(3 * 3);
    // board i is at x = 3400 + i*1180; master at x = 40; step is the slide width (no overlap)
    const dx = (i: number) => 3400 + i * 1180 - 40 - i * 1080;
    expect(h.S.clones.slice(0, 3)).toEqual([
      { node: "bg", target: "slide-01", dx: dx(0), dy: 0 },
      { node: "title", target: "slide-01", dx: dx(0), dy: 0 },
      { node: "photo", target: "slide-01", dx: dx(0), dy: 0 },
    ]);
    expect(h.S.clones.filter((c: any) => c.target === "slide-02").every((c: any) => c.dx === dx(1))).toBe(true);
    expect(h.S.clones.filter((c: any) => c.target === "slide-03").every((c: any) => c.dx === dx(2))).toBe(true);
    expect(h.S.specs[0]).toMatchObject({ name: "slide-01", w: 1080, h: 1080 });
  });

  it("shifts by w - overlap and accepts a master exactly slides*w - (slides-1)*overlap wide", () => {
    const h = make({ node: { children: [kid("bg")] }, spreadBaseBox: { x: 0, y: 0, width: 3 * 1000 - 2 * 100, height: 800 } } as any);
    h.axiCarouselSplit({}, "pano", { w: 1000, h: 800, slides: 3, overlap: 100, prefix: "pan", gap: 30, fill: "#FFFFFF" });
    expect(h.S.opts).toEqual({ gap: 30 });
    expect(h.S.specs[2]).toEqual({ name: "pan-03", w: 1000, h: 800, fill: "#FFFFFF" });
    const first = h.S.clones.filter((c: any) => c.target === "pan-01")[0];
    const third = h.S.clones.filter((c: any) => c.target === "pan-03")[0];
    // boards sit at x = 3400 + i*(1000+100): the difference of board x is 2200, minus 2 steps of 900
    expect(third.dx - first.dx).toBe(2 * (1000 + 100) - 2 * (1000 - 100));
  });

  it("applies the vertical offset between board and master", () => {
    const h = make();
    h.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 2 });
    expect(h.S.clones.every((c: any) => c.dy === 0)).toBe(true);
    const h2 = make({ node: { children: [kid("bg")] }, spreadBaseBox: { x: 40, y: -60, width: 2160, height: 1080 } } as any);
    h2.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 2 });
    expect(h2.S.clones.every((c: any) => c.dy === 20 - -60)).toBe(true);
  });

  it("skips the safe-zone overlay bands", () => {
    const h = make(master([kid("axi-safe-zone")]));
    h.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 2 });
    expect(h.S.clones.some((c: any) => c.node === "axi-safe-zone")).toBe(false);
    expect(h.S.clones).toHaveLength(3 * 2);
  });

  it("rejects a master that is too narrow, with the width it needs", () => {
    const h = make();
    expect(() => h.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 4 })).toThrow(/3240 px wide; 4 slides of 1080 px with 0 px overlap need 4320 px/);
    expect(h.S.specs).toBeNull();
    expect(h.S.clones).toEqual([]);
  });

  it("rejects an empty master without adding boards", () => {
    const h = make({ node: { children: [] }, spreadBaseBox: { x: 0, y: 0, width: 3240, height: 1080 } } as any);
    expect(() => h.axiCarouselSplit({}, "pano", { platform: "ig-square", slides: 3 })).toThrow(/has no content to split/);
    expect(h.S.specs).toBeNull();
  });

  const bad: Array<[string, any[], RegExp]> = [
    ["no master", [undefined, { platform: "ig-square", slides: 3 }], /master .* is required/],
    ["no options", ["pano", undefined], /options are required/],
    ["slides 1", ["pano", { platform: "ig-square", slides: 1 }], /slides must be a whole number from 2 to 20/],
    ["slides 21", ["pano", { platform: "ig-square", slides: 21 }], /slides must be/],
    ["fractional slides", ["pano", { platform: "ig-square", slides: 2.5 }], /slides must be/],
    ["empty prefix", ["pano", { platform: "ig-square", slides: 3, prefix: "" }], /prefix must be/],
    ["negative gap", ["pano", { platform: "ig-square", slides: 3, gap: -1 }], /gap must be 0 or more/],
    ["bad fill", ["pano", { platform: "ig-square", slides: 3, fill: "x" }], /fill must be a hex colour/],
    ["no size", ["pano", { slides: 3 }], /give a platform key or w and h/],
    ["negative overlap", ["pano", { platform: "ig-square", slides: 3, overlap: -1 }], /overlap must be 0 or more/],
    ["overlap as wide as the slide", ["pano", { platform: "ig-square", slides: 3, overlap: 1080 }], /overlap must be/],
  ];
  for (const [label, args, re] of bad) {
    it(`rejects ${label} before touching the document`, () => {
      expect(() => bare.axiCarouselSplit(noDoc, ...args)).toThrow(re);
    });
  }

  it("names an unknown master through axiFindArtboard's own message", () => {
    expect(() => bare.axiCarouselSplit(noDoc, "pano", { platform: "ig-square", slides: 3 })).toThrow(/no artboard named pano; present: none/);
  });

  it("is reachable as a plain function, like the helper index says", () => {
    const names = CAROUSEL_INDEX.map((i) => i.name);
    for (const n of names) expect(typeof (bare as Record<string, Fn>)[n]).toBe("function");
  });
});
