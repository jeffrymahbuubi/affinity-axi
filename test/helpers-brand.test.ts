// axiBrand / axiToken / axiType / axiLogo: source hygiene, token lookup and its
// error messages, and the calls forwarded to axiText and axiImage (stubbed).
// The block is evaluated in plain Node with AXI_BRAND declared in the same
// scope, exactly how the CLI prepends it to a script.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { BRAND_INDEX, BRAND_INTERNAL, BRAND_SOURCE } from "../src/affinity/helpers-brand.js";

type Fn = (...a: any[]) => any;

const KIT = {
  schema: "affinity-axi/brand/1",
  name: "Lumen Studio",
  colours: { ink: "#1F2A44", sky: "#4C8DFF", sun: "#FFC857", mist: "#F2F5F9" },
  fonts: { headline: "Helvetica-Bold", body: "Helvetica" },
  type: { h1: { font: "headline", size: 64, spacing: 0.02 }, body: { font: "body", size: 32 } },
  space: [4, 8, 12, 16, 24],
  radius: { pill: 999 },
  logo: { primary: "/abs/logo.png", mark: "/abs/mark.png" },
};

// The block works whether or not the lead has spliced BRAND_SOURCE into HELPERS_SOURCE.
const BLOCK = HELPERS_SOURCE.includes("function axiToken(") ? HELPERS_SOURCE : HELPERS_SOURCE + BRAND_SOURCE;

/** Evaluates the helpers; `extra` runs in the same scope (declare AXI_BRAND, stub axiText / axiImage). */
function load(extra = ""): Record<string, Fn> {
  const names = [...BLOCK.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${extra}\n${BLOCK}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)(() => {
    throw new Error("SDK not available in tests");
  }) as Record<string, Fn>;
}

const withKit = (kit: unknown = KIT, stubs = ""): Record<string, Fn> => load(`const AXI_BRAND = ${JSON.stringify(kit)};\nvar calls = []; ${stubs}`);

/** Stubs that record what axiType / axiLogo forward. */
const RECORD = `
  var calls = [];
  axiText = function (doc, o) { calls.push(['text', o]); return { stub: 'text' }; };
  axiImage = function (doc, o) { calls.push(['image', o]); return { stub: 'image' }; };
`;

function recorded(kit: unknown = KIT): { h: Record<string, Fn>; calls: () => any[] } {
  const body = `const AXI_BRAND = ${JSON.stringify(kit)};\n${RECORD}`;
  const names = [...BLOCK.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const fn = new Function("require", `${body}\n${BLOCK}\nreturn { h: { ${names.join(", ")} }, calls: function () { return calls; } };`);
  return fn(() => {
    throw new Error("SDK not available in tests");
  });
}

describe("BRAND_SOURCE", () => {
  const declared = [...BRAND_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(BRAND_SOURCE)).not.toThrow();
    expect(() => new Script(BLOCK)).not.toThrow();
  });

  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(BRAND_SOURCE)).toEqual([]);
    expect(scanForAi(BRAND_SOURCE)).toEqual([]);
    expect(BRAND_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
    expect(BRAND_SOURCE).not.toMatch(/generat|\.close\b/i);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(BRAND_SOURCE).not.toContain("`");
    expect(BRAND_SOURCE).not.toContain("${");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of BRAND_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !BRAND_INDEX.some((h) => h.name === n)).sort()).toEqual([...BRAND_INTERNAL].sort());
    expect([...declared].sort()).toEqual(["axiBrand", "axiLogo", "axiToken", "axiType"]);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = BRAND_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
  });

  it("makes no SDK require of its own", () => {
    expect(BRAND_SOURCE).not.toContain("require(");
  });

  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
});

describe("axiBrand", () => {
  it("throws without a kit, with the run flag in the message", () => {
    expect(() => load().axiBrand()).toThrow("axiBrand: no brand kit; run with --brand <kit>");
  });
  it("returns a deep copy", () => {
    const h = withKit();
    const a = h.axiBrand();
    a.colours.ink = "#000000";
    expect(h.axiBrand().colours.ink).toBe("#1F2A44");
    expect(h.axiBrand().name).toBe("Lumen Studio");
  });
});

