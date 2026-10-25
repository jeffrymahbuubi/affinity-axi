// The image, grade, artboard and text-fit helpers: parameter validation, the
// grade step builder, the fit-text search (against a fake paragraph) and the
// name option. The helper source is evaluated in plain Node: validation runs
// before any SDK call, and SDK-touching parts are stubbed.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

/** Evaluates the helper block; `extra` is code appended in the same scope (to stub declarations). */
function load(extra = ""): Record<string, Fn> {
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${extra}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)(() => {
    throw new Error("SDK not available in tests");
  }) as Record<string, Fn>;
}

const h = load();
const noDoc = { artboards: [] };

describe("axiFitText parameter validation", () => {
  const ok = { x: 0, y: 0, w: 100, h: 100, text: "hi", font: "Fraunces-SemiBold", size: 40 };
  const bad: Array<[string, Record<string, unknown>, RegExp]> = [
    ["no text", { text: "" }, /text is required/],
    ["non-string text", { text: 5 }, /text is required/],
    ["no font", { font: undefined }, /font .* is required/],
    ["zero width", { w: 0 }, /w and h must be positive/],
    ["negative height", { h: -1 }, /w and h must be positive/],
    ["no x", { x: undefined }, /x and y are required/],
    ["zero size", { size: 0 }, /size must be positive/],
    ["minSize above size", { minSize: 41 }, /minSize must be in \(0, size\]/],
    ["zero minSize", { minSize: 0 }, /minSize must be in \(0, size\]/],
    ["fractional maxLines", { maxLines: 1.5 }, /maxLines must be a whole number/],
    ["zero maxLines", { maxLines: 0 }, /maxLines must be a whole number/],
    ["leading too small", { leading: 0.5 }, /leading must be 0.8..3/],
    ["leading too big", { leading: 4 }, /leading must be 0.8..3/],
  ];
  for (const [label, patch, re] of bad) {
    it(`rejects ${label} before touching the document`, () => {
      expect(() => h.axiFitText(noDoc, { ...ok, ...patch })).toThrow(re);
    });
  }
  it("rejects a missing options object", () => {
    expect(() => h.axiFitText(noDoc)).toThrow(/text is required/);
  });
});

describe("axiFitText search", () => {
  /**
   * A paragraph whose ink box follows a simple model: 0.5 em per character, wrapping at w,
   * line height size*lead, last line 0.85 em. The real measure is checked live.
   */
  const fake = load(`
    var made = [];
    axiParagraph = function (doc, o) {
      const per = Math.max(1, Math.floor(o.w / (o.size * 0.5)));
      const lines = Math.ceil(o.text.length / per);
      const node = { o: o, userDescription: '', getExactSpreadVisibleBox: function () {
        return { x: o.x, y: o.y, width: Math.min(o.w, o.text.length * o.size * 0.5), height: (lines - 1) * o.size * o.lead + 0.85 * o.size };
      } };
      made.push(node);
      return node;
    };
    axiFitText.made = made;
  `);
  const doc = { deleteSelection() {} };
  const text = "x".repeat(60);
  const base = { x: 0, y: 0, w: 300, h: 200, text, font: "F" };

  it("keeps the requested size when it already fits", () => {
    const r = fake.axiFitText(doc, { ...base, size: 20 });
    expect(r).toMatchObject({ size: 20, overflow: false });
    expect(r.lines).toBe(Math.ceil(60 / 30));
  });

  it("shrinks in 0.5 steps to the largest size that fits and reports lines", () => {
    const r = fake.axiFitText(doc, { ...base, size: 80, minSize: 8 });
    expect(r.overflow).toBe(false);
    expect(r.size).toBeLessThan(80);
    expect(r.size * 2).toBe(Math.round(r.size * 2));
    const fits = (s: number) => {
      const per = Math.floor(300 / (s * 0.5));
      return (Math.ceil(60 / per) - 1) * s * 1.2 + 0.85 * s <= 200.5;
    };
    expect(fits(r.size)).toBe(true);
    expect(fits(r.size + 0.5)).toBe(false);
  });

  it("honours maxLines", () => {
    const r = fake.axiFitText(doc, { ...base, size: 20, maxLines: 1, minSize: 5 });
    expect(r.lines).toBe(1);
    expect(r.overflow).toBe(false);
    expect(r.size).toBeLessThanOrEqual(10);
  });

  it("flags overflow and falls back to minSize when nothing fits", () => {
    const r = fake.axiFitText(doc, { ...base, size: 80, minSize: 60 });
    expect(r).toMatchObject({ size: 60, overflow: true });
  });

  it("sets the name on the placed node only, not on the measuring passes", () => {
    const r = fake.axiFitText(doc, { ...base, size: 80, minSize: 8, name: "headline" });
    expect(r.node.o.name).toBe("headline");
    expect(r.node.o.h).toBe(200);
  });
});

