// axiClip: source hygiene, validation before any SDK call, and the behaviour against
// a stubbed document that mimics the live gotcha (after a move Inside, the next node
// created lands inside that container unless the selection is reset). The live
// clipping itself was probed in test/live/vector-probe.js.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { CLIP_INDEX, CLIP_INTERNAL, CLIP_SOURCE } from "../src/affinity/helpers-clip.js";

type Fn = (...a: any[]) => any;

describe("CLIP_SOURCE", () => {
  const declared = [...CLIP_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(CLIP_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + CLIP_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and never closes anything", () => {
    expect(scanForBlocking(CLIP_SOURCE)).toEqual([]);
    expect(scanForAi(CLIP_SOURCE)).toEqual([]);
    expect(CLIP_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick, dollar-brace or backslash (it lives in a String.raw block)", () => {
    expect(CLIP_SOURCE).not.toContain("`");
    expect(CLIP_SOURCE).not.toContain("${");
    expect(CLIP_SOURCE).not.toContain("\\");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of CLIP_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !CLIP_INDEX.some((h) => h.name === n)).sort()).toEqual([...CLIP_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = CLIP_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("collides with no name in the existing helpers", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("every index entry has a signature naming the helper and a summary", () => {
    for (const h of CLIP_INDEX) {
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary.length).toBeGreaterThan(10);
    }
  });

  it("keeps SDK requires inside functions", () => {
    expect(CLIP_SOURCE.split("\n").filter((l) => /^\S/.test(l) && l.includes("require("))).toEqual([]);
  });
});

// --- a stubbed document -------------------------------------------------------------

class FakeNode {
  isNode = true;
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  pictureFrameEnabled = false;
  constructor(public userDescription: string) {}
  get selfSelection() {
    return { nodes: [this] };
  }
}

function makeDoc(opts: { failMove?: boolean } = {}) {
  const board = new FakeNode("board");
  const state = { selected: [board] as FakeNode[], insertInto: board };
  const created: FakeNode[] = [];
  const moves: Array<{ node: FakeNode; frame: FakeNode; type: string; child: string }> = [];
  const doc: Record<string, any> = {
    get selection() {
      return { nodes: { first: state.selected[0], length: state.selected.length } };
    },
    set selection(v: FakeNode | FakeNode[]) {
      const n = Array.isArray(v) ? v[0]! : v;
      state.selected = [n];
      state.insertInto = n; // the selected node takes new nodes
    },
    addNode(def: { pictureFrameEnabled: boolean; kind: string; box: unknown; radius?: number }) {
      const n = new FakeNode("");
      (n as any).def = def;
      n.pictureFrameEnabled = def.pictureFrameEnabled;
      n.parent = state.insertInto;
      state.insertInto.children.push(n);
      state.selected = [n];
      created.push(n);
    },
    executeCommand(cmd: { node: FakeNode; frame: FakeNode; type: string; child: string }) {
      moves.push(cmd);
      if (opts.failMove) return;
      cmd.node.parent!.children = cmd.node.parent!.children.filter((c) => c !== cmd.node);
      cmd.node.parent = cmd.frame;
      cmd.frame.children.push(cmd.node);
      state.insertInto = cmd.frame; // the live gotcha: later nodes land in the last container
    },
  };
  const make = (name: string) => {
    const n = new FakeNode(name);
    n.parent = board;
    board.children.push(n);
    return n;
  };
  return { doc, board, state, created, moves, make };
}

function load() {
  const required: string[] = [];
  const names = [...(HELPERS_SOURCE + CLIP_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  // Names resolve through a lookup table on the doc, replacing the inspect-based axiFind.
  const body = `${HELPERS_SOURCE}\n${CLIP_SOURCE}\nfunction axiFind(doc, ref) { return doc.__byName[ref]; }\nreturn { ${[...new Set(names)].join(", ")} };`;
  const sdk: Record<string, any> = {
    "/colours.js": { RGBA8: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
    "/linestyle.js": { LineStyle: { create: (x: unknown) => x }, LineStyleDescriptor: { create: (x: unknown) => x } },
    "/shapes.js": {
      ShapeCornerType: { Round: "Round" },
      ShapeRectangle: { create: () => ({ kind: "rect", topLeft: corner(), topRight: corner(), bottomLeft: corner(), bottomRight: corner() }) },
      ShapeEllipse: { create: () => ({ kind: "ellipse" }) },
    },
    "/nodes.js": {
      ShapeNodeDefinition: { create: (shape: { kind: string }, box: unknown, fill: unknown) => ({ kind: shape.kind, shape, box, fill, pictureFrameEnabled: false }) },
    },
    "/commands.js": {
      DocumentCommand: { createMoveNodes: (sel: { nodes: FakeNode[] }, frame: FakeNode, type: string, child: string) => ({ node: sel.nodes[0], frame, type, child }) },
      NodeMoveType: { Inside: "Inside" },
      NodeChildType: { Main: "Main" },
    },
  };
  const fns = new Function("require", body)((id: string) => {
    required.push(id);
    if (sdk[id]) return sdk[id];
    throw new Error(`SDK module ${id} not available in tests`);
  }) as Record<string, Fn>;
  return { fns, required };
}

function corner() {
  return { cornerType: "", radius: -1, setRadius(k: number) { this.radius = k; } };
}

const SPEC = { shape: "rect", x: 10, y: 20, w: 200, h: 100 };

describe("axiClip", () => {
  it("builds a rect picture frame with the axiRect radius rule, then moves the content in", () => {
    const { fns } = load();
    const t = makeDoc();
    const a = t.make("a");
    const r = fns.axiClip!(t.doc, { ...SPEC, radius: 40, fill: "#F2F5F9", name: "card" }, a);
    const def = (r.frame as any).def;
    expect(def.kind).toBe("rect");
    expect(def.pictureFrameEnabled).toBe(true);
    expect(def.shape.topLeft.radius).toBeCloseTo(0.4);
    expect(r.frame.userDescription).toBe("card");
    expect(r.nodes).toEqual([a]);
    expect(r.frame.children).toEqual([a]);
  });

  it("uses ShapeEllipse for an ellipse spec and names the frame from opts", () => {
    const { fns } = load();
    const t = makeDoc();
    const a = t.make("a");
    const r = fns.axiClip!(t.doc, { ...SPEC, shape: "ellipse" }, a, { name: "badge" });
    expect((r.frame as any).def.kind).toBe("ellipse");
    expect((r.frame as any).def.pictureFrameEnabled).toBe(true);
    expect(r.frame.userDescription).toBe("badge");
  });

  it("reuses an existing frame (node or name) and creates no node", () => {
    const { fns } = load();
    const t = makeDoc();
    const frame = t.make("hero-frame");
    frame.pictureFrameEnabled = true;
    const a = t.make("a");
    (t.doc as any).__byName = { "hero-frame": frame, a };
    const r = fns.axiClip!(t.doc, "hero-frame", "a");
    expect(t.created).toEqual([]);
    expect(r.frame).toBe(frame);
    expect(frame.children).toEqual([a]);
  });

  it("accepts a plain (non picture-frame) shape as frame", () => {
    const { fns } = load();
    const t = makeDoc();
    const plain = t.make("plain");
    const a = t.make("a");
    const r = fns.axiClip!(t.doc, plain, a);
    expect(r.frame).toBe(plain);
    expect(plain.children).toEqual([a]);
  });

  it("takes content as an array, in order, one Inside/Main move per node", () => {
    const { fns } = load();
    const t = makeDoc();
    const a = t.make("a");
    const b = t.make("b");
    fns.axiClip!(t.doc, SPEC, [a, b]);
    expect(t.moves.map((m) => m.node)).toEqual([a, b]);
    expect(t.moves.every((m) => m.type === "Inside" && m.child === "Main")).toBe(true);
  });

  it("takes content from a callback: returned array, or the selection when nothing is returned", () => {
    const { fns } = load();
    let t = makeDoc();
    const drawn: FakeNode[] = [];
    const r1 = fns.axiClip!(t.doc, SPEC, (d: any) => {
      d.addNode({ kind: "x", pictureFrameEnabled: false });
      d.addNode({ kind: "y", pictureFrameEnabled: false });
      drawn.push(...t.created.slice(1));
      return drawn;
    });
    expect(r1.nodes.length).toBe(2);
    expect(r1.frame.children.length).toBe(2);

    t = makeDoc();
    const r2 = fns.axiClip!(t.doc, SPEC, (d: any) => {
      d.addNode({ kind: "x", pictureFrameEnabled: false });
    });
    expect(r2.nodes).toEqual([t.created[1]]);
    expect(r2.frame.children).toEqual([t.created[1]]);
  });

  it("draws callback content beside the frame, not inside it", () => {
    const { fns } = load();
    const t = makeDoc();
    fns.axiClip!(t.doc, SPEC, (d: any) => {
      d.addNode({ kind: "x", pictureFrameEnabled: false });
      return d.selection.nodes.first;
    });
    const drawn = t.created[1]!;
    // it landed on the board (selection was reset out of the frame) and was moved in by axiClip
    expect(t.moves[0]!.node).toBe(drawn);
  });

  it("throws the frozen message when the move leaves the node outside", () => {
    const { fns } = load();
    const t = makeDoc({ failMove: true });
    expect(() => fns.axiClip!(t.doc, SPEC, t.make("a"))).toThrow("axiClip: cannot move a node into the frame on this Affinity build");
  });

  it("throws when a callback draws nothing", () => {
    const { fns } = load();
    const t = makeDoc();
    const draw = (d: any) => {
      Object.defineProperty(d, "selection", { get: () => ({ nodes: { first: undefined } }), set: () => {}, configurable: true });
    };
    expect(() => fns.axiClip!(t.doc, SPEC, draw)).toThrow("axiClip: draw made no node");
  });

  it("leaves the insertion point outside the frame: a shape drawn after axiClip is a sibling, not a child", () => {
    const { fns } = load();
    const t = makeDoc();
    const a = t.make("a");
    const r = fns.axiClip!(t.doc, SPEC, a);
    expect(t.state.selected[0]).toBe(t.board);
    t.doc.addNode({ kind: "later", pictureFrameEnabled: false });
    const later = t.created[t.created.length - 1]!;
    expect(later.parent).toBe(t.board);
    expect(r.frame.children).not.toContain(later);
    expect(r.frame.children).toEqual([a]);
  });

  it("proves the stub shows the gotcha: without the reset the next node would be nested", () => {
    const t = makeDoc();
    const frame = t.make("f");
    const a = t.make("a");
    t.doc.executeCommand({ node: a, frame, type: "Inside", child: "Main" });
    t.doc.addNode({ kind: "later", pictureFrameEnabled: false });
    expect(t.created[0]!.parent).toBe(frame);
  });

  it("select:true leaves the frame selected", () => {
    const { fns } = load();
    const t = makeDoc();
    const r = fns.axiClip!(t.doc, SPEC, t.make("a"), { select: true });
    expect(t.state.selected[0]).toBe(r.frame);
  });
});

describe("axiClip validation (before any require or node)", () => {
  const cases: Array<[string, unknown[], string]> = [
    ["no frame", [undefined, "a"], "axiClip: frame must be a spec"],
    ["number frame", [5, "a"], "axiClip: frame must be a spec"],
    ["bad shape", [{ ...SPEC, shape: "star" }, "a"], "axiClip: shape must be rect or ellipse"],
    ["missing x", [{ shape: "rect", y: 0, w: 5, h: 5 }, "a"], "axiClip: x, y, w and h must be numbers, w and h positive"],
    ["NaN", [{ ...SPEC, w: NaN }, "a"], "axiClip: x, y, w and h must be numbers, w and h positive"],
    ["zero w", [{ ...SPEC, w: 0 }, "a"], "axiClip: x, y, w and h must be numbers, w and h positive"],
    ["negative h", [{ ...SPEC, h: -3 }, "a"], "axiClip: x, y, w and h must be numbers, w and h positive"],
    ["no content", [SPEC, undefined], "axiClip: content must be a node, a name, an array of them or a function"],
    ["empty array", [SPEC, []], "axiClip: content must be a node, a name, an array of them or a function"],
    ["bad item", [SPEC, ["a", 3]], "axiClip: content must be a node, a name, an array of them or a function"],
  ];
  for (const [label, args, msg] of cases) {
    it(`${label}`, () => {
      const { fns, required } = load();
      const t = makeDoc();
      expect(() => fns.axiClip!(t.doc, ...args)).toThrow(msg);
      expect(required).toEqual([]);
      expect(t.created).toEqual([]);
    });
  }
});
