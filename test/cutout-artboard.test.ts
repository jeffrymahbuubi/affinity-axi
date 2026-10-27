// axiCutout artboard option (helpers-ml.ts): a tight artboard around the cut-out so
// export --artboard <name> gives a trimmed PNG. Own fake SDK: the shared ML fake has no
// artboard API.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function setup(opts: { shrinkTo: Box; docW?: number; docH?: number; existing?: string[] }) {
  const log: string[] = [];
  let box: Box = { x: 0, y: 0, w: 400, h: 300 };
  const node: any = {
    userDescription: "photo",
    isImageNode: false,
    parent: null,
    get baseBoxInterface() {
      return { baseBox: { x: box.x, y: box.y, width: box.w, height: box.h } };
    },
    transform: { applyToPoint: (p: { x: number; y: number }) => p },
  };
  const artboards: any[] = (opts.existing ?? []).map((n) => ({ description: n }));
  let sel: any = node;
  const doc: any = {
    widthPixels: opts.docW ?? 400,
    heightPixels: opts.docH ?? 300,
    artboards,
    rasterSelection: { isSelectNone: true },
    get selection() {
      return { nodes: { first: sel } };
    },
    set selection(v: any) {
      sel = v;
      log.push(`select:${v === node ? "node" : "other"}`);
    },
    removeBackground: () => {
      log.push("removeBackground");
      box = { ...opts.shrinkTo };
    },
    applyTransform: (t: { tx: number; ty: number }) => {
      log.push(`move:${t.tx},${t.ty}`);
      box = { ...box, x: box.x + t.tx, y: box.y + t.ty };
    },
    setDocumentProperties: () => log.push("transparent"),
    addArtboard: (def: any) => {
      log.push(`addArtboard:${def.x},${def.y},${def.width},${def.height}`);
      const ab: any = { node: { userDescription: "" } };
      Object.defineProperty(ab, "description", { get: () => ab.node.userDescription });
      artboards.push(ab);
      sel = ab.node;
    },
  };
  const modules: Record<string, any> = {
    "/nodes.js": { ShapeNodeDefinition: { create: (_s: unknown, r: any) => r } },
    "/shapes.js": { ShapeRectangle: { create: () => "rect" } },
    "/geometry.js": { Transform: { createTranslate: (tx: number, ty: number) => ({ tx, ty }) } },
    "/documentproperties.js": { DocumentProperties: { create: () => ({}) } },
  };
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`;
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  const h = new Function("require", body)(req) as Record<string, Fn>;
  return { doc, node, log, h, artboards };
}

const subject: Box = { x: 100, y: 80, w: 120, h: 90 };

describe("axiCutout artboard option", () => {
  it("adds an artboard over the content box plus padding, moving the layer to 0,0 when it is the first artboard", () => {
    const { doc, node, log, h, artboards } = setup({ shrinkTo: subject });
    const r = h.axiCutout!(doc, undefined, { artboard: { name: "stove", padding: 24 } });
    expect(r.node).toBe(node);
    expect(r.artboard).toEqual({ name: "stove", x: 0, y: 0, w: 168, h: 138 });
    expect(log).toContain("move:-76,-56");
    expect(log).toContain("addArtboard:0,0,168,138");
    expect(artboards[0].node.userDescription).toBe("stove");
    expect(doc.selection.nodes.first).toBe(node);
    expect(h.axiContentBox!(doc, node)).toEqual({ x: 24, y: 24, w: 120, h: 90 });
  });

  it("clamps the box to the document", () => {
    const { doc, log, h } = setup({ shrinkTo: { x: 10, y: 5, w: 380, h: 290 } });
    const r = h.axiCutout!(doc, undefined, { artboard: { name: "a", padding: 50 } });
    expect(r.artboard).toEqual({ name: "a", x: 0, y: 0, w: 400, h: 300 });
    expect(log.some((l) => l.startsWith("move:"))).toBe(false);
  });

  it("padding defaults to 0", () => {
    const { doc, h } = setup({ shrinkTo: subject });
    expect(h.axiCutout!(doc, undefined, { artboard: { name: "a" } }).artboard).toMatchObject({ w: 120, h: 90 });
  });

  it("keeps the box in place when the document already has an artboard", () => {
    const { doc, log, h } = setup({ shrinkTo: subject, existing: ["page"] });
    const r = h.axiCutout!(doc, undefined, { artboard: { name: "stove", padding: 10 } });
    expect(r.artboard).toEqual({ name: "stove", x: 90, y: 70, w: 140, h: 110 });
    expect(log.some((l) => l.startsWith("move:"))).toBe(false);
    expect(log).toContain("addArtboard:90,70,140,110");
  });

  it("requires a name, a valid padding and a free name, before any SDK call", () => {
    for (const [artboard, re] of [
      [{}, /artboard needs a name/],
      [{ name: "" }, /artboard needs a name/],
      [null, /artboard needs a name/],
      [{ name: "a", padding: -1 }, /padding must be a finite number of 0 or more/],
      [{ name: "a", padding: "x" }, /padding must be a finite number of 0 or more/],
    ] as const) {
      const { doc, log, h } = setup({ shrinkTo: subject });
      expect(() => h.axiCutout!(doc, undefined, { artboard })).toThrow(re);
      expect(log).toEqual([]);
    }
    const { doc, log, h } = setup({ shrinkTo: subject, existing: ["stove"] });
    expect(() => h.axiCutout!(doc, undefined, { artboard: { name: "stove" } })).toThrow(/an artboard named stove already exists/);
    expect(log).toEqual([]);
  });

  it("throws when the cut-out has no visible content", () => {
    const { doc, h } = setup({ shrinkTo: { x: 0, y: 0, w: 0, h: 0 } });
    expect(() => h.axiCutout!(doc, undefined, { artboard: { name: "a" } })).toThrow(/no visible content/);
  });

  it("without the option it returns the bare node and adds no artboard", () => {
    const { doc, node, log, h, artboards } = setup({ shrinkTo: subject });
    expect(h.axiCutout!(doc, undefined, {})).toBe(node);
    expect(artboards).toEqual([]);
    expect(log.some((l) => l.startsWith("addArtboard") || l.startsWith("move:"))).toBe(false);
  });
});
