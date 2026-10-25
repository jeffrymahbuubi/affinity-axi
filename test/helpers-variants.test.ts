// The multi-size helpers: source hygiene, the pure placement maths
// (axiBoardScale), axiVariants and axiAdapt against stubbed boards, and axiClone
// against a fake command set. The source is evaluated in plain Node; the real
// re-parenting is checked live (test/live/clone-probe.js).

import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { VARIANTS_INDEX, VARIANTS_INTERNAL, VARIANTS_SOURCE } from "../src/affinity/helpers-variants.js";

type Fn = (...a: any[]) => any;

// Before the lead splices this family into HELPERS_SOURCE it is appended here; after, it is already there.
const SOURCE = HELPERS_SOURCE.includes(VARIANTS_SOURCE) ? HELPERS_SOURCE : HELPERS_SOURCE + VARIANTS_SOURCE;

/** Evaluates the helpers plus this family; `extra` runs in the same scope (to stub declarations). */
function load(extra = "", req: (id: string) => any = () => {
  throw new Error("SDK not available in tests");
}): Record<string, Fn> {
  const names = [...SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${SOURCE}\n${extra}\nreturn { ${names.join(", ")} };`;
  return new Function("require", body)(req) as Record<string, Fn>;
}

describe("VARIANTS_SOURCE hygiene", () => {
  it("passes the blocking and AI guards and parses", () => {
    expect(scanForBlocking(VARIANTS_SOURCE)).toEqual([]);
    expect(scanForAi(VARIANTS_SOURCE)).toEqual([]);
    expect(() => new Function(SOURCE)).not.toThrow();
  });

  it("uses function declarations only, all prefixed axi, requires inside functions", () => {
    const top = VARIANTS_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const line of top) expect(line).toMatch(/^function axi[A-Z]\w*\(/);
    for (const line of VARIANTS_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
    expect(VARIANTS_SOURCE).not.toContain("${");
    expect(VARIANTS_SOURCE).not.toContain("`");
  });

  it("declares exactly the indexed helpers plus the internal ones", () => {
    const declared = [...VARIANTS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    for (const h of VARIANTS_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !VARIANTS_INDEX.some((h) => h.name === n)).sort()).toEqual([...VARIANTS_INTERNAL].sort());
    expect([...VARIANTS_INTERNAL]).toEqual(["axiClone", "axiBoardScale"]);
  });

  it("does not collide with the names of the other families", () => {
    const declared = [...VARIANTS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    for (const n of declared) expect(SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });
});

describe("axiVariants", () => {
  const boardsOut = [
    { name: "ig-square", x: 0, y: 0, w: 1080, h: 1080 },
    { name: "story", x: 1180, y: 0, w: 1080, h: 1920 },
    { name: "og", x: 2360, y: 0, w: 1200, h: 630 },
  ];
  const h = load(`
    axiArtboards = function (doc, specs, o) { doc.log.push('artboards:' + JSON.stringify(o)); return doc.boards; };
    axiOn = function (doc, name) { doc.log.push('on:' + name); };
  `);

  it("calls draw once per board, in order, with axiOn first, and returns s per board", () => {
    const log: string[] = [];
    const doc = { log, boards: boardsOut };
    const seen: any[] = [];
    const r = h.axiVariants(doc, [{ platform: "ig-square" }, { platform: "story" }, { platform: "og" }], (b: any) => {
      log.push("draw:" + b.name);
      seen.push(b);
    }, { gap: 100 });
    expect(log).toEqual(['artboards:{"gap":100}', "on:ig-square", "draw:ig-square", "on:story", "draw:story", "on:og", "draw:og"]);
    expect(r.map((b: any) => b.name)).toEqual(["ig-square", "story", "og"]);
    expect(r.map((b: any) => b.s)).toEqual([1, 1, 630 / 1080]);
    expect(seen[1]).toMatchObject({ name: "story", x: 1180, y: 0, w: 1080, h: 1920, s: 1 });
  });

  it("rejects bad input before touching the document", () => {
    const doc = { log: [] as string[], boards: boardsOut };
    expect(() => h.axiVariants(doc, [], () => {})).toThrow(/specs must be a non-empty array/);
    expect(() => h.axiVariants(doc, "story", () => {})).toThrow(/specs must be a non-empty array/);
    expect(() => h.axiVariants(doc, [{ platform: "story" }], undefined)).toThrow(/draw must be a function/);
    expect(() => h.axiVariants(doc, [{ platform: "story" }], "nope")).toThrow(/draw must be a function/);
    expect(doc.log).toEqual([]);
  });
});

