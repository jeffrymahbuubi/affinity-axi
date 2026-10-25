// Named-element helpers: source hygiene, ref resolution against a fake node tree
// (checked row by row against the real inspect script run on the same tree),
// and the mutators against stubbed SDK modules. The live behaviour is covered
// by test/live/named-demo.js.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS, withHelpers } from "../src/affinity/helpers.js";
import { NAMED_INDEX, NAMED_INTERNAL, NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { INSPECT } from "../src/affinity/inspect-script.js";
import type { Inventory } from "../src/affinity/manifest-types.js";

type Fn = (...a: any[]) => any;

// --- source hygiene ---------------------------------------------------------

describe("NAMED_SOURCE", () => {
  const declared = [...NAMED_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(NAMED_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + NAMED_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards", () => {
    expect(scanForBlocking(NAMED_SOURCE)).toEqual([]);
    expect(scanForAi(NAMED_SOURCE)).toEqual([]);
    expect(NAMED_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
    expect(NAMED_SOURCE).not.toMatch(/`|\$\{/); // it lives in a String.raw block
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of NAMED_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !NAMED_INDEX.some((h) => h.name === n)).sort()).toEqual([...NAMED_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = NAMED_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("keeps the spread helpers internal, splice-safe and free of close(", () => {
    for (const n of ["axiSpreadOf", "axiOnSpread", "axiStoryRange"]) {
      expect(NAMED_INTERNAL).toContain(n);
      expect(NAMED_INDEX.map((h) => h.name)).not.toContain(n);
    }
    for (const n of declared) expect(HELPERS_SOURCE.split("function " + n + "(").length - 1).toBeLessThanOrEqual(1);
    expect(HELPERS_SOURCE).not.toMatch(/close\s*\(/);
  });

  it("styles text through glyph deltas over the story range, never node.setText or the node brush on text", () => {
    const body = (n: string) => NAMED_SOURCE.slice(NAMED_SOURCE.indexOf(`function ${n}(`)).split(/\n}\n/)[0]!;
    expect(body("axiSetText")).toMatch(/doc\.setText\(text, axiStoryRange/);
    expect(body("axiSetText")).toMatch(/formatText\(/);
    expect(NAMED_SOURCE).not.toMatch(/node\.setText\(/);
    expect(body("axiSetFill")).toMatch(/row\.text !== null[\s\S]*formatText\([\s\S]*else \{ doc\.setBrushFillDescriptor/);
  });

  it("is spliced into HELPERS_SOURCE once, with no name declared twice", () => {
    const all = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([]);
    for (const n of declared) expect(all).toContain(n);
    const indexNames = HELPER_INDEX.map((h) => h.name);
    expect(indexNames.filter((n, i) => indexNames.indexOf(n) !== i)).toEqual([]);
    for (const h of NAMED_INDEX) expect(indexNames).toContain(h.name);
    for (const n of NAMED_INTERNAL) expect(INTERNAL_HELPERS.filter((x) => x === n)).toHaveLength(1);
  });

  it("every index entry has a signature naming the helper and a summary", () => {
    for (const h of NAMED_INDEX) expect([h.signature.startsWith(`${h.name}(`), h.summary.length > 10]).toEqual([true, true]);
  });

  it("keeps the user's line numbers when appended after their script", () => {
    const user = "const a = 1;\nconsole.log(a);";
    expect((withHelpers(user) + NAMED_SOURCE).split("\n").slice(0, 2)).toEqual(user.split("\n"));
  });
});

// --- a fake document ----------------------------------------------------------

interface FakeSpec {
  name?: string;
  desc?: string;
  artboard?: boolean;
  tag?: string;
  text?: string;
  kids?: FakeSpec[];
  box?: [number, number, number, number];
  glyph?: { font: string; height: number; brushFill: string };
}

class FakeNode {
  children: FakeNode[];
  userDescription: string;
  description: string;
  isArtboardEnabled: boolean;
  text?: string;
  box: [number, number, number, number];
  parent: FakeNode | null = null;
  constructor(public spec: FakeSpec) {
    [this.userDescription, this.description, this.isArtboardEnabled] = [spec.name ?? "", spec.desc ?? "", !!spec.artboard];
    if (spec.text !== undefined) this.text = spec.text;
    this.box = spec.box ?? [0, 0, 100, 50];
    this.children = (spec.kids ?? []).map((k) => new FakeNode(k));
    for (const c of this.children) c.parent = this;
  }
  isSameNode = (o: FakeNode) => o === this;
  get isSpreadNode() {
    return this.spec.tag === "SpreadNode";
  }
  get [Symbol.toStringTag]() {
    return this.spec.tag ?? (this.spec.text !== undefined ? "ArtTextNode" : "ShapeNode");
  }
  getSpreadVisibleBox() {
    return { x: this.box[0], y: this.box[1], width: this.box[2], height: this.box[3] };
  }
  isVisible = true;
  get story() {
    const g = this.spec.glyph;
    return { length: (this.text ?? "").length, getGlyphAttRunsFrom: () => (g ? [{ glyphAtts: g }] : []) };
  }
  brushFillInterface = { fillDescriptor: { fill: null } };
  get baseBoxInterface() {
    return { baseBox: { x: 0, y: 0, width: this.box[2], height: this.box[3] } };
  }
  get transform() {
    return { applyToPoint: (p: { x: number; y: number }) => ({ x: p.x + this.box[0], y: p.y + this.box[1] }) };
  }
}

/** Two artboards with a headline each, a duplicate-free cta, an unnamed text and a nested group. */
const SPEC: FakeSpec[][] = [
  [
    {
      name: "ig-square",
      artboard: true,
      kids: [
        { name: "headline", text: "Light measured" },
        { name: "cta" },
        { text: "unnamed text" },
        { tag: "GroupNode", name: "card", kids: [{ name: "price", text: "Rp 1.200.000" }] },
      ],
    },
    {
      desc: "Artboard 2",
      artboard: true,
      kids: [{ name: "headline", text: "Second" }, { name: "cta" }],
    },
    { name: "loose" },
  ],
];

function makeDoc(spec: FakeSpec[][] = SPEC) {
  const spreads = spec.map((kids) => new FakeNode({ tag: "SpreadNode", kids }));
  return { sessionUuid: "UUID-1", spreads, selection: "untouched", title: "t", path: "", units: "Pixel", widthPixels: 1, heightPixels: 1, dpi: 72 } as Record<string, any>;
}

/** Evaluates NAMED_SOURCE (after the core helpers, for axiHex) with `modules` answering require(). */
function load(modules: Record<string, unknown> = {}): Record<string, Fn> {
  const names = [...(HELPERS_SOURCE + NAMED_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${NAMED_SOURCE}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)((id: string) => {
    if (id in modules) return modules[id];
    throw new Error(`SDK module ${id} not available in tests`);
  }) as Record<string, Fn>;
}

// --- resolution ---------------------------------------------------------------

describe("axiNames and the inspect script agree", () => {
  const h = load();
  const doc = makeDoc();

  /** Runs the real inspect script (named-only and full) against the same fake tree. */
  function inspect(named: boolean): Inventory {
    let line = "";
    const fn = new Function("require", "console", INSPECT("UUID-1", { named }));
    fn(() => ({ Document: { current: doc, all: [doc] } }), { log: (s: string) => (line = s) });
    return JSON.parse(line) as Inventory;
  }

  it("lists the same rows, paths, types and artboards as inspect --named", () => {
    const rows = inspect(true).nodes.map((n) => ({ path: n.path, name: n.name, type: n.type, artboard: n.artboard ?? "" }));
    expect(h.axiNames(doc)).toEqual(rows);
    expect(rows.map((r) => r.path)).toEqual(["0/0", "0/0/0", "0/0/1", "0/0/3", "0/0/3/0", "0/1/0", "0/1/1", "0/2"]);
  });

  it("uses the layer description as the artboard label for rows under an unnamed artboard", () => {
    const rows = inspect(false).nodes.filter((n) => n.path.startsWith("0/1/"));
    expect(rows.every((n) => n.artboard === "Artboard 2")).toBe(true);
    expect(h.axiFind(doc, "Artboard 2/cta")).toBe(doc.spreads[0].children[1].children[1]);
  });

  it("indexes paths as spread/child/child over every node, named or not", () => {
    const all = inspect(false).nodes.map((n) => n.path);
    expect(all).toEqual(["0/0", "0/0/0", "0/0/1", "0/0/2", "0/0/3", "0/0/3/0", "0/1", "0/1/0", "0/1/1", "0/2"]);
    for (const p of all) expect(h.axiFind(doc, `#${p}`)).toBeDefined();
  });
});

describe("refs", () => {
  const h = load();
  const doc = makeDoc();
  const root = doc.spreads[0];

  it("finds by exact name, artboard/name and index path", () => {
    expect(h.axiFind(doc, "price")).toBe(root.children[0].children[3].children[0]);
    expect(h.axiFind(doc, "ig-square/headline")).toBe(root.children[0].children[0]);
    expect(h.axiFind(doc, "Artboard 2/headline")).toBe(root.children[1].children[0]);
    expect(h.axiFind(doc, "#0/1/0")).toBe(root.children[1].children[0]);
    expect(h.axiFind(doc, "ig-square")).toBe(root.children[0]);
  });

  it("scopes artboard/name to the nearest artboard, including inside groups", () => {
    expect(h.axiFind(doc, "ig-square/price")).toBe(root.children[0].children[3].children[0]);
    expect(() => h.axiFind(doc, "Artboard 2/price")).toThrow(/nothing matches/);
  });

  it("finds text nodes by regex, RegExp or string", () => {
    expect(h.axiFind(doc, { text: /^Light/ })).toBe(root.children[0].children[0]);
    expect(h.axiFind(doc, { text: "^Second$" })).toBe(root.children[1].children[0]);
    expect(h.axiFindAll(doc, { text: /./g }).length).toBe(4);
    expect(h.axiFind(doc, { text: /unnamed/ })).toBe(root.children[0].children[2]);
  });

  it("throws ambiguous with every candidate and its path", () => {
    expect(() => h.axiFind(doc, "headline")).toThrow(/ambiguous \(2 matches\): ig-square\/headline \(#0\/0\/0\), Artboard 2\/headline \(#0\/1\/0\)/);
    expect(() => h.axiFind(doc, "cta")).toThrow(/ambiguous/);
    expect(() => h.axiFind(doc, { text: /./ })).toThrow(/ambiguous \(4 matches\)/);
  });

  it("throws not found with the named elements, and findAll returns [] instead", () => {
    expect(() => h.axiFind(doc, "nope")).toThrow(/nothing matches nope; named elements: ig-square \(#0\/0\)/);
    expect(() => h.axiFind(doc, "#0/9/9")).toThrow(/nothing matches #0\/9\/9/);
    expect([h.axiFindAll(doc, "nope"), h.axiFindAll(doc, "headline").length]).toEqual([[], 2]);
  });

  it("rejects malformed refs", () => {
    expect(() => h.axiFind(doc, "")).toThrow(/ref is empty/);
    expect(() => h.axiFind(doc, 7)).toThrow(/ref must be/);
    expect(() => h.axiFind(doc, null)).toThrow(/ref must be/);
    expect(() => h.axiFind(doc, { text: "(" })).toThrow(/not a valid regular expression/);
    expect(h.axiFindAll(doc, "ig-square/")).toEqual([]); // an empty name never matches unnamed nodes
  });
});

// --- mutators ------------------------------------------------------------------

/** A tiny affine transform (scale + translate) with the multiply order of the SDK: a.multiply(b) applies b first. */
class Tf {
  constructor(public sx = 1, public sy = 1, public tx = 0, public ty = 0) {}
  static createTranslate = (x: number, y: number) => new Tf(1, 1, x, y);
  static createScale = (x: number, y: number) => new Tf(x, y, 0, 0);
  multiply = (o: Tf) => new Tf(this.sx * o.sx, this.sy * o.sy, this.sx * o.tx + this.tx, this.sy * o.ty + this.ty);
  apply = (p: { x: number; y: number }) => ({ x: this.sx * p.x + this.tx, y: this.sy * p.y + this.ty });
}

const SDK: Record<string, unknown> = {
  "/fills.js": { FillDescriptor: { createSolid: (c: unknown) => ({ solid: c }) } },
  "/colours.js": { RGBA8: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
  "/geometry.js": { Transform: Tf },
  "/selections.js": {
    Selection: { create: (_d: unknown, node: FakeNode) => ({ node, subs: [] as unknown[], addSubSelectionForNode(_n: unknown, t: unknown) { this.subs.push(t); } }) },
    TextSelection: { create: (ranges: unknown) => ({ ranges }) },
  },
  "/storydelta.js": { StoryDelta: { createBrushFill: (brush: unknown) => ({ brush }), createFont: (fields: number, font: unknown) => ({ fields, font }), createGlyphDouble: (key: number, value: number) => ({ key, value }), createComposite: (all: unknown[]) => ({ all }) } },
  "/fonts.js": { FontField: { PostscriptName: 1, FamilyName: 2 } }, "/glyphatts.js": { GlyphAttDoubleType: { Height: 7 } },
};

describe("mutators", () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const doc = makeDoc();
  const record = (fn: string) => (...args: unknown[]) => void calls.push({ fn, args });
  doc.setBrushFillDescriptor = record("fill");
  doc.applyTransform = record("transform");
  doc.deleteSelection = record("delete");
  doc.setText = (t: string, sel: { node: FakeNode }) => void ((sel.node.text = t), calls.push({ fn: "setText", args: [t, sel] }));
  doc.formatText = record("format");
  const h = load(SDK);
  const og = doc.spreads[0].children[1];

  it("axiSetText sets one text node and returns it, and refuses non-text nodes", () => {
    const n = h.axiSetText(doc, "ig-square/headline", "Baru");
    expect(n).toBe(doc.spreads[0].children[0].children[0]);
    expect(n.text).toBe("Baru");
    expect(og.children[0].text).toBe("Second");
    expect(() => h.axiSetText(doc, "ig-square/cta", "x")).toThrow(/is not a text node/);
    expect(() => h.axiSetText(doc, "ig-square/headline", 5)).toThrow(/text must be a string/);
  });

  it("axiSetText reapplies the first run's font, size and fill after setText, over the whole story", () => {
    const styled = makeDoc([[{ name: "head", text: "Old", glyph: { font: "Helvetica-Bold", height: 84, brushFill: "navy" } }]]);
    Object.assign(styled, { setText: doc.setText, formatText: doc.formatText });
    calls.length = 0;
    h.axiSetText(styled, "head", "Newer");
    expect(calls.map((c) => c.fn)).toEqual(["setText", "format"]);
    const [text, fmt] = calls as [{ args: [string, { subs: any[] }] }, { args: [{ all: any[] }, { subs: any[] }] }];
    expect(text.args[1].subs).toEqual([{ ranges: [{ begin: 0, end: 3 }] }]);
    expect(fmt.args[0].all).toEqual([{ fields: 3, font: "Helvetica-Bold" }, { key: 7, value: 84 }, { brush: "navy" }]);
    expect(fmt.args[1].subs).toEqual([{ ranges: [{ begin: 0, end: 5 }] }]);
  });

  it("axiSetText refuses an ambiguous ref instead of editing both", () => {
    expect(() => h.axiSetText(doc, "headline", "x")).toThrow(/ambiguous/);
  });

  it("axiSetFill on text is a glyph brush fill over the whole story, not the node brush", () => {
    calls.length = 0;
    const n = h.axiSetFill(doc, "ig-square/headline", "#B5252A");
    expect(calls.map((c) => c.fn)).toEqual(["format"]);
    const [{ args }] = calls as [{ args: [{ brush: unknown }, { node: FakeNode; subs: unknown[] }] }];
    expect(args[0]).toEqual({ brush: { solid: { r: 0xb5, g: 0x25, b: 0x2a, a: 255 } } });
    expect(args[1].node).toBe(n);
    expect(args[1].subs).toEqual([{ ranges: [{ begin: 0, end: n.text.length }] }]);
    expect(doc.selection).toBe("untouched");
  });

  it("axiSetFill (shape) passes the node itself as the selection and leaves doc.selection alone", () => {
    calls.length = 0;
    const n = h.axiSetFill(doc, "Artboard 2/cta", "#4C8DFF");
    expect(n).toBe(og.children[1]);
    expect(calls).toEqual([{ fn: "fill", args: [{ solid: { r: 0x4c, g: 0x8d, b: 0xff, a: 255 } }, og.children[1]] }]);
    expect(doc.selection).toBe("untouched");
    expect(() => h.axiSetFill(doc, "Artboard 2/cta", "blue")).toThrow(/bad colour/);
  });

  it("axiSetBox maps the old box onto the new one, scaling about the top-left", () => {
    calls.length = 0;
    const node = doc.spreads[0].children[0].children[1];
    node.box = [100, 200, 320, 96];
    const n = h.axiSetBox(doc, "ig-square/cta", { x: 500, y: 40, w: 640, h: 48 });
    expect(n).toBe(node);
    const [{ args }] = calls as [{ args: [Tf, unknown] }];
    expect(args[1]).toBe(node);
    expect(args[0].apply({ x: 100, y: 200 })).toEqual({ x: 500, y: 40 });
    expect(args[0].apply({ x: 420, y: 296 })).toEqual({ x: 1140, y: 88 });
  });

  it("axiSetBox keeps the fields it is not given", () => {
    calls.length = 0;
    const node = doc.spreads[0].children[0].children[1];
    node.box = [100, 200, 320, 96];
    h.axiSetBox(doc, "ig-square/cta", { x: 0 });
    const [{ args }] = calls as [{ args: [Tf, unknown] }];
    expect(args[0].apply({ x: 100, y: 200 })).toEqual({ x: 0, y: 200 });
    expect(args[0].apply({ x: 420, y: 296 })).toEqual({ x: 320, y: 296 });
  });

  it("axiSetBox validates the box before touching the document", () => {
    calls.length = 0;
    expect(() => h.axiSetBox(doc, "ig-square/cta", undefined)).toThrow(/box .* is required/);
    expect(() => h.axiSetBox(doc, "ig-square/cta", { w: 0 })).toThrow(/w and h must be positive/);
    expect(() => h.axiSetBox(doc, "ig-square/cta", { x: NaN })).toThrow(/x must be a finite number/);
    expect(() => h.axiSetBox(doc, "ig-square/cta", { x: "1" })).toThrow(/x must be a finite number/);
    expect(calls).toEqual([]);
  });

  it("axiRename sets userDescription so the new name resolves and the old one stops", () => {
    const n = h.axiRename(doc, "#0/1/1", "button");
    expect(n.userDescription).toBe("button");
    expect(h.axiFind(doc, "Artboard 2/button")).toBe(n);
    expect(() => h.axiFind(doc, "Artboard 2/cta")).toThrow(/nothing matches/);
    expect(() => h.axiRename(doc, "button", "")).toThrow(/non-empty/);
    expect(() => h.axiRename(doc, "button", 3)).toThrow(/non-empty/);
  });

  it("axiDelete deletes exactly one node by passing it as the selection", () => {
    calls.length = 0;
    expect(h.axiDelete(doc, "price")).toBeUndefined();
    expect(calls).toEqual([{ fn: "delete", args: [doc.spreads[0].children[0].children[3].children[0]] }]);
    expect(() => h.axiDelete(doc, "headline")).toThrow(/ambiguous/);
    expect(calls.length).toBe(1);
  });
});

describe("axiOpen", () => {
  const loaded: string[] = [];
  const open = { path: "/home/x/Desktop/a.af", sessionUuid: "OPEN" };
  const h = load({ "/document.js": { Document: { all: [{ path: "", sessionUuid: "U" }, open], load: (p: string) => (loaded.push(p), { path: p, sessionUuid: "NEW" }) } } });

  it("reuses a document that is already open at that path and never reloads it", () => {
    expect(h.axiOpen("/home/x/Desktop/a.af")).toBe(open);
    expect(loaded).toEqual([]);
  });

  it("loads a document that is not open, and requires an absolute path", () => {
    expect(h.axiOpen("/home/x/Desktop/b.af").sessionUuid).toBe("NEW");
    expect(loaded).toEqual(["/home/x/Desktop/b.af"]);
    expect(() => h.axiOpen("a.af")).toThrow(/absolute/);
    expect(() => h.axiOpen(undefined)).toThrow(/absolute/);
  });
});

// --- spreads -------------------------------------------------------------------

describe("mutators on a non-current spread", () => {
  const SPREADS: FakeSpec[][] = [
    [{ name: "a-text", text: "A" }, { name: "a-box" }],
    [{ name: "b-text", text: "B" }, { name: "b-box" }, { name: "b-gone" }, { name: "b-name" }, { name: "b-fill" }],
  ];
  // Two-spread fake document; every command lands in `log`; switching spreads clears the selection, as the SDK does.
  function twoSpreads(opts: { current?: number; selected?: string[] } = {}) {
    const log: string[] = [];
    const doc = makeDoc(SPREADS);
    doc.currentSpread = doc.spreads[opts.current ?? 0];
    let sel: FakeNode[] = (opts.selected ?? []).map((name) => doc.spreads[0].children.find((c: FakeNode) => c.userDescription === name));
    doc.executeCommand = (c: { spread: FakeNode }) => void (log.push(`current->${doc.spreads.indexOf(c.spread)}`), (doc.currentSpread = c.spread), (sel = []));
    Object.defineProperty(doc, "selection", {
      get: () => ({ nodes: sel }),
      set: (v: FakeNode[]) => void (log.push(`select ${v.map((n) => n.userDescription).join(",")}`), (sel = v)),
    });
    doc.setText = (t: string) => void log.push(`setText ${t}`);
    for (const [fn, tag] of [["setBrushFillDescriptor", "fill"], ["applyTransform", "transform"]] as const) doc[fn] = (_a: unknown, n: FakeNode) => void log.push(`${tag} ${n.userDescription}`);
    doc.deleteSelection = (n: FakeNode) => void log.push(`delete ${n.userDescription}`);
    return { doc, log, spreads: doc.spreads as FakeNode[] };
  }

  const mods: Record<string, unknown> = { ...SDK, "/commands.js": { DocumentCommand: { createSetCurrentSpread: (spread: FakeNode) => ({ spread }) } } };
  const h = load(mods);
  const spy = (d: Record<string, any>, ref: string, key: string, log: string[], tag: string) => {
    const n = h.axiFind(d, ref);
    Object.defineProperty(n, key, { get: () => "x", set: (v: string) => void log.push(`${tag} ${v}`) });
  };
  const cases: Array<[string, (doc: Record<string, any>, log: string[]) => void, string]> = [
    ["axiSetText", (d, log) => void h.axiSetText(d, "b-text", "Baru"), "setText Baru"],
    ["axiSetFill", (d) => void h.axiSetFill(d, "b-fill", "#4C8DFF"), "fill b-fill"],
    ["axiSetBox", (d) => void h.axiSetBox(d, "b-box", { x: 5 }), "transform b-box"],
    ["axiRename", (d, log) => (spy(d, "b-name", "userDescription", log, "rename"), void h.axiRename(d, "#1/3", "renamed")), "rename renamed"],
    ["axiDelete", (d) => void h.axiDelete(d, "b-gone"), "delete b-gone"],
  ];

  for (const [name, run, edit] of cases) {
    it(`${name} switches to the node's spread for the edit and back; no command on the current spread`, () => {
      const a = twoSpreads();
      run(a.doc, a.log);
      expect(a.log).toEqual(["current->1", edit, "current->0"]);
      expect(a.doc.currentSpread).toBe(a.spreads[0]);
      const b = twoSpreads({ current: 1 });
      run(b.doc, b.log);
      expect(b.log).toEqual([edit]);
    });
  }

  it("restores the spread even when the edit throws, and rethrows the error", () => {
    const { doc, log, spreads } = twoSpreads();
    doc.deleteSelection = () => void (() => { throw new Error("COMMAND_FAILED"); })();
    expect(() => h.axiDelete(doc, "b-gone")).toThrow(/COMMAND_FAILED/);
    expect(log).toEqual(["current->1", "current->0"]);
    expect(doc.currentSpread).toBe(spreads[0]);
  });

  it("puts the selection back after the round trip, and only when there was one", () => {
    const a = twoSpreads({ selected: ["a-text"] });
    h.axiSetFill(a.doc, "b-fill", "#4C8DFF");
    expect(a.log).toEqual(["current->1", "fill b-fill", "current->0", "select a-text"]);
    expect(a.doc.selection.nodes).toEqual([a.spreads[0]!.children[0]]);
    const b = twoSpreads();
    h.axiSetFill(b.doc, "b-fill", "#4C8DFF");
    expect(b.log).toEqual(["current->1", "fill b-fill", "current->0"]);
  });

  it("a one-spread document never executes a command or loads /commands.js", () => {
    const log: string[] = [];
    const doc = Object.assign(makeDoc(), { executeCommand: () => void log.push("command") });
    doc.currentSpread = doc.spreads[0];
    for (const k of ["setBrushFillDescriptor", "applyTransform", "deleteSelection", "setText"]) doc[k] = () => void log.push(k);
    const g = load(Object.fromEntries(Object.entries(mods).filter(([k]) => k !== "/commands.js"))); // requiring /commands.js would throw
    g.axiSetText(doc, "ig-square/headline", "x");
    g.axiSetFill(doc, "ig-square/cta", "#4C8DFF");
    g.axiSetBox(doc, "ig-square/cta", { x: 1 });
    g.axiRename(doc, "ig-square/cta", "btn");
    g.axiDelete(doc, "price");
    expect(log).toEqual(["setText", "setBrushFillDescriptor", "applyTransform", "deleteSelection"]);
  });

  it("axiSpreadOf finds the holding spread, else null; orphans and read-only helpers never switch", () => {
    const { doc, log, spreads } = twoSpreads();
    expect(h.axiSpreadOf(spreads[1]!.children[0])).toBe(spreads[1]);
    expect(h.axiSpreadOf(spreads[0])).toBe(spreads[0]);
    expect(h.axiSpreadOf(new FakeNode({ name: "loose" }))).toBeNull();
    expect(h.axiSpreadOf(null)).toBeNull();
    h.axiOnSpread(doc, new FakeNode({ name: "orphan" }))();
    h.axiFind(doc, "b-text");
    h.axiFindAll(doc, { text: /./ });
    h.axiNames(doc);
    expect(log).toEqual([]);
  });

  it("falls back to index equality in doc.spreads when isSameNode is missing", () => {
    for (const [current, want] of [[0, ["current->1", "fill b-fill", "current->0"]], [1, ["fill b-fill"]]] as const) {
      const { doc, log, spreads } = twoSpreads({ current });
      spreads.forEach((s) => ((s as any).isSameNode = undefined));
      h.axiSetFill(doc, "b-fill", "#4C8DFF");
      expect(log).toEqual(want);
    }
  });
});
