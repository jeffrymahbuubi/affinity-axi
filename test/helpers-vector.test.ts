// Vector helpers (axiOutline, axiBool): source hygiene, validation before any
// SDK call, and the SDK method chosen per op against a stubbed document. The
// live behaviour (curves, SVG paths, subtract order) was checked against
// Affinity; see the unit's handoff.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { VECTOR_INDEX, VECTOR_INTERNAL, VECTOR_SOURCE } from "../src/affinity/helpers-vector.js";

type Fn = (...a: any[]) => any;

// --- source hygiene ---------------------------------------------------------

describe("VECTOR_SOURCE", () => {
  const declared = [...VECTOR_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(VECTOR_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + VECTOR_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and never closes anything", () => {
    expect(scanForBlocking(VECTOR_SOURCE)).toEqual([]);
    expect(scanForAi(VECTOR_SOURCE)).toEqual([]);
    expect(VECTOR_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(VECTOR_SOURCE).not.toContain("`");
    expect(VECTOR_SOURCE).not.toContain("${");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of VECTOR_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !VECTOR_INDEX.some((h) => h.name === n)).sort()).toEqual([...VECTOR_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = VECTOR_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("collides with no name in the existing helpers", () => {
    // Splice-safe: HELPERS_SOURCE holds this block once after the lead splices it in, never twice.
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("every index entry has a signature naming the helper and a summary", () => {
    for (const h of VECTOR_INDEX) {
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary.length).toBeGreaterThan(10);
    }
  });

  it("keeps SDK requires inside functions", () => {
    expect(VECTOR_SOURCE.split("\n").filter((l) => /^\S/.test(l) && l.includes("require("))).toEqual([]);
  });
});

// --- a stubbed document ---------------------------------------------------------

class FakeNode {
  isNode = true;
  children: FakeNode[] = [];
  isArtboardEnabled = false;
  constructor(public userDescription: string, public text?: string) {}
  get [Symbol.toStringTag]() {
    return this.text !== undefined ? "ArtTextNode" : "ShapeNode";
  }
}

interface Call {
  fn: string;
  nodes: FakeNode[];
}

/**
 * A document with a headline, two shapes and a tail on one artboard. Each
 * vector command records the nodes of the selection it was given and replaces
 * doc.selection with `produce(nodes)`, as Affinity does.
 */
function makeDoc(produce: (fn: string, nodes: FakeNode[]) => FakeNode[] = (fn) => [new FakeNode(`${fn}-result`)]) {
  const word = new FakeNode("wordmark", "lumen");
  const a = new FakeNode("a");
  const b = new FakeNode("b");
  const c = new FakeNode("c");
  const board = new FakeNode("board");
  board.isArtboardEnabled = true;
  board.children = [word, a, b, c];
  const spread = new FakeNode("");
  spread.children = [board];
  const calls: Call[] = [];
  const state = { selected: [] as FakeNode[] };
  const doc: Record<string, any> = {
    spreads: [spread],
    get selection() {
      return { nodes: { first: state.selected[0], length: state.selected.length, [Symbol.iterator]: () => state.selected[Symbol.iterator]() } };
    },
  };
  const run = (fn: string) => (sel: { nodes: FakeNode[] }) => {
    calls.push({ fn, nodes: sel.nodes });
    state.selected = produce(fn, sel.nodes);
  };
  doc.convertToCurves = run("convertToCurves");
  for (const [m, name] of [["boolOpUnion", "union"], ["boolOpSubtract", "subtract"], ["boolOpIntersect", "intersect"], ["boolOpXor", "xor"], ["divideShapes", "divide"]] as const) {
    doc[m] = run(name);
  }
  return { doc, calls, word, a, b, c };
}

/** Evaluates the core and named helpers plus VECTOR_SOURCE with a fake Selection module. */
function load(): Record<string, Fn> {
  const names = [...(HELPERS_SOURCE + NAMED_SOURCE + VECTOR_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${NAMED_SOURCE}\n${VECTOR_SOURCE}\nreturn { ${names.join(", ")} };`;
  const required: string[] = [];
  const fns = new Function("require", body)((id: string) => {
    required.push(id);
    if (id === "/selections.js") return { Selection: { create: (_doc: unknown, items: FakeNode | FakeNode[]) => ({ nodes: Array.isArray(items) ? items : [items] }) } };
    throw new Error(`SDK module ${id} not available in tests`);
  }) as Record<string, Fn>;
  (fns as any).__required = required;
  return fns;
}

// --- axiOutline -------------------------------------------------------------------

describe("axiOutline", () => {
  it("converts the node found by name and returns the selected result under the original name", () => {
    const h = load();
    const { doc, calls, word } = makeDoc((_fn, _nodes) => [new FakeNode("")]);
    const out = h.axiOutline(doc, "wordmark");
    expect(calls).toEqual([{ fn: "convertToCurves", nodes: [word] }]);
    expect(out.userDescription).toBe("wordmark");
    expect(doc.selection.nodes.first).toBe(out);
  });

  it("applies name when given, and takes a node as well as a ref", () => {
    const h = load();
    const { doc, calls, a } = makeDoc((_fn, _nodes) => [new FakeNode("")]);
    const out = h.axiOutline(doc, a, { name: "a-curves" });
    expect(calls[0]!.nodes).toEqual([a]);
    expect(out.userDescription).toBe("a-curves");
  });

  it("leaves the result unnamed when neither the original nor name has one", () => {
    const h = load();
    const { doc, a } = makeDoc((_fn, _nodes) => [new FakeNode("")]);
    a.userDescription = "";
    expect(h.axiOutline(doc, a).userDescription).toBe("");
  });

  it("validates before any SDK module is required or command run", () => {
    const h = load();
    const { doc, calls } = makeDoc();
    expect(() => h.axiOutline(doc, undefined)).toThrow(/ref is required/);
    expect(() => h.axiOutline(doc, null)).toThrow(/ref is required/);
    expect(() => h.axiOutline(doc, 5)).toThrow(/each ref must be/);
    expect(() => h.axiOutline(doc, "nope")).toThrow(/nothing matches nope/);
    expect(calls).toEqual([]);
    expect((h as any).__required).toEqual([]);
  });

  it("refuses an ambiguous name instead of converting one of them", () => {
    const h = load();
    const { doc, calls, b } = makeDoc();
    b.userDescription = "a";
    expect(() => h.axiOutline(doc, "a")).toThrow(/ambiguous/);
    expect(calls).toEqual([]);
  });

  it("throws when the command leaves nothing selected", () => {
    const h = load();
    const { doc } = makeDoc(() => []);
    expect(() => h.axiOutline(doc, "wordmark")).toThrow(/left nothing selected/);
  });
});

// --- axiBool ----------------------------------------------------------------------

describe("axiBool", () => {
  const methodFor: Array<[string, string]> = [
    ["union", "boolOpUnion"],
    ["subtract", "boolOpSubtract"],
    ["intersect", "boolOpIntersect"],
    ["xor", "boolOpXor"],
    ["divide", "divideShapes"],
  ];

  it.each(methodFor)("%s runs one command on one selection of every ref, in the given order", (op) => {
    const h = load();
    const { doc, calls, a, b, c } = makeDoc((fn) => [new FakeNode(fn)]);
    h.axiBool(doc, op, ["c", "a", "b"]);
    expect(calls).toEqual([{ fn: op, nodes: [c, a, b] }]);
  });

  it("returns the single result node for every op but divide, selected and named", () => {
    const h = load();
    for (const op of ["union", "subtract", "intersect", "xor"]) {
      const { doc } = makeDoc((fn) => [new FakeNode(fn)]);
      const out = h.axiBool(doc, op, ["a", "b"], { name: "mark" });
      expect(Array.isArray(out)).toBe(false);
      expect(out.userDescription).toBe("mark");
      expect(doc.selection.nodes.first).toBe(out);
    }
  });

  it("keeps the result's own name when name is not given", () => {
    const h = load();
    const { doc } = makeDoc((fn) => [new FakeNode(`${fn}-result`)]);
    expect(h.axiBool(doc, "union", ["a", "b"]).userDescription).toBe("union-result");
  });

  it("divide returns every piece as an array, numbered when named", () => {
    const h = load();
    const { doc } = makeDoc(() => [new FakeNode("p"), new FakeNode("q"), new FakeNode("r")]);
    const out = h.axiBool(doc, "divide", ["a", "b"], { name: "tile" });
    expect(Array.isArray(out)).toBe(true);
    expect(out.map((n: FakeNode) => n.userDescription)).toEqual(["tile-1", "tile-2", "tile-3"]);
  });

  it("divide with one piece and a name uses the name as is", () => {
    const h = load();
    const { doc } = makeDoc(() => [new FakeNode("p")]);
    expect(h.axiBool(doc, "divide", ["a", "b"], { name: "tile" }).map((n: FakeNode) => n.userDescription)).toEqual(["tile"]);
  });

  it("accepts nodes and refs mixed", () => {
    const h = load();
    const { doc, calls, a, b } = makeDoc((fn) => [new FakeNode(fn)]);
    h.axiBool(doc, "union", [a, "b"]);
    expect(calls[0]!.nodes).toEqual([a, b]);
  });

  it("rejects an unknown op and fewer than two refs before any SDK call", () => {
    const h = load();
    const { doc, calls } = makeDoc();
    expect(() => h.axiBool(doc, "merge", ["a", "b"])).toThrow(/unknown op merge; use union, subtract, intersect, xor, divide/);
    expect(() => h.axiBool(doc, undefined, ["a", "b"])).toThrow(/unknown op undefined/);
    expect(() => h.axiBool(doc, "union", ["a"])).toThrow(/at least two/);
    expect(() => h.axiBool(doc, "union", "a")).toThrow(/at least two/);
    expect(() => h.axiBool(doc, "union", undefined)).toThrow(/at least two/);
    expect(() => h.axiBool(doc, "union", ["a", 3])).toThrow(/each ref must be/);
    expect(() => h.axiBool(doc, "union", ["a", "nope"])).toThrow(/nothing matches nope/);
    expect(calls).toEqual([]);
    expect((h as any).__required).toEqual([]);
  });

  it("throws a clear error when the command leaves nothing selected", () => {
    const h = load();
    const { doc } = makeDoc(() => []);
    expect(() => h.axiBool(doc, "intersect", ["a", "b"])).toThrow(/intersect produced no node/);
  });
});