describe("axiBoardScale", () => {
  const M = { w: 1080, h: 1080 };
  const story = { w: 1080, h: 1920 };
  const og = { w: 1200, h: 630 };
  const scale = h0().axiBoardScale;

  function h0() {
    return load();
  }
  const at = (n: Record<string, unknown>, t: { w: number; h: number }, mode?: string) => scale(M, n, t, mode);

  it("stretches a full-bleed background to the whole target on both axes", () => {
    const r = at({ x: 0, y: 0, w: 1080, h: 1080 }, story);
    expect(r.box).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(r.sx).toBe(1);
    expect(r.sy).toBeCloseTo(1920 / 1080, 10);
    const o = at({ x: 0, y: 0, w: 1080, h: 1080 }, og);
    expect(o.box).toEqual({ x: 0, y: 0, w: 1200, h: 630 });
    expect(o.clamped).toBe(false);
  });

  it("keeps a top-left logo's distance from the left and top edges", () => {
    for (const t of [story, og]) {
      const r = at({ x: 60, y: 60, w: 200, h: 80 }, t);
      expect(r).toMatchObject({ sx: 1, sy: 1, dx: 0, dy: 0, clamped: false });
      expect(r.box).toEqual({ x: 60, y: 60, w: 200, h: 80 });
    }
  });

  it("keeps a bottom CTA's distance from the bottom edge", () => {
    const cta = { x: 60, y: 900, w: 400, h: 100 }; // 80 px above the bottom of the master
    const s = at(cta, story);
    expect(s.box.y).toBe(1920 - 100 - 80);
    expect(s.dy).toBe(1740 - 900);
    expect(s.box.x).toBe(60);
    const o = at(cta, og);
    expect(o.box.y).toBe(630 - 100 - 80);
    expect(o).toMatchObject({ sx: 1, sy: 1, clamped: false });
  });

  it("keeps a node in the last third at its right-edge distance", () => {
    const r = at({ x: 900, y: 60, w: 150, h: 150 }, og); // 30 px from the right
    expect(r.box.x).toBe(1200 - 150 - 30);
    expect(r.box.x).toBe(1020);
    expect(r.box.y).toBe(60);
  });

  it("keeps a centred headline centred, stretching a wide non-text node and keeping text size", () => {
    const wide = { x: 140, y: 480, w: 800, h: 120 }; // spans 0.74 of the width
    const r = at(wide, story);
    expect(r.box.y + r.box.h / 2).toBeCloseTo(960, 10);
    expect(r.box.x + r.box.w / 2).toBeCloseTo(540, 10);
    const o = at(wide, og);
    expect(o.box).toEqual({ x: 140, y: 315 - 60, w: 920, h: 120 }); // stretched, both 140 px gaps kept
    expect(o.sx).toBeCloseTo(920 / 800, 10);
    const t = at({ ...wide, rigid: true }, og); // text frames keep their size and stay centred
    expect(t.sx).toBe(1);
    expect(t.box).toEqual({ x: 200, y: 255, w: 800, h: 120 });
  });

  it("keeps a middle-third node at the same fraction of the target", () => {
    const r = at({ x: 400, y: 380, w: 280, h: 100 }, story); // centre fraction 0.5 / 0.4
    expect(r.box.x + r.box.w / 2).toBeCloseTo(540, 10);
    expect(r.box.y + r.box.h / 2).toBeCloseTo((430 / 1080) * 1920, 10);
  });

  it("pushes a node that cannot fit back inside and flags it", () => {
    const tall = { x: 300, y: 190, w: 400, h: 700 }; // a middle-third node, taller than the 630 board
    const r = at(tall, og);
    expect(r.clamped).toBe(true);
    expect(r.box.y).toBeCloseTo((630 - 700) / 2, 10); // centred, overflows both sides equally
    expect(r.sy).toBe(1);
    const far = at({ x: 60, y: 900, w: 400, h: 100 }, { w: 1080, h: 150 }); // far-pinned, board too short
    expect(far.clamped).toBe(true);
    expect(far.box.y).toBeGreaterThanOrEqual(0);
    expect(far.box.y + far.box.h).toBeLessThanOrEqual(150);
  });

  it("fit returns one uniform scale and centring offsets", () => {
    const k = Math.min(1200 / 1080, 630 / 1080);
    const r = at({ x: 0, y: 0, w: 1080, h: 1080 }, og, "fit");
    expect(r.sx).toBeCloseTo(k, 10);
    expect(r.sy).toBeCloseTo(k, 10);
    expect(r.box.x).toBeCloseTo((1200 - 1080 * k) / 2, 10);
    expect(r.box.y).toBeCloseTo(0, 10);
    expect(r.box.w).toBeCloseTo(1080 * k, 10);
    expect(r.clamped).toBe(false);
  });

  it("cover scales by the larger ratio", () => {
    const k = Math.max(1200 / 1080, 630 / 1080);
    const r = at({ x: 0, y: 0, w: 1080, h: 1080 }, og, "cover");
    expect(r.sx).toBeCloseTo(k, 10);
    expect(r.box.w).toBeCloseTo(1200, 10);
    expect(r.box.y).toBeCloseTo((630 - 1080 * k) / 2, 10);
  });

  it("defaults to anchor when the mode is omitted and rejects unknown modes and bad boxes", () => {
    const n = { x: 900, y: 60, w: 150, h: 150 };
    expect(scale(M, n, og)).toEqual(scale(M, n, og, "anchor"));
    expect(scale(M, n, og, undefined).box.x).toBe(1020);
    expect(() => scale(M, n, og, "stretch")).toThrow(/mode must be anchor, fit or cover/);
    expect(() => scale({ w: 0, h: 10 }, n, og)).toThrow(/positive w and h/);
    expect(() => scale(M, { x: 1, y: 2 }, og)).toThrow(/nodeBox needs/);
  });
});