describe("axiToken", () => {
  const h = withKit();
  it("resolves dotted paths, including array indexes", () => {
    expect(h.axiToken("colours.ink")).toBe("#1F2A44");
    expect(h.axiToken("fonts.headline")).toBe("Helvetica-Bold");
    expect(h.axiToken("type.h1.size")).toBe(64);
    expect(h.axiToken("space.4")).toBe(24);
    expect(h.axiToken("radius.pill")).toBe(999);
    expect(h.axiToken("logo.mark")).toBe("/abs/mark.png");
    expect(h.axiToken("type.h1")).toEqual({ font: "headline", size: 64, spacing: 0.02 });
  });
  it("a miss lists the keys at the failing level", () => {
    expect(() => h.axiToken("colours.nope")).toThrow("axiToken: no colours.nope; have ink, sky, sun, mist");
    expect(() => h.axiToken("colour.ink")).toThrow(/axiToken: no colour\.ink; have schema, name, colours/);
    expect(() => h.axiToken("space.9")).toThrow("axiToken: no space.9; have 0, 1, 2, 3, 4");
    expect(() => h.axiToken("colours.ink.deep")).toThrow(/have \(colours\.ink is a value, not a group\)/);
  });
  it("does not walk the prototype chain", () => {
    expect(() => h.axiToken("colours.constructor")).toThrow(/axiToken: no colours\.constructor/);
    expect(() => h.axiToken("__proto__")).toThrow(/axiToken: no __proto__/);
  });
  it("rejects an empty path, and throws the no-kit message without a kit", () => {
    expect(() => h.axiToken("")).toThrow(/dotted string/);
    expect(() => load().axiToken("colours.ink")).toThrow("axiBrand: no brand kit");
  });
});

describe("axiType", () => {
  it("passes the resolved font, size, spacing and colour to axiText and returns its node", () => {
    const { h, calls } = recorded();
    const node = h.axiType({}, "h1", { x: 10, y: 20, text: "Hi", colour: "#123456", align: "c", maxW: 500, name: "head" });
    expect(node).toEqual({ stub: "text" });
    expect(calls()).toEqual([["text", { x: 10, y: 20, text: "Hi", font: "Helvetica-Bold", size: 64, colour: "#123456", spacing: 0.02, align: "c", maxW: 500, name: "head" }]]);
  });
  it("defaults the colour to the kit's first colour and resolves a kit colour key", () => {
    const { h, calls } = recorded();
    h.axiType({}, "body", { x: 0, y: 0, text: "a" });
    h.axiType({}, "body", { x: 0, y: 0, text: "b", colour: "sun" });
    expect(calls()[0][1]).toMatchObject({ font: "Helvetica", size: 32, colour: "#1F2A44" });
    expect(calls()[1][1].colour).toBe("#FFC857");
  });
  it("validates before touching the document", () => {
    const { h, calls } = recorded();
    expect(() => h.axiType({}, "", { x: 0, y: 0, text: "a" })).toThrow(/key must name a type style/);
    expect(() => h.axiType({}, "h1", { y: 0, text: "a" })).toThrow(/x and y are required/);
    expect(() => h.axiType({}, "h1", { x: 0, y: 0 })).toThrow(/text is required/);
    expect(() => h.axiType({}, "h9", { x: 0, y: 0, text: "a" })).toThrow("axiToken: no type.h9; have h1, body");
    expect(calls()).toEqual([]);
  });
  it("names the missing font role", () => {
    const kit = { ...KIT, type: { odd: { font: "mono", size: 10 } } };
    const { h } = recorded(kit);
    expect(() => h.axiType({}, "odd", { x: 0, y: 0, text: "a" })).toThrow(/type\.odd\.font mono is not in fonts; have headline, body/);
  });
});

describe("axiLogo", () => {
  it("places logo.primary by default with fit contain and the absolute path", () => {
    const { h, calls } = recorded();
    const node = h.axiLogo({}, { x: 1, y: 2, w: 300, h: 100, name: "logo" });
    expect(node).toEqual({ stub: "image" });
    expect(calls()).toEqual([["image", { path: "/abs/logo.png", x: 1, y: 2, w: 300, h: 100, fit: "contain", name: "logo" }]]);
  });
  it("takes a variant and fails clearly for a missing one or a kit without logos", () => {
    const { h, calls } = recorded();
    h.axiLogo({}, { variant: "mark", x: 0, y: 0, w: 50, h: 50 });
    expect(calls()[0][1].path).toBe("/abs/mark.png");
    expect(() => h.axiLogo({}, { variant: "wide", x: 0, y: 0, w: 5, h: 5 })).toThrow("axiToken: no logo.wide; have primary, mark");
    const { logo: _drop, ...noLogo } = KIT;
    expect(() => recorded(noLogo).h.axiLogo({}, { x: 0, y: 0, w: 5, h: 5 })).toThrow(/the brand kit has no logo; add logo\.primary/);
  });
  it("validates the box before anything else", () => {
    const { h, calls } = recorded();
    expect(() => h.axiLogo({}, { x: 0, y: 0, w: 0, h: 5 })).toThrow(/w and h must be positive/);
    expect(() => h.axiLogo({}, { y: 0, w: 5, h: 5 })).toThrow(/x is required/);
    expect(() => h.axiLogo({}, { variant: "", x: 0, y: 0, w: 5, h: 5 })).toThrow(/variant must be a logo key/);
    expect(calls()).toEqual([]);
  });
});
