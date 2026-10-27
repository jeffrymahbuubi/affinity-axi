// axiLook('airy'), axiLook overrides and the selectiveColour grade key. The helper
// source is evaluated in plain Node: validation runs before any SDK call.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

function load(): Record<string, Fn> {
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)(() => {
    throw new Error("SDK not available in tests");
  }) as Record<string, Fn>;
}

const h = load();
const steps = (spec: unknown) => h.axiGradeSteps(spec) as Array<[string, Record<string, any>]>;

describe("axiLook airy", () => {
  it("carries the Batch 10b values", () => {
    const a = h.axiLook("airy");
    expect(a.exposure).toBe(0.3);
    expect(a.curves).toEqual([[0, 0.04], [0.25, 0.3], [0.5, 0.57], [0.75, 0.81], [1, 0.985]]);
    expect(a.shadowsHighlights).toEqual({ shadows: 0.4, highlights: -0.15 });
    expect(a.whiteBalance).toEqual({ temp: 0.05, tint: 0.03 });
    expect(a.splitToning).toEqual({ highlightsHue: 30, highlightsSat: 0.12, shadowsHue: 340, shadowsSat: 0.06, balance: 0.5 });
    expect(a.vibrance).toBe(0.12);
    expect(a.saturation).toBe(-0.03);
    expect(a.clarity).toEqual({ strength: 0.1 });
  });

  it("is a valid grade spec and returns a fresh object each call", () => {
    expect(() => steps(h.axiLook("airy"))).not.toThrow();
    expect(h.axiLook("airy")).not.toBe(h.axiLook("airy"));
    expect(h.axiLook("airy").curves).not.toBe(h.axiLook("airy").curves);
  });

  it("an unknown look lists airy among the known names", () => {
    expect(() => h.axiLook("vintage")).toThrow(/unknown look vintage; known: warm-soft, neutral, airy/);
  });
});

describe("axiLook overrides", () => {
  it("shallow-merges top-level keys: the exterior variant", () => {
    const e = h.axiLook("airy", { exposure: 0.45, brightnessContrast: { contrast: 0.1 } });
    expect(e.exposure).toBe(0.45);
    expect(e.brightnessContrast).toEqual({ contrast: 0.1 });
    expect(e.vibrance).toBe(0.12);
    expect(() => steps(e)).not.toThrow();
  });

  it("replaces a whole key, does not deep-merge", () => {
    const e = h.axiLook("airy", { shadowsHighlights: { shadows: 0.55 } });
    expect(e.shadowsHighlights).toEqual({ shadows: 0.55 });
  });

  it("does not alias the override values or change the preset", () => {
    const o = { whiteBalance: { temp: 0.2 } };
    const e = h.axiLook("neutral", o);
    expect(e.whiteBalance).toEqual({ temp: 0.2 });
    expect(e.whiteBalance).not.toBe(o.whiteBalance);
    expect(Object.keys(h.axiLook("neutral")).sort()).toEqual(["levels", "vibrance"]);
  });

  it("accepts undefined and null, rejects non-objects", () => {
    expect(h.axiLook("neutral", undefined)).toEqual(h.axiLook("neutral"));
    expect(h.axiLook("neutral", null)).toEqual(h.axiLook("neutral"));
    expect(() => h.axiLook("neutral", "warm")).toThrow(/overrides must be an object/);
    expect(() => h.axiLook("neutral", [1])).toThrow(/overrides must be an object/);
  });

  it("override keys are validated when the spec is graded", () => {
    expect(() => steps(h.axiLook("airy", { sepia: 1 }))).toThrow(/unknown key sepia/);
  });
});

describe("axiGrade selectiveColour", () => {
  it("maps c,m,y,k to the SelectiveColour weights, keyed by range index", () => {
    // fixtures from affinity-axi docs: SelectiveColourAdjustmentParameters.setWeights(colour, {cyanWeight,
    // magentaWeight, yellowWeight, blackWeight}), each -1..1; nine ranges (weightsCount 9), isRelative true
    const s = steps({ selectiveColour: { neutrals: { c: -0.1, y: 0.08 } } });
    expect(s).toEqual([["selectiveColour", { weights: [[7, { cyanWeight: -0.1, magentaWeight: 0, yellowWeight: 0.08, blackWeight: 0 }]] }]]);
  });

  it("indexes the nine range names in order and sorts the weights", () => {
    const names = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"];
    const spec: Record<string, unknown> = {};
    [...names].reverse().forEach((n) => (spec[n] = { k: 0.1 }));
    const w = steps({ selectiveColour: spec })[0]![1]!.weights as Array<[number, any]>;
    expect(w.map((x) => x[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(w[8]![1].blackWeight).toBe(0.1);
  });

  it("runs after hsl and before splitToning", () => {
    const s = steps({ splitToning: { shadowsHue: 10 }, selectiveColour: { reds: { m: 0.1 } }, hsl: { hue: 5 }, vibrance: 0.1, exposure: 0.1 });
    expect(s.map((x) => x[0])).toEqual(["exposure", "vibrance", "hsl", "selectiveColour", "splitToning"]);
  });

  it("rejects an unknown range or channel and out-of-range values naming the key", () => {
    expect(() => steps({ selectiveColour: { oranges: { c: 0.1 } } })).toThrow(/unknown range oranges; known: reds, yellows/);
    expect(() => steps({ selectiveColour: { reds: { x: 0.1 } } })).toThrow(/selectiveColour.reds: unknown channel x/);
    expect(() => steps({ selectiveColour: { reds: { c: 1.5 } } })).toThrow(/selectiveColour.reds.c must be a number in -1..1/);
    expect(() => steps({ selectiveColour: { reds: { y: "warm" } } })).toThrow(/selectiveColour.reds.y/);
    expect(() => steps({ selectiveColour: { reds: 0.2 } })).toThrow(/selectiveColour.reds must be \{c,m,y,k\}/);
    expect(() => steps({ selectiveColour: [1] })).toThrow(/selectiveColour must be an object/);
  });

  it("is listed in the unknown-key hint and the index text", () => {
    expect(() => steps({ sepia: 1 })).toThrow(/known: .*selectiveColour/);
    const grade = HELPER_INDEX.find((r) => r.name === "axiGrade")!;
    const look = HELPER_INDEX.find((r) => r.name === "axiLook")!;
    expect(grade.summary).toMatch(/selectiveColour/);
    expect(look.signature).toBe("axiLook(name, overrides?)");
    expect(look.summary).toMatch(/airy/);
  });
});