describe("axiGrade spec and looks", () => {
  const steps = (spec: unknown) => h.axiGradeSteps(spec) as Array<[string, Record<string, any>]>;

  it("orders steps and maps the documented keys to SDK parameters", () => {
    const s = steps({ vibrance: 0.2, whiteBalance: { temp: 0.1, tint: -0.1 }, exposure: 0.5, levels: { black: 0.1, gamma: 1.2 } });
    expect(s.map((x) => x[0])).toEqual(["exposure", "whiteBalance", "levels", "vibrance"]);
    expect(s[1]![1]).toEqual({ whiteBalance: 0.1, tint: -0.1 });
    expect(s[2]![1]).toEqual({ blackLevel: 0.1, whiteLevel: 1, gamma: 1.2, outputBlackLevel: 0, outputWhiteLevel: 1 });
    expect(s[3]![1]).toEqual({ vibrance: 0.2, saturation: 0 });
  });

  it("converts degrees to radians for hsl and split toning", () => {
    const s = steps({ hsl: { hue: 90, saturation: 0.1 }, splitToning: { shadowsHue: 180, highlightsHue: 360 } });
    expect(s[0]![1]!.hueShift).toBeCloseTo(Math.PI / 2);
    expect(s[1]![1]!.shadowsHue).toBeCloseTo(Math.PI);
    expect(s[1]![1]!.highlightsHue).toBeCloseTo(2 * Math.PI);
    expect(s[1]![1]!.balance).toBe(0.5);
  });

  it("accepts curves as a master point list or per-channel lists", () => {
    expect(steps({ curves: [[0, 0], [1, 1]] })[0]![1]).toEqual({ master: [[0, 0], [1, 1]] });
    expect(Object.keys(steps({ curves: { r: [[0, 0], [1, 0.5]], b: [[0, 0], [1, 1]] } })[0]![1])).toEqual(["r", "b"]);
  });

  it("rejects unknown keys and out-of-range values naming the key", () => {
    expect(() => steps({ sepia: 1 })).toThrow(/unknown key sepia; known: .*whiteBalance/);
    expect(() => steps({ exposure: 99 })).toThrow(/exposure must be a number in -20..20/);
    expect(() => steps({ whiteBalance: { temp: 2 } })).toThrow(/whiteBalance.temp/);
    expect(() => steps({ levels: { gamma: 3 } })).toThrow(/levels.gamma/);
    expect(() => steps({ vibrance: "lots" })).toThrow(/vibrance/);
    expect(() => steps({ curves: [[0, 0]] })).toThrow(/at least two/);
    expect(() => steps({ curves: [[0, 0], [2, 1]] })).toThrow(/curves.master x/);
  });

  it("looks are valid grade specs; neutral is gentle and carries no white balance", () => {
    expect(() => steps(h.axiLook("warm-soft"))).not.toThrow();
    expect(() => steps(h.axiLook("neutral"))).not.toThrow();
    expect(h.axiLook("warm-soft").whiteBalance.temp).toBeGreaterThan(0);
    expect(Object.keys(h.axiLook("neutral")).sort()).toEqual(["levels", "vibrance"]);
    expect(h.axiLook("warm-soft")).not.toBe(h.axiLook("warm-soft"));
    expect(() => h.axiLook("vintage")).toThrow(/unknown look vintage; known: warm-soft, neutral/);
  });

  it("axiGrade validates before it needs a node, and takes a look name", () => {
    expect(() => h.axiGrade({}, null, { nope: 1 })).toThrow(/unknown key nope/);
    expect(() => h.axiGrade({}, null, "vintage")).toThrow(/unknown look/);
    expect(() => h.axiGrade({ selection: { nodes: {} } }, null, "neutral")).toThrow(/nothing selected/);
  });
});