/** A real affine transform (column vectors, multiply = this x other) standing in for the SDK's. */
class FakeTransform {
  constructor(public m: number[] = [1, 0, 0, 1, 0, 0]) {}
  static createIdentity() {
    return new FakeTransform();
  }
  static createTranslate(x: number, y: number) {
    return new FakeTransform([1, 0, 0, 1, x, y]);
  }
  static createScale(x: number, y = x) {
    return new FakeTransform([x, 0, 0, y, 0, 0]);
  }
  multiply(o: FakeTransform) {
    const [a, b, c, d, e, f] = this.m as [number, number, number, number, number, number];
    const [A, B, C, D, E, F] = o.m as [number, number, number, number, number, number];
    return new FakeTransform([a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f]);
  }
  applyToPoint(p: { x: number; y: number }) {
    const [a, b, c, d, e, f] = this.m as [number, number, number, number, number, number];
    return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
  }
}

function fakeNode(name: string, box: { x: number; y: number; w: number; h: number }, text?: string) {
  const n: any = {
    userDescription: name,
    text,
    box,
    getSpreadBaseBox: () => ({ x: box.x, y: box.y, width: box.w, height: box.h }),
    children: [],
  };
  return n;
}

describe("axiAdapt", () => {
  function setup(extra = "") {
    const bg = fakeNode("bg", { x: 0, y: 0, w: 1080, h: 1080 });
    const logo = fakeNode("logo", { x: 60, y: 60, w: 200, h: 80 });
    const headline = fakeNode("headline", { x: 140, y: 480, w: 800, h: 120 }, "Hello");
    const cta = fakeNode("cta", { x: 60, y: 900, w: 400, h: 100 });
    const stray = fakeNode("", { x: 10, y: 10, w: 20, h: 20 });
    const band = fakeNode("axi-safe-zone", { x: 0, y: 0, w: 1080, h: 250 });
    const master = { description: "ig-square", spreadBaseBox: { x: 0, y: 0, width: 1080, height: 1080 }, node: { children: [bg, logo, headline, cta, stray, band] } };
    const doc: any = { artboards: [master], log: [] as any[] };
    const h = load(
      `
      axiArtboards = function (doc, specs, o) {
        doc.log.push(['boards', specs.length, o && o.gap]);
        let x = 1180;
        return specs.map(function (s) {
          const p = axiPlatform(s.platform);
          const r = { name: s.name || p.key, x: x, y: 0, w: p.w, h: p.h };
          doc.artboards.push({ description: r.name, spreadBaseBox: { x: r.x, y: 0, width: r.w, height: r.h }, node: { id: r.name, children: [] } });
          x += p.w + 100;
          return r;
        });
      };
      axiClone = function (doc, node, target, xf) {
        const copy = { userDescription: node.userDescription, xf: xf, target: target.id, from: node };
        doc.log.push(['clone', node.userDescription, target.id]);
        return copy;
      };
      ${extra}
    `,
      (id: string) => {
        if (id === "/geometry.js") return { Transform: FakeTransform };
        throw new Error("no " + id);
      },
    );
    return { h, doc, nodes: { bg, logo, headline, cta, stray }, master };
  }

  it("validates before adding any board", () => {
    const { h, doc } = setup();
    expect(() => h.axiAdapt(doc, "nope", [{ platform: "story" }])).toThrow();
    expect(() => h.axiAdapt(doc, "ig-square", [])).toThrow(/specs must be a non-empty array/);
    expect(() => h.axiAdapt(doc, "ig-square", "story")).toThrow(/specs must be a non-empty array/);
    expect(() => h.axiAdapt(doc, "", [{ platform: "story" }])).toThrow(/master .* is required/);
    expect(() => h.axiAdapt(doc, "ig-square", [{ platform: "story" }], { mode: "stretch" })).toThrow(/mode must be anchor, fit or cover/);
    expect(() => h.axiAdapt(doc, "ig-square", [{ platform: "story" }, { platform: "story" }])).toThrow(/already exists or is listed twice/);
    expect(() => h.axiAdapt(doc, "ig-square", [{ platform: "ig-square" }])).toThrow(/already exists or is listed twice/);
    expect(() => h.axiAdapt(doc, "ig-square", [{ w: 10, h: 10 }])).toThrow(/platform or a name/);
    expect(doc.log).toEqual([]);
    expect(doc.artboards).toHaveLength(1);
  });

  it("clones every child but the safe-zone bands, in order, once per board", () => {
    const { h, doc } = setup();
    const r = h.axiAdapt(doc, "ig-square", [{ platform: "story" }, { platform: "og" }], { gap: 60 });
    expect(doc.log[0]).toEqual(["boards", 2, 60]);
    expect(doc.log.slice(1).map((c: any[]) => c.slice(1).join("@"))).toEqual([
      "bg@story", "logo@story", "headline@story", "cta@story", "@story",
      "bg@og", "logo@og", "headline@og", "cta@og", "@og",
    ]);
    expect(r.map((b: any) => [b.name, b.w, b.h, b.nodes])).toEqual([["story", 1080, 1920, 5], ["og", 1200, 630, 5]]);
  });

  it("names copies name@board and leaves unnamed ones unnamed", () => {
    const { h, doc } = setup(`
      axiClone = function (doc, node, target, xf) { const c = { userDescription: node.userDescription, xf: xf, id: target.id }; (doc.copies = doc.copies || []).push(c); return c; };
    `);
    h.axiAdapt(doc, "ig-square", [{ platform: "story" }]);
    expect(doc.copies.map((c: any) => c.userDescription)).toEqual(["bg@story", "logo@story", "headline@story", "cta@story", ""]);
  });

  it("sends each copy a transform that scales about its top-left and lands it on the board", () => {
    const { h, doc } = setup(`
      axiClone = function (doc, node, target, xf) { const c = { userDescription: node.userDescription, xf: xf, id: target.id }; (doc.copies = doc.copies || []).push(c); return c; };
    `);
    h.axiAdapt(doc, "ig-square", [{ platform: "story" }]);
    const by = Object.fromEntries(doc.copies.map((c: any) => [c.userDescription.split("@")[0], c.xf]));
    // story board origin is x=1180, y=0
    expect(by["bg"].applyToPoint({ x: 0, y: 0 })).toEqual({ x: 1180, y: 0 });
    expect(by["bg"].applyToPoint({ x: 1080, y: 1080 })).toEqual({ x: 1180 + 1080, y: 1920 });
    expect(by["logo"].applyToPoint({ x: 60, y: 60 })).toEqual({ x: 1180 + 60, y: 60 });
    expect(by["logo"].applyToPoint({ x: 260, y: 140 })).toEqual({ x: 1180 + 260, y: 140 });
    expect(by["cta"].applyToPoint({ x: 60, y: 900 })).toEqual({ x: 1180 + 60, y: 1740 });
    // the text frame keeps its width and is centred vertically
    expect(by["headline"].applyToPoint({ x: 140, y: 480 })).toEqual({ x: 1180 + 140, y: 900 });
    expect(by["headline"].applyToPoint({ x: 940, y: 600 })).toEqual({ x: 1180 + 940, y: 1020 });
  });

  it("reports nodes pushed back inside under clamped, by their new name", () => {
    const { h, doc, master } = setup();
    master.node.children.push(fakeNode("tall", { x: 300, y: 190, w: 400, h: 700 }));
    const r = h.axiAdapt(doc, "ig-square", [{ platform: "story" }, { platform: "og" }]);
    expect(r[0].clamped).toEqual([]);
    expect(r[1].clamped).toEqual(["tall@og"]);
  });

  it("fit mode scales uniformly and reports the real scale", () => {
    const { h, doc } = setup(`
      axiClone = function (doc, node, target, xf) { const c = { userDescription: node.userDescription, xf: xf }; (doc.copies = doc.copies || []).push(c); return c; };
    `);
    const r = h.axiAdapt(doc, "ig-square", [{ platform: "og" }], { mode: "fit" });
    const k = 630 / 1080;
    expect(r[0].s).toBeCloseTo(k, 10);
    const bg = doc.copies[0].xf;
    const a = bg.applyToPoint({ x: 0, y: 0 });
    const b = bg.applyToPoint({ x: 1080, y: 1080 });
    expect(b.x - a.x).toBeCloseTo(1080 * k, 8);
    expect(b.y - a.y).toBeCloseTo(630, 8);
    expect(r[0].clamped).toEqual([]);
  });
});

