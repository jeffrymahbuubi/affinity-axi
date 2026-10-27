// axiFilter, axiAuto, axiSelectRect, axiSelectPolygon and the axiGrade filter keys
// and replace option. The helper source is evaluated in plain Node with a fake
// `require` that returns stub SDK modules and a fake document that logs every call.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS } from "../src/affinity/helpers.js";
import { FILTER_INDEX, FILTER_INTERNAL } from "../src/affinity/helpers-filter.js";

type Fn = (...a: any[]) => any;
type Log = string[];

/** A fake child node: only what the helpers read (a toStringTag and an id). */
function child(tag: string, id: string): any {
  return { [Symbol.toStringTag]: tag, id, isImageNode: false, isRasterNode: false };
}

function makeTarget(children: any[] = []): any {
  return { isRasterNode: true, isImageNode: false, id: "target", children };
}

function setup(): { h: Record<string, Fn>; log: Log; doc: any } {
  const log: Log = [];
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`;
  const adj = (name: string) => ({ create: (p?: unknown) => ({ kind: name, p }) });
  const params = (name: string) => ({ create: () => ({ __params: name }) });
  const N: Record<string, unknown> = {
    DenoiseFilterParameters: params("Denoise"),
    DenoiseFilterRasterNodeDefinition: adj("Denoise"),
    ClarityFilterParameters: params("Clarity"),
    ClarityFilterRasterNodeDefinition: adj("Clarity"),
    UnsharpMaskFilterParameters: params("UnsharpMask"),
    UnsharpMaskFilterRasterNodeDefinition: adj("UnsharpMask"),
    VignetteFilterParameters: params("Vignette"),
    VignetteFilterRasterNodeDefinition: adj("Vignette"),
    VibranceAdjustmentParameters: params("Vibrance"),
    VibranceAdjustmentRasterNodeDefinition: adj("Vibrance"),
    ExposureAdjustmentParameters: params("Exposure"),
    ExposureAdjustmentRasterNodeDefinition: adj("Exposure"),
  };
  const cmd = (name: string) => () => (log.push(`cmd:${name}`), `cmd:${name}`);
  const modules: Record<string, unknown> = {
    "/nodes.js": N,
    "/commands.js": {
      AddChildNodesCommandBuilder: {
        create: () => {
          let def: any = null;
          return {
            setInsertionTarget: () => {},
            setInsertionMode: () => {},
            addNode: (d: unknown) => {
              def = d;
            },
            createCommand: () => ({ added: def }),
          };
        },
      },
      InsertionMode: { Inside_AtFront: "front" },
      NodeChildType: { Main: "main" },
      DocumentCommand: {
        createRasterAutoWhiteBalance: cmd("autoWhiteBalance"),
        createRasterAutoLevels: cmd("autoLevels"),
        createRasterAutoContrast: cmd("autoContrast"),
        createRasterAutoColours: cmd("autoColours"),
        createDeleteSelection: (sel: any, flag: boolean) => (log.push(`delete:${sel.node.id}:${flag}`), `cmd:delete:${sel.node.id}`),
      },
      RasterSelectionLogicalOperation: { New: "op:New", Add: "op:Add", Subtract: "op:Subtract", Intersect: "op:Intersect" },
    },
    "/selections.js": { Selection: { create: (_d: unknown, n: any) => ({ node: n }) } },
    "/geometry.js": {
      Rectangle: class {
        constructor(
          public x: number,
          public y: number,
          public w: number,
          public h: number,
        ) {}
      },
      Polygon: {
        createRectangle: (r: any) => ({ rect: [r.x, r.y, r.w, r.h] }),
        create: () => {
          const pts: Array<[number, number]> = [];
          return { pts, addPoint: (p: { x: number; y: number }) => pts.push([p.x, p.y]) };
        },
      },
      Spline: { createFromPoints: (p: unknown) => p },
    },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  const h = new Function("require", body)(req) as Record<string, Fn>;
  const doc: any = {
    selection: { nodes: { first: null } },
    colourProfile: { colourSpace: "srgb" },
    executeCommand: (c: any) => {
      if (c && c.added) log.push(`add:${c.added.kind}:${JSON.stringify(c.added.p)}`);
      else log.push(`exec:${String(c)}`);
    },
    setRasterSelectionFromPolygon: (poly: unknown, op: string, aa: boolean, feather: number) => log.push(`select:${JSON.stringify(poly)}:${op}:${aa}:${feather}`),
  };
  return { h, log, doc };
}

describe("registration", () => {
  it("indexes the four helpers once and lists the internals", () => {
    for (const row of FILTER_INDEX) {
      expect(HELPER_INDEX.filter((r) => r.name === row.name)).toHaveLength(1);
      expect(row.signature.startsWith(row.name + "(")).toBe(true);
    }
    for (const n of FILTER_INTERNAL) expect(INTERNAL_HELPERS.filter((x) => x === n)).toHaveLength(1);
  });

  it("collision: every helper function is declared at most once in HELPERS_SOURCE", () => {
    const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    for (const n of ["axiFilter", "axiAuto", "axiSelectRect", "axiSelectPolygon", "axiGrade"]) {
      expect(names.filter((x) => x === n).length).toBeLessThanOrEqual(1);
      expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBe(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("axiFilter", () => {
  it("rejects an unknown kind, an unknown key and an out-of-range value before any SDK call", () => {
    const { h, log, doc } = setup();
    const t = makeTarget();
    expect(() => h.axiFilter(doc, t, "blur", {})).toThrow(/unknown kind blur; known: denoise, clarity, sharpen, vignette/);
    expect(() => h.axiFilter(doc, t, "clarity", { strenght: 1 })).toThrow(/clarity has no key strenght; allowed: strength -1\.\.1/);
    expect(() => h.axiFilter(doc, t, "clarity", { strength: 2 })).toThrow(/clarity\.strength must be a number in -1\.\.1, got 2/);
    expect(() => h.axiFilter(doc, t, "sharpen", { radius: 2000 })).toThrow(/sharpen\.radius must be a number in 0\.\.1024/);
    expect(() => h.axiFilter(doc, t, "vignette", { scale: 0.1 })).toThrow(/vignette\.scale must be a number in 0\.25\.\.4/);
    expect(() => h.axiFilter(doc, t, "denoise", { colours: "lots" })).toThrow(/denoise\.colours must be a number in 0\.\.1/);
    expect(() => h.axiFilter(doc, t, "denoise", [1])).toThrow(/params must be true or an object/);
    expect(log).toEqual([]);
  });

  it("adds one filter child with the defaults and returns the target", () => {
    const { h, log, doc } = setup();
    const t = makeTarget();
    expect(h.axiFilter(doc, t, "sharpen")).toBe(t);
    expect(h.axiFilter(doc, t, "vignette", true)).toBe(t);
    expect(h.axiFilter(doc, t, "denoise", {})).toBe(t);
    expect(log).toEqual(["add:UnsharpMask:{\"__params\":\"UnsharpMask\",\"radius\":1.5,\"factor\":0.6,\"threshold\":0.02}", "add:Vignette:{\"__params\":\"Vignette\",\"exposure\":-0.5,\"hardness\":0.5,\"scale\":1,\"shape\":0.5}", "add:Denoise:{\"__params\":\"Denoise\",\"luminance\":0.25,\"luminanceDetail\":0.6,\"colours\":0.4}"]);
    expect(doc.selection).toBe(t);
  });

  it("sets only the keys an object names, and resolves the picture inside a frame", () => {
    const { h, log, doc } = setup();
    const pic = makeTarget();
    const frame = { isRasterNode: false, isImageNode: false, children: [pic] };
    expect(h.axiFilter(doc, frame, "clarity", { strength: -0.3 })).toBe(pic);
    expect(log).toEqual(["add:Clarity:{\"__params\":\"Clarity\",\"strength\":-0.3}"]);
    expect(() => h.axiFilter(doc, { children: [] }, "clarity")).toThrow(/axiFilter: node is not an image or pixel layer/);
    expect(() => h.axiFilter({ selection: { nodes: {} } }, null, "clarity")).toThrow(/axiFilter: nothing selected/);
  });
});

describe("axiAuto", () => {
  it("defaults to white balance then levels and applies the given order", () => {
    const { h, log, doc } = setup();
    const t = makeTarget();
    expect(h.axiAuto(doc, t)).toBe(t);
    expect(log).toEqual(["cmd:autoWhiteBalance", "cmd:autoLevels"].flatMap((c) => [c, `exec:${c}`]));
    log.length = 0;
    h.axiAuto(doc, t, ["contrast", "colours", "levels"]);
    expect(log.filter((l) => l.startsWith("cmd:"))).toEqual(["cmd:autoContrast", "cmd:autoColours", "cmd:autoLevels"]);
  });

  it("rejects unknown kinds, an empty list and a non-pixel target before any command", () => {
    const { h, log, doc } = setup();
    expect(() => h.axiAuto(doc, makeTarget(), ["sepia"])).toThrow(/unknown kind sepia; known: whiteBalance, levels, contrast, colours/);
    expect(() => h.axiAuto(doc, makeTarget(), [])).toThrow(/non-empty array/);
    expect(() => h.axiAuto(doc, { isImageNode: true, isRasterNode: false, children: [] })).toThrow(/needs a pixel layer/);
    expect(log).toEqual([]);
  });

  it("says in the index that it is destructive", () => {
    expect(FILTER_INDEX.find((r) => r.name === "axiAuto")!.summary).toMatch(/DESTRUCTIVE/);
  });
});

describe("axiGrade filter keys and replace", () => {
  it("adds the filters after the adjustments, in the fixed order", () => {
    const { h, log, doc } = setup();
    const t = makeTarget();
    h.axiGrade(doc, t, { sharpen: true, exposure: 0.2, denoise: { luminance: 0.5 }, vignette: false });
    const added = log.filter((l) => l.startsWith("add:")).map((l) => l.split(":")[1]);
    expect(added).toEqual(["Exposure", "Denoise", "UnsharpMask"]);
  });

  it("validates a filter key before any edit, including with replace", () => {
    const { h, log, doc } = setup();
    const t = makeTarget([child("VibranceAdjustmentRasterNode", "v1")]);
    expect(() => h.axiGrade(doc, t, { exposure: 0.1, clarity: { strength: 5 } }, { replace: true })).toThrow(/clarity\.strength/);
    expect(() => h.axiGrade(doc, t, { denoise: { nope: 1 } })).toThrow(/denoise has no key nope/);
    expect(log).toEqual([]);
  });

  it("append is the default: nothing is deleted", () => {
    const { h, log, doc } = setup();
    const t = makeTarget([child("VibranceAdjustmentRasterNode", "v1")]);
    h.axiGrade(doc, t, { exposure: 0.1 });
    expect(log.some((l) => l.startsWith("delete:"))).toBe(false);
    expect(log.filter((l) => l.startsWith("add:"))).toHaveLength(1);
  });

  it("replace deletes only adjustment and filter children, then adds the new stack", () => {
    const { h, log, doc } = setup();
    const kids = [child("VibranceAdjustmentRasterNode", "a1"), child("DenoiseFilterRasterNode", "f1"), child("PixelMaskNode", "m1"), child("CurvesAdjustmentRasterNode", "a2"), child("ImageNode", "i1")];
    const t = makeTarget(kids);
    h.axiGrade(doc, t, { exposure: 0.1, clarity: true }, { replace: true });
    const deletes = log.filter((l) => l.startsWith("delete:"));
    expect(deletes).toEqual(["delete:a1:false", "delete:f1:false", "delete:a2:false"]);
    const lastDelete = log.lastIndexOf("exec:cmd:delete:a2");
    const firstAdd = log.findIndex((l) => l.startsWith("add:"));
    expect(lastDelete).toBeGreaterThan(-1);
    expect(firstAdd).toBeGreaterThan(lastDelete);
    expect(log.filter((l) => l.startsWith("add:")).map((l) => l.split(":")[1])).toEqual(["Exposure", "Clarity"]);
  });

  it("deletes a snapshot of the children, so removing one does not skip the next", () => {
    const { h, log, doc } = setup();
    const kids = [child("ExposureAdjustmentRasterNode", "a1"), child("VibranceAdjustmentRasterNode", "a2")];
    const t = makeTarget(kids);
    const real = doc.executeCommand;
    doc.executeCommand = (c: any) => {
      real(c);
      if (typeof c === "string" && c.startsWith("cmd:delete:")) t.children.shift();
    };
    h.axiGrade(doc, t, {}, { replace: true });
    expect(log.filter((l) => l.startsWith("delete:"))).toEqual(["delete:a1:false", "delete:a2:false"]);
  });
});

describe("axiSelectRect and axiSelectPolygon", () => {
  it("maps op and feather onto the SDK call, defaulting to a hard new selection", () => {
    const { h, log, doc } = setup();
    expect(h.axiSelectRect(doc, { x: 1, y: 2, w: 30, h: 40 })).toBe(doc);
    h.axiSelectRect(doc, { x: 1, y: 2, w: 30, h: 40 }, { feather: 12, op: "subtract" });
    h.axiSelectRect(doc, { x: 0, y: 0, w: 5, h: 5 }, { op: "add" });
    h.axiSelectRect(doc, { x: 0, y: 0, w: 5, h: 5 }, { op: "intersect", feather: 0 });
    expect(log).toEqual(["select:{\"rect\":[1,2,30,40]}:op:New:true:0", "select:{\"rect\":[1,2,30,40]}:op:Subtract:true:12", "select:{\"rect\":[0,0,5,5]}:op:Add:true:0", "select:{\"rect\":[0,0,5,5]}:op:Intersect:true:0"]);
  });

  it("builds a polygon from points and returns doc", () => {
    const { h, log, doc } = setup();
    expect(h.axiSelectPolygon(doc, [[0, 0], [10, 0], [10, 10]], { feather: 3, op: "add" })).toBe(doc);
    expect(log).toEqual(["select:{\"pts\":[[0,0],[10,0],[10,10]]}:op:Add:true:3"]);
  });

  it("validates input before any SDK call", () => {
    const { h, log, doc } = setup();
    expect(() => h.axiSelectRect(doc, { x: 0, y: 0, w: 0, h: 5 })).toThrow(/w and h > 0/);
    expect(() => h.axiSelectRect(doc, null)).toThrow(/needs \{x, y, w, h\}/);
    expect(() => h.axiSelectRect(doc, { x: 0, y: 0, w: 5, h: 5 }, { feather: -1 })).toThrow(/feather must be a number >= 0/);
    expect(() => h.axiSelectRect(doc, { x: 0, y: 0, w: 5, h: 5 }, { op: "xor" })).toThrow(/op must be one of new, add, subtract, intersect/);
    expect(() => h.axiSelectPolygon(doc, [[0, 0], [1, 1]])).toThrow(/at least 3/);
    expect(() => h.axiSelectPolygon(doc, [[0, 0], [1, 1], [1]])).toThrow(/points\[2\] must be \[x, y\]/);
    expect(() => h.axiSelectPolygon(doc, [[0, 0], [1, 1], [2, "a"]])).toThrow(/points\[2\]/);
    expect(log).toEqual([]);
  });
});