describe("axiImage and artboard validation", () => {
  it("rejects a bad fit and boxes that fit/radius/frame cannot use", () => {
    expect(() => h.axiImage({}, { path: "p", fit: "zoom" })).toThrow(/fit must be contain, cover or stretch/);
    expect(() => h.axiImage({}, { path: "p", fit: "cover", w: 100 })).toThrow(/need both w and h/);
    expect(() => h.axiImage({}, { path: "p", radius: 10, w: 100 })).toThrow(/need both w and h/);
    expect(() => h.axiImage({}, { path: "p", frame: true })).toThrow(/need both w and h/);
    expect(() => h.axiImage({}, { path: "p", fit: "stretch", h: 100 })).toThrow(/need both w and h/);
  });

  it("axiArtboard needs a name and a size, and the first artboard must sit at 0,0", () => {
    expect(() => h.axiArtboard(noDoc, { w: 1, h: 1 })).toThrow(/name is required/);
    expect(() => h.axiArtboard(noDoc, { name: "a", w: 0, h: 1 })).toThrow(/w and h must be positive/);
    expect(() => h.axiArtboard(noDoc, { name: "a", x: 100, w: 10, h: 10 })).toThrow(/first artboard .* at 0,0/);
    expect(() => h.axiArtboard({ artboards: [{ description: "a" }] }, { name: "a", w: 10, h: 10 })).toThrow(/already exists/);
  });

  it("axiArtboards needs specs, and a platform spec resolves its size from the table", () => {
    expect(() => h.axiArtboards(noDoc, [])).toThrow(/non-empty array/);
    expect(() => h.axiArtboards(noDoc, [{ platform: "no-such-platform" }])).toThrow(/unknown key no-such-platform/);
  });

  it("axiOn and axiSafeZone name what is missing", () => {
    const doc = { artboards: [{ description: "story" }] };
    expect(() => h.axiOn(doc, "og")).toThrow(/no artboard named og; present: story/);
    expect(() => h.axiOn({ artboards: [] }, "og")).toThrow(/present: none/);
    expect(() => h.axiSafeZone(doc, "story", "no-such-platform")).toThrow(/unknown key no-such-platform/);
  });

  it("axiSafeZone returns no guides for a platform without a safe area", () => {
    const doc = {
      artboards: [{ description: "og", spreadBaseBox: { x: 0, y: 0, width: 1200, height: 630 }, node: {} }],
      selection: null as unknown,
      addGuide() {
        throw new Error("must not add guides");
      },
    };
    expect(h.axiSafeZone(doc, "og", "og")).toEqual([]);
  });

  it("axiSafeZone places the Stories guides at 250 px from the top and 340 px from the bottom, offset by the artboard origin", () => {
    const added: Array<[boolean, number]> = [];
    const doc = {
      artboards: [{ description: "story", spreadBaseBox: { x: 1180, y: 0, width: 1080, height: 1920 }, node: {} }],
      selection: null as unknown,
      addGuide(horizontal: boolean, pos: number) {
        added.push([horizontal, pos]);
      },
    };
    expect(h.axiSafeZone(doc, "story", "story")).toEqual([
      { horizontal: true, pos: 250 },
      { horizontal: true, pos: 1580 },
    ]);
    expect(added).toEqual([[true, 250], [true, 1580]]);
    const ig = { ...doc, artboards: [{ description: "ig", spreadBaseBox: { x: 500, y: 40, width: 1080, height: 1350 }, node: {} }] };
    const guides = h.axiSafeZone(ig, "ig", "ig-portrait") as Array<{ horizontal: boolean; pos: number }>;
    expect(guides).toEqual([{ horizontal: false, pos: 534 }, { horizontal: false, pos: 1546 }]);
  });
});

describe("name option", () => {
  it("is documented in the index of every helper that creates a node or artboard", () => {
    for (const n of ["axiText", "axiParagraph", "axiRect", "axiEllipse", "axiImage", "axiFitText", "axiArtboard"]) {
      const row = HELPER_INDEX.find((r) => r.name === n)!;
      expect(`${row.signature} ${row.summary}`).toMatch(/\bname\b/);
    }
  });

  it("sets userDescription from name in the source of each of them", () => {
    expect(HELPERS_SOURCE).toMatch(/function axiName\(node, name\) \{\n  if \(name !== undefined && name !== null && node\) \{ node\.userDescription = String\(name\); \}/);
    for (const fn of ["axiText", "axiParagraph", "axiRect", "axiEllipse"]) {
      const body = HELPERS_SOURCE.slice(HELPERS_SOURCE.indexOf(`function ${fn}(`)).split(/\n}\n/)[0]!;
      expect(body).toContain("axiName(doc.selection.nodes.first, o.name)");
    }
    const image = HELPERS_SOURCE.slice(HELPERS_SOURCE.indexOf("function axiImage(")).split(/\n}\n/)[0]!;
    expect(image).toContain("axiName(img, o.name)");
    expect(image).toContain("o.name + '-frame'");
    const board = HELPERS_SOURCE.slice(HELPERS_SOURCE.indexOf("function axiArtboard(")).split(/\n}\n/)[0]!;
    expect(board).toContain("ab.node.userDescription = o.name");
  });

  it("axiName sets userDescription only when a name is given", () => {
    const node: { userDescription: string } = { userDescription: "keep" };
    expect(h.axiName(node)).toBe(node);
    expect(node.userDescription).toBe("keep");
    h.axiName(node, "hero-photo");
    expect(node.userDescription).toBe("hero-photo");
    expect(h.axiName(null, "x")).toBeNull();
  });

  it("axiText, axiRect and axiEllipse pass the name through a stubbed SDK", () => {
    const made = { userDescription: "" };
    const doc = { selection: { nodes: { first: made } }, addNode() {} };
    const req = (m: string) => {
      if (m === "/shapes.js") return { ShapeRectangle: { create: () => ({}) }, ShapeEllipse: { create: () => ({}) }, ShapeCornerType: {} };
      if (m === "/nodes.js") return { ShapeNodeDefinition: { create: () => ({}) }, ArtTextNodeDefinition: { createFromStoryBuilder: () => ({}) } };
      throw new Error("no " + m);
    };
    const run = (fn: string, o: object) => {
      const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((x) => x[1]!);
      const src = `${HELPERS_SOURCE}\naxiSurface = function () {}; axiStroke = function () { return [null, null]; }; axiStyled = function () { return { addText: function () {} }; }; axiMeasure = function () { return { x: 0, y: 0, w: 10, h: 10 }; };\nreturn { ${names.join(", ")} };`;
      return (new Function("require", src)(req) as Record<string, Fn>)[fn]!(doc, o);
    };
    expect(run("axiRect", { x: 0, y: 0, w: 10, h: 10, name: "cta" })).toBe(made);
    expect(made.userDescription).toBe("cta");
    made.userDescription = "";
    run("axiEllipse", { x: 0, y: 0, w: 10, h: 10, name: "dot" });
    expect(made.userDescription).toBe("dot");
    made.userDescription = "";
    run("axiText", { x: 0, y: 0, text: "t", font: "F", size: 10, name: "headline" });
    expect(made.userDescription).toBe("headline");
    made.userDescription = "untouched";
    run("axiRect", { x: 0, y: 0, w: 10, h: 10 });
    expect(made.userDescription).toBe("untouched");
  });
});