describe("axiClone", () => {
  const MoveNodes = (sel: unknown, target: unknown, type: string, child: string) => ({ sel, target, type, child });
  const req = (id: string) => {
    if (id === "/commands.js") {
      return {
        DocumentCommand: { createMoveNodes: MoveNodes },
        NodeMoveType: { Inside: "Inside", After: "After" },
        NodeChildType: { Main: "Main" },
      };
    }
    if (id === "/geometry.js") return { Transform: FakeTransform };
    throw new Error("no " + id);
  };
  const h = load("", req);

  function world(opts: { moves?: boolean; throws?: boolean } = {}) {
    const target: any = { children: [] as any[] };
    const log: string[] = [];
    const copy: any = { userDescription: "logo", selfSelection: "SEL", delete: () => log.push("deleted") };
    const node: any = {
      duplicate: (xf: unknown) => {
        log.push("duplicate:" + (xf instanceof FakeTransform ? xf.m.join(",") : String(xf)));
        return copy;
      },
    };
    const doc: any = {
      executeCommand: (cmd: any) => {
        log.push(`move:${cmd.type}:${cmd.child}:${cmd.sel}`);
        if (opts.throws) throw new Error("no such command");
        if (opts.moves !== false) target.children.push(copy);
      },
    };
    return { target, log, copy, node, doc };
  }

  it("duplicates with the transform, then moves the copy inside the target", () => {
    const w = world();
    const xf = FakeTransform.createTranslate(10, 20);
    const r = h.axiClone(w.doc, w.node, w.target, xf);
    expect(r).toBe(w.copy);
    expect(w.log).toEqual(["duplicate:1,0,0,1,10,20", "move:Inside:Main:SEL"]);
    expect(w.target.children).toEqual([w.copy]);
  });

  it("uses the identity when no transform is given and restores the node's own name", () => {
    const w = world();
    h.axiClone(w.doc, w.node, w.target);
    expect(w.log[0]).toBe("duplicate:1,0,0,1,0,0");
    expect(w.copy.userDescription).toBe("logo");
  });

  it("throws the pointer to axiVariants and deletes the stray copy when the move fails", () => {
    const w = world({ throws: true });
    expect(() => h.axiClone(w.doc, w.node, w.target, FakeTransform.createTranslate(1, 1))).toThrow(
      /axiClone: cannot move a copy into another artboard on this Affinity build; use axiVariants\(doc, specs, draw\) \[no such command\]/,
    );
    expect(w.log).toContain("deleted");
  });

  it("also fails when the command succeeds but the copy is not inside the target", () => {
    const w = world({ moves: false });
    expect(() => h.axiClone(w.doc, w.node, w.target, FakeTransform.createTranslate(1, 1))).toThrow(/use axiVariants/);
    expect(w.log).toContain("deleted");
  });

  it("rejects a non-node and a non-artboard target before any SDK call", () => {
    const w = world();
    expect(() => h.axiClone(w.doc, {}, w.target)).toThrow(/node must be a document node/);
    expect(() => h.axiClone(w.doc, w.node, {})).toThrow(/target must be an artboard node/);
    expect(w.log).toEqual([]);
  });
});
