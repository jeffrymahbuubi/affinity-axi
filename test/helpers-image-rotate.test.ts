// axiImage / axiReplaceImage rotate and mirror: the helper block is evaluated in plain Node with
// stub SDK modules and a fake document that logs every call. No Affinity.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

type Fn = (...a: any[]) => any;

function chain(s: string): any {
  return { s, multiply: (o: { s: string }) => chain(`${s}.${o.s}`), toString: () => s };
}

interface Rig {
  log: string[];
  fns: Record<string, Fn>;
  doc: any;
  old: any;
}

/** rasterSize: the old node's pixel size when it is a pixel layer (null: an image node). */
function rig(rasterSize: { w: number; h: number } | null = null): Rig {
  const log: string[] = [];
  const box = { x: 0, y: 0, width: 100, height: 50 };
  const mk = (extra: Record<string, unknown>): any => ({
    baseBoxInterface: { baseBox: box },
    transform: { applyToPoint: (p: { x: number; y: number }) => p },
    userDescription: "photo",
    parent: null,
    ...extra,
  });
  const old = mk(rasterSize ? { isRasterNode: true, rasterWidth: rasterSize.w, rasterHeight: rasterSize.h } : { isImageNode: true });
  let sel: any = old;
  const doc: any = {
    get selection() {
      return { nodes: { first: sel } };
    },
    set selection(v: any) {
      sel = v;
    },
    addNode: () => {
      log.push("addNode");
      sel = mk({ isImageNode: true });
    },
    deleteSelection: () => log.push("deleteSelection"),
    executeCommand: (c: string) => {
      log.push(`exec:${c}`);
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
      DocumentCommand: { createReplaceBitmap: () => "cmd:replaceBitmap" },
      AddChildNodesCommandBuilder: { create: () => ({}) },
      InsertionMode: {},
      NodeChildType: {},
    },
  };
  const req = (id: string) => {
    log.push(`require:${id}`);
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  const fns = new Function("require", `${HELPERS_SOURCE}\nreturn { axiImage, axiReplaceImage };`)(req) as Record<string, Fn>;
  return { log, fns, doc, old };
}

const transforms = (log: string[]): string[] => log.filter((l) => l.startsWith("applyTransform:")).map((l) => l.slice("applyTransform:".length));
const PI2 = String(Math.PI / 2);

describe("axiImage rotate and mirror", () => {
  it("rotate 90 turns about the centre before the fit transforms", () => {
    const r = rig();
    r.fns["axiImage"]!(r.doc, { path: "/x.jpg", x: 10, y: 20, w: 100, h: 50, raster: false, rotate: 90 });
    expect(transforms(r.log)).toEqual([`T(50,25).R(${PI2}).T(-50,-25)`, "T(0,0)", "T(10,20)"]);
  });

  it("mirror alone flips about the centre first, and goes before rotate when both are given", () => {
    const a = rig();
    a.fns["axiImage"]!(a.doc, { path: "/x.jpg", w: 100, h: 50, raster: false, mirror: true });
    expect(transforms(a.log)[0]).toBe("T(50,25).S(-1,1).T(-50,-25)");
    const b = rig();
    b.fns["axiImage"]!(b.doc, { path: "/x.jpg", w: 100, h: 50, raster: false, rotate: 270, mirror: true });
    expect(transforms(b.log)[0]).toBe(`T(50,25).R(${(270 * Math.PI) / 180}).S(-1,1).T(-50,-25)`);
  });

  it("no rotate or mirror (or rotate 0) adds no turn transform", () => {
    const a = rig();
    a.fns["axiImage"]!(a.doc, { path: "/x.jpg", w: 100, h: 50, raster: false });
    const b = rig();
    b.fns["axiImage"]!(b.doc, { path: "/x.jpg", w: 100, h: 50, raster: false, rotate: 0, mirror: false });
    expect(transforms(a.log)).toEqual(["T(0,0)", "T(0,0)"]);
    expect(transforms(b.log)).toEqual(transforms(a.log));
  });

  it("rejects a bad rotate or mirror before any SDK call", () => {
    for (const bad of [{ rotate: 45 }, { rotate: "90" }, { rotate: -90 }, { mirror: "yes" }, { mirror: 1 }]) {
      const r = rig();
      expect(() => r.fns["axiImage"]!(r.doc, { path: "/x.jpg", w: 100, h: 50, ...bad })).toThrow(/axiImage: (rotate must be 0, 90, 180 or 270|mirror must be true or false)/);
      expect(r.log).toEqual([]);
    }
  });
});

describe("axiReplaceImage rotate and mirror", () => {
  it("a pixel layer of the same size is swapped in place without rotate", () => {
    const r = rig({ w: 100, h: 50 });
    r.fns["axiReplaceImage"]!(r.doc, r.old, "/y.jpg", { raster: false });
    expect(r.log).toContain("exec:cmd:replaceBitmap");
    expect(r.log).not.toContain("addNode");
  });

  it("rotate 180 never calls createReplaceBitmap: the picture is re-placed turned", () => {
    const r = rig({ w: 100, h: 50 });
    r.fns["axiReplaceImage"]!(r.doc, r.old, "/y.jpg", { raster: false, rotate: 180 });
    expect(r.log).not.toContain("exec:cmd:replaceBitmap");
    expect(r.log).toContain("deleteSelection");
    expect(r.log).toContain("addNode");
    expect(transforms(r.log)[0]).toBe(`T(50,25).R(${Math.PI}).T(-50,-25)`);
  });

  it("mirror also forces the re-place, and a bad value throws before anything is loaded", () => {
    const a = rig({ w: 100, h: 50 });
    a.fns["axiReplaceImage"]!(a.doc, a.old, "/y.jpg", { raster: false, mirror: true });
    expect(a.log).not.toContain("exec:cmd:replaceBitmap");
    expect(transforms(a.log)[0]).toBe("T(50,25).S(-1,1).T(-50,-25)");
    const b = rig({ w: 100, h: 50 });
    expect(() => b.fns["axiReplaceImage"]!(b.doc, b.old, "/y.jpg", { rotate: 91 })).toThrow(/axiReplaceImage: rotate must be 0, 90, 180 or 270/);
    expect(b.log.filter((l) => !l.startsWith("require:"))).toEqual([]);
  });
});
