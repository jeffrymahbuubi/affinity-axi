// axiGenerativePatch: PATCH_SOURCE evaluated in plain Node with stub SDK modules and
// a fake document that logs every call, so the call order can be asserted.

import { describe, expect, it } from "vitest";
import { PATCH_INDEX, PATCH_INTERNAL, PATCH_SOURCE } from "../src/affinity/helpers-patch.js";
import { scanForBlocking } from "../src/affinity/guard.js";

type Fn = (...a: any[]) => any;
type Log = string[];

interface Fake {
  doc: any;
  node: any;
  copy: any;
  log: Log;
}

function load(log: Log): Record<string, Fn> {
  const body = `${PATCH_SOURCE}\nreturn { axiGenerativePatch, axiPatchCheck, axiPatchSelect };`;
  const poly = (kind: string) => {
    const pts: string[] = [];
    return {
      addPoint: (p: { x: number; y: number }) => pts.push(`${p.x},${p.y}`),
      toString: () => `${kind}[${pts.join(" ")}]`,
    };
  };
  const modules: Record<string, unknown> = {
    "/geometry.js": {
      Polygon: { create: () => poly("poly"), createRectangle: (r: any) => `rect[${r.x},${r.y},${r.w},${r.h}]` },
      Rectangle: class {
        constructor(
          public x: number,
          public y: number,
          public w: number,
          public h: number,
        ) {}
      },
      Transform: { createIdentity: () => "identity" },
    },
    "/commands.js": {
      DocumentCommand: {
        createDeleteSelection: (sel: any, flag: boolean) => (log.push(`delete:${sel.node === undefined ? "?" : sel.name}:${flag}`), "cmd:delete"),
        createRasterDeselect: () => "cmd:deselect",
        createDuplicate: () => (log.push("createDuplicate"), "cmd:duplicate"),
      },
      RasterSelectionLogicalOperation: { New: "op:New" },
    },
    "/selections.js": { Selection: { create: (_d: unknown, n: any) => ({ node: n, name: n.userDescription }) } },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  return new Function("require", body)(req) as Record<string, Fn>;
}

function fake(opts: { duplicate?: boolean; replaces?: boolean } = {}): Fake & { fns: Record<string, Fn> } {
  const log: Log = [];
  const copy: any = { userDescription: "photo" };
  const node: any = { userDescription: "photo" };
  if (opts.duplicate !== false) node.duplicate = (xf: unknown) => (log.push(`duplicate:${xf}`), copy);
  let sel: any = null;
  const doc: any = {
    get selection() {
      return { nodes: { first: sel } };
    },
    set selection(v: any) {
      sel = v;
      log.push(`select:${v === node ? "node" : v === copy ? "copy" : "other"}`);
    },
    setRasterSelectionFromPolygon: (p: unknown, op: string, aa: boolean, feather: number) => log.push(`region:${String(p)}:${op}:${aa}:${feather}`),
    executeCommand: (c: string) => log.push(`exec:${c}`),
  };
  doc["generative" + "EditImage"] = (prompt: string) => log.push(`gen:${prompt}`);
  return { doc, node, copy, log, fns: load(log) };
}

const RECT = { x: 10, y: 20, w: 30, h: 40 };

describe("PATCH_SOURCE", () => {
  it("is syntactically valid, indexed, and has no blocking call", () => {
    expect(() => new Function(PATCH_SOURCE)).not.toThrow();
    expect(scanForBlocking(PATCH_SOURCE)).toEqual([]);
    expect(PATCH_INDEX.map((h) => h.name)).toEqual(["axiGenerativePatch"]);
    expect(PATCH_INDEX[0]!.signature.startsWith("axiGenerativePatch(")).toBe(true);
    const declared = [...PATCH_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    expect(declared.sort()).toEqual(["axiGenerativePatch", ...PATCH_INTERNAL].sort());
  });

  it("keeps every require() inside a function and has only declarations at the top", () => {
    for (const line of PATCH_SOURCE.split("\n")) {
      if (line.includes("require(")) expect(line).toMatch(/^\s+/);
      if (/^\S/.test(line) && !line.startsWith("//") && line !== "}") expect(line).toMatch(/^function axi[A-Z]\w*\(/);
    }
  });
});

describe("axiGenerativePatch", () => {
  it("keeps a copy: duplicate, select region, select node, edit, delete the region from the copy, deselect", () => {
    const f = fake();
    const r = f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "a fern", { feather: 12 });
    expect(f.log).toEqual([
      "duplicate:identity",
      "region:rect[10,20,30,40]:op:New:true:12",
      "select:node",
      "gen:a fern",
      "region:rect[10,20,30,40]:op:New:true:12",
      "delete:photo:false",
      "exec:cmd:delete",
      "exec:cmd:deselect",
    ]);
    expect(f.copy.userDescription).toBe("photo-outside");
    expect(r.outside).toBe(f.copy);
    expect(r.node).toBe(f.node);
  });

  it("defaults the feather to 24 and keep to true", () => {
    const f = fake();
    f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "a fern");
    expect(f.log.filter((l) => l.startsWith("region:"))).toEqual(["region:rect[10,20,30,40]:op:New:true:24", "region:rect[10,20,30,40]:op:New:true:24"]);
    expect(f.log).toContain("duplicate:identity");
  });

  it("keep:false skips the copy and the delete", () => {
    const f = fake();
    const r = f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "a fern", { keep: false });
    expect(f.log).toEqual(["region:rect[10,20,30,40]:op:New:true:24", "select:node", "gen:a fern", "exec:cmd:deselect"]);
    expect(r.outside).toBeNull();
    expect(f.node.userDescription).toBe("photo");
  });

  it("builds a polygon from points", () => {
    const f = fake();
    f.fns.axiGenerativePatch!(f.doc, f.node, [[0, 0], [10, 0], [5, 8]], "a fern", { keep: false, feather: 0 });
    expect(f.log[0]).toBe("region:poly[0,0 10,0 5,8]:op:New:true:0");
  });

  it("falls back to createDuplicate when the node has no duplicate method", () => {
    const f = fake({ duplicate: false });
    f.doc.executeCommand = (c: string) => {
      f.log.push(`exec:${c}`);
      if (c === "cmd:duplicate") f.doc.selection = f.copy;
    };
    const r = f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "a fern");
    expect(f.log[0]).toBe("select:node");
    expect(f.log).toContain("createDuplicate");
    expect(r.outside).toBe(f.copy);
  });

  it("returns the layer the edit selected when it is not the original node", () => {
    const f = fake();
    const made = { userDescription: "new" };
    f.doc["generative" + "EditImage"] = () => {
      f.doc.selection = made;
    };
    const r = f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "a fern");
    expect(r.node).toBe(made);
  });

  it("throws on bad arguments before any SDK call", () => {
    const bad: Array<[string, unknown[]]> = [
      ["prompt must be a non-empty string", [f0().node, RECT, ""]],
      ["prompt must be a non-empty string", [f0().node, RECT, "   "]],
      ["prompt must be a non-empty string", [f0().node, RECT, 5]],
      ["prompt must be 200 characters or fewer, got 201", [f0().node, RECT, "x".repeat(201)]],
      ["pass the pixel node", [null, RECT, "a fern"]],
      ["region must be {x, y, w, h} or an array", [f0().node, null, "a fern"]],
      ["w, h above 0", [f0().node, { x: 0, y: 0, w: 0, h: 5 }, "a fern"]],
      ["w, h above 0", [f0().node, { x: 0, y: 0, w: NaN, h: 5 }, "a fern"]],
      ["at least 3 points", [f0().node, [[0, 0], [1, 1]], "a fern"]],
      ["every polygon point", [f0().node, [[0, 0], [1, 1], [2]], "a fern"]],
      ["feather must be a finite number of 0 or more", [f0().node, RECT, "a fern", { feather: -1 }]],
      ["keep must be true or false", [f0().node, RECT, "a fern", { keep: "yes" }]],
    ];
    for (const [msg, args] of bad) {
      const f = fake();
      expect(() => f.fns.axiGenerativePatch!(f.doc, ...args)).toThrow(msg);
      expect(f.log).toEqual([]);
    }
  });

  it("accepts a prompt of exactly 200 characters", () => {
    const f = fake();
    f.fns.axiGenerativePatch!(f.doc, f.node, RECT, "x".repeat(200), { keep: false });
    expect(f.log).toContain(`gen:${"x".repeat(200)}`);
  });
});

/** A throwaway node for the argument table (the real one is built per case). */
function f0(): { node: unknown } {
  return { node: { userDescription: "photo" } };
}