describe("fillAlpha is a 0..1 fraction", () => {
  const record = (fn: string, o: object): number => {
    let alpha = -1;
    const made = { userDescription: "" };
    const doc = { selection: { nodes: { first: made } }, addNode() {} };
    const req = (m: string) => {
      if (m === "/colours.js") return { RGBA8: (_r: number, _g: number, _b: number, a: number) => { alpha = a; return {}; } };
      if (m === "/shapes.js") return { ShapeRectangle: { create: () => ({}) }, ShapeEllipse: { create: () => ({}) }, ShapeCornerType: {} };
      if (m === "/nodes.js") return { ShapeNodeDefinition: { create: () => ({}) } };
      throw new Error("no " + m);
    };
    const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((x) => x[1]!);
    const src = `${HELPERS_SOURCE}\naxiSurface = function () {}; axiStroke = function () { return [null, null]; };\nreturn { ${names.join(", ")} };`;
    (new Function("require", src)(req) as Record<string, Fn>)[fn]!(doc, { x: 0, y: 0, w: 10, h: 10, fill: "#1F2A44", ...o });
    return alpha;
  };

  it("maps a fraction to a byte and keeps byte values working", () => {
    expect(record("axiRect", { fillAlpha: 0.4 })).toBe(102);
    expect(record("axiRect", {})).toBe(255);
    expect(record("axiRect", { fillAlpha: 1 })).toBe(255);
    expect(record("axiRect", { fillAlpha: 0 })).toBe(0);
    expect(record("axiRect", { fillAlpha: 70 })).toBe(70);
    expect(record("axiRect", { fillAlpha: 255 })).toBe(255);
    expect(record("axiEllipse", { fillAlpha: 0.5 })).toBe(128);
  });

  it("throws on values outside 0..255 and on non-numbers", () => {
    for (const bad of [-1, 300, "x", Number.NaN]) {
      expect(() => record("axiRect", { fillAlpha: bad }), String(bad)).toThrow(/alpha must be 0\.\.1/);
    }
  });

  it("no longer passes a byte-valued fillAlpha in the layout source, and documents 0-1", () => {
    expect(HELPERS_SOURCE).not.toMatch(/fillAlpha: 70/);
    for (const n of ["axiRect", "axiEllipse"]) {
      const row = HELPER_INDEX.find((r) => r.name === n)!;
      expect(row.summary).toContain("0-1");
    }
  });
});

describe("source layout", () => {
  it("keeps every helper module under 500 lines", () => {
    for (const f of ["helpers", "helpers-core", "helpers-image", "helpers-layout", "platforms"]) {
      const lines = readFileSync(new URL(`../src/affinity/${f}.ts`, import.meta.url), "utf8").split("\n").length;
      expect(lines, f).toBeLessThan(500);
    }
  });

  it("has no console.log outside script strings in src/affinity/helpers*.ts", () => {
    for (const f of ["helpers", "helpers-core", "helpers-image", "helpers-layout"]) {
      const src = readFileSync(new URL(`../src/affinity/${f}.ts`, import.meta.url), "utf8");
      // helpers define no logging at all: scripts print through the user's own console.log
      expect(src).not.toContain("console.log");
    }
  });
});
