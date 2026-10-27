// axiImage without a frame lands in the artboard that holds the selection: the helper block is
// evaluated in plain Node with stub SDK modules and a fake document that logs every call.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

function chain(s: string): any {
  return { s, multiply: (o: { s: string }) => chain(`${s}.${o.s}`), toString: () => s };
}

function mk(name: string, extra: Record<string, unknown> = {}): any {
  return {
    baseBoxInterface: { baseBox: { x: 0, y: 0, width: 100, height: 50 } },
    transform: { applyToPoint: (p: { x: number; y: number }) => p },
    userDescription: name,
    parent: null,
    ...extra,
  };
}

/** selected: the node the selection starts on. */
function rig(selected: any) {
  const log: string[] = [];
  let sel: any = selected;
  const doc: any = {
    get selection() {
      return { nodes: { first: sel } };
    },
    set selection(v: any) {
      sel = v;
    },
    addNode: () => {
      log.push("addNode");
      sel = mk("img", { isImageNode: true });
    },
    executeCommand: (c: any) => {
      log.push(`exec:${c.target.userDescription}:${c.mode}`);
      sel = mk("img", { isImageNode: true, parent: c.target });
    },
    applyTransform: (xf: unknown) => log.push(`applyTransform:${xf}`),
    rasteriseObjects: () => log.push("rasteriseObjects"),
  };
  const modules: Record<string, unknown> = {
    "/nodes.js": { ImageNodeDefinition: { create: () => ({}) } },
    "/rasterobject.js": {
      Bitmap: { loadFromFile: () => ({ width: 100, height: 50 }) },
      RasterFormat: { RGBA8: "RGBA8" },
    },
    "/geometry.js": {
      Transform: {
        createTranslate: (x: number, y: number) => chain(`T(${x},${y})`),
        createScale: (x: number, y: number) => chain(`S(${x},${y})`),
        createRotate: (r: number) => chain(`R(${r})`),
      },
    },
    "/commands.js": {
      AddChildNodesCommandBuilder: {
        create: () => {
          const st: any = {};
          return {
            setInsertionTarget: (t: any) => (st.target = t),
            setInsertionMode: (m: any) => (st.mode = m),
            addNode: () => undefined,
            createCommand: () => ({ target: st.target, mode: st.mode }),
          };
        },
      },
      InsertionMode: { Inside_AtFront: "front" },
      NodeChildType: { Main: "main" },
    },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  const fns = new Function("require", `${HELPERS_SOURCE}\nreturn { axiImage };`)(req) as Record<string, Fn>;
  return { log, fns, doc };
}

const place = (r: ReturnType<typeof rig>) => r.fns["axiImage"]!(r.doc, { path: "/home/x/a.jpg", w: 100, h: 50, raster: false });

describe("axiImage artboard parent", () => {
  it("a selected artboard becomes the insertion target of a bare image", () => {
    const board = mk("board-2", { isArtboardEnabled: true });
    const r = rig(board);
    const img = place(r);
    expect(r.log).toContain("exec:board-2:front");
    expect(r.log).not.toContain("addNode");
    expect(img.parent).toBe(board);
  });

  it("a node inside an artboard resolves to that artboard", () => {
    const board = mk("board-3", { isArtboardEnabled: true });
    const r = rig(mk("shape", { parent: board }));
    expect(place(r).parent).toBe(board);
    expect(r.log).not.toContain("addNode");
  });

  it("with no artboard above the selection it falls back to addNode", () => {
    const r = rig(mk("loose", { parent: mk("group") }));
    place(r);
    expect(r.log).toContain("addNode");
    expect(r.log.some((l) => l.startsWith("exec:"))).toBe(false);
  });

  it("a read of isArtboardEnabled that throws counts as no artboard", () => {
    const bad = mk("bad");
    Object.defineProperty(bad, "isArtboardEnabled", {
      get() {
        throw new Error("unreadable");
      },
    });
    const r = rig(bad);
    place(r);
    expect(r.log).toContain("addNode");
  });
});
