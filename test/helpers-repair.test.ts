// axiRepair and axiLocalGrade: REPAIR_SOURCE evaluated in plain Node together with
// FILTER_SOURCE (axiFilter, axiSelectPolygon), with stub SDK modules, stub grade
// helpers and a fake document that logs every call, so the call order can be asserted.

import { describe, expect, it } from "vitest";
import { REPAIR_INDEX, REPAIR_INTERNAL, REPAIR_SOURCE } from "../src/affinity/helpers-repair.js";
import { FILTER_SOURCE } from "../src/affinity/helpers-filter.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { scanForBlocking } from "../src/affinity/guard.js";

type Fn = (...a: any[]) => any;
type Log = string[];

const STUBS = `
function axiGrade(doc, node, spec) { LOG.push('grade:' + node.userDescription + ':' + JSON.stringify(spec)); return node; }
function axiGradeSteps(spec) { LOG.push('steps:' + JSON.stringify(spec)); if (spec.bad) { throw new Error('axiGrade: unknown key bad'); } return []; }
function axiLook(name) { if (name !== 'airy') { throw new Error('axiLook: unknown look ' + name); } return { exposure: 0.1 }; }
function axiFind(doc, ref) { LOG.push('find:' + ref); return doc.named[ref]; }
`;

function load(log: Log): Record<string, Fn> {
  const body = `${STUBS}\n${FILTER_SOURCE}\n${REPAIR_SOURCE}\nreturn { axiRepair, axiLocalGrade, axiRepairCheck, axiRepairNode, axiRepairCopy, axiRepairFilter, axiRepairZone };`;
  const poly = () => {
    const pts: string[] = [];
    return { addPoint: (p: { x: number; y: number }) => pts.push(`${p.x},${p.y}`), toString: () => `poly[${pts.join(" ")}]` };
  };
  const nodes = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name.endsWith("FilterParameters")) return { create: () => ({ __kind: name.replace("FilterParameters", "") }) };
        if (name.endsWith("FilterRasterNodeDefinition")) {
          return {
            create: (p: Record<string, unknown>) => {
              const { __kind, ...rest } = p as { __kind: string };
              return `def:${__kind}:${JSON.stringify(rest)}`;
            },
          };
        }
        return undefined;
      },
    },
  );
  const cmd = (name: string) => (...a: unknown[]) => `cmd:${name}${a.length ? `(${a.join(",")})` : ""}`;
  const modules: Record<string, unknown> = {
    "/geometry.js": { Polygon: { create: poly }, Transform: { createIdentity: () => "identity" } },
    "/nodes.js": nodes,
    "/commands.js": {
      AddChildNodesCommandBuilder: {
        create: () => {
          const nodesAdded: string[] = [];
          return {
            setInsertionTarget: (t: any) => log.push(`target:${t.userDescription}`),
            setInsertionMode: (m: string) => log.push(`mode:${m}`),
            addNode: (n: string) => nodesAdded.push(n),
            createCommand: () => `add:${nodesAdded.join("|")}`,
          };
        },
      },
      InsertionMode: { Inside_AtFront: "front" },
      NodeChildType: { Main: "main" },
      RasterSelectionLogicalOperation: { New: "op:New", Add: "op:Add" },
      DocumentCommand: {
        createRasterInvertSelection: cmd("invert"),
        createDeleteSelection: (sel: any, flag: boolean) => `cmd:delete(${sel.name},${flag})`,
        createRasterDeselect: cmd("deselect"),
        createFeatherRasterSelection: (r: number) => `cmd:feather(${r})`,
        createRasterSelectShadows: cmd("shadows"),
        createRasterSelectMidtones: cmd("midtones"),
        createRasterSelectHighlights: cmd("highlights"),
        createRasterSelectReds: cmd("reds"),
        createRasterSelectGreens: cmd("greens"),
        createRasterSelectBlues: cmd("blues"),
        createDuplicate: () => (log.push("createDuplicate"), "cmd:duplicate"),
      },
    },
    "/selections.js": { Selection: { create: (_d: unknown, n: any) => ({ node: n, name: n.userDescription }) } },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  return new Function("require", "LOG", body)(req, log) as Record<string, Fn>;
}

function fake(opts: { duplicate?: boolean; raster?: boolean } = {}) {
  const log: Log = [];
  const copy: any = { userDescription: "photo", isRasterNode: true };
  const node: any = { userDescription: "photo", isRasterNode: opts.raster !== false };
  if (opts.duplicate !== false) node.duplicate = (xf: unknown) => (log.push(`duplicate:${xf}`), copy);
  let sel: any = null;
  const doc: any = {
    named: { photo: node },
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
  return { doc, node, copy, log, fns: load(log) };
}

const SQUARE = [[0, 0], [10, 0], [10, 10], [0, 10]];
const TRI = [[20, 20], [30, 20], [25, 30]];

describe("REPAIR_SOURCE", () => {
  it("is syntactically valid, indexed, and has no blocking call", () => {
    expect(() => new Function(REPAIR_SOURCE)).not.toThrow();
    expect(scanForBlocking(REPAIR_SOURCE)).toEqual([]);
    expect(REPAIR_INDEX.map((h) => h.name)).toEqual(["axiRepair", "axiLocalGrade"]);
    for (const h of REPAIR_INDEX) expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
    const declared = [...REPAIR_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    expect(declared.sort()).toEqual([...REPAIR_INDEX.map((h) => h.name), ...REPAIR_INTERNAL].sort());
  });

  it("keeps every require() inside a function and has only declarations at the top", () => {
    for (const line of REPAIR_SOURCE.split("\n")) {
      if (line.includes("require(")) expect(line).toMatch(/^\s+/);
      if (/^\S/.test(line) && !line.startsWith("//") && line !== "}") expect(line).toMatch(/^function axi[A-Z]\w*\(/);
    }
  });

  it("declares no function name already declared in the other helper sources", () => {
    const declared = [...REPAIR_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    const others = HELPERS_SOURCE.split(REPAIR_SOURCE).join("");
    const taken = new Set([...others.matchAll(/^function (\w+)\(/gm)].map((m) => m[1]!));
    for (const name of declared) expect(taken.has(name), name).toBe(false);
  });

  it("uses no SDK name outside the documented set", () => {
    for (const name of ["DustAndScratch", "BilateralBlur", "createFeatherRasterSelection", "createRasterInvertSelection"]) {
      expect(REPAIR_SOURCE).toContain(name);
    }
    expect(REPAIR_SOURCE).not.toMatch(/generative|closeDocument|\.close\(/i);
  });
});

describe("axiRepair", () => {
  it("copies, grades, adds the filters, keeps only the polygons, then deselects", () => {
    const f = fake();
    const out = f.fns.axiRepair!(f.doc, f.node, [SQUARE, TRI], { feather: 12 });
    expect(f.log).toEqual([
      "duplicate:identity",
      `grade:photo:${JSON.stringify({ exposure: 0.6, whiteBalance: { temp: 0.05 }, vibrance: -0.5, saturation: -0.35 })}`,
      "target:photo",
      "mode:front",
      `exec:add:def:DustAndScratch:${JSON.stringify({ radius: 10, tolerance: 0.12 })}`,
      "target:photo",
      "mode:front",
      `exec:add:def:BilateralBlur:${JSON.stringify({ radius: 60, tolerance: 0.12 })}`,
      "target:photo",
      "mode:front",
      `exec:add:def:Denoise:${JSON.stringify({ luminance: 0.6 })}`,
      "select:copy",
      "region:poly[0,0 10,0 10,10 0,10]:op:New:true:12",
      "region:poly[20,20 30,20 25,30]:op:Add:true:12",
      "exec:cmd:invert",
      "exec:cmd:delete(photo,false)",
      "exec:cmd:deselect",
      "select:copy",
    ]);
    expect(out).toBe(f.copy);
    expect(f.copy.userDescription).toBe("photo-repair");
  });

  it("scales the grade and the radii with strength and caps the blur radius at 100", () => {
    const f = fake();
    f.fns.axiRepair!(f.doc, f.node, [SQUARE], { strength: 2 });
    const grade = f.log.find((l) => l.startsWith("grade:"))!;
    expect(JSON.parse(grade.slice("grade:photo:".length))).toEqual({ exposure: 1.2, whiteBalance: { temp: 0.05 }, vibrance: -1, saturation: -0.7 });
    expect(f.log.join("\n")).toContain('DustAndScratch:{"radius":20,"tolerance":0.12}');
    expect(f.log.join("\n")).toContain('BilateralBlur:{"radius":100,"tolerance":0.12}');
    const low = fake();
    low.fns.axiRepair!(low.doc, low.node, [SQUARE], { strength: 0.25 });
    expect(low.log.join("\n")).toContain('DustAndScratch:{"radius":3,"tolerance":0.12}');
    expect(low.log.join("\n")).toContain('BilateralBlur:{"radius":15,"tolerance":0.12}');
  });

  it("defaults the feather to 40 and names the copy from the name option", () => {
    const f = fake();
    f.fns.axiRepair!(f.doc, f.node, [SQUARE], { name: "wall" });
    expect(f.log).toContain("region:poly[0,0 10,0 10,10 0,10]:op:New:true:40");
    expect(f.copy.userDescription).toBe("wall-repair");
  });

  it("resolves a name with axiFind", () => {
    const f = fake();
    f.fns.axiRepair!(f.doc, "photo", [SQUARE]);
    expect(f.log[0]).toBe("find:photo");
    expect(f.log[1]).toBe("duplicate:identity");
  });

  it("works on the picture inside a frame", () => {
    const f = fake();
    const frame: any = { userDescription: "frame", children: [f.node] };
    f.fns.axiRepair!(f.doc, frame, [SQUARE]);
    expect(f.log[0]).toBe("duplicate:identity");
  });

  it("falls back to createDuplicate when the node has no duplicate method", () => {
    const f = fake({ duplicate: false });
    f.doc.executeCommand = (c: string) => {
      f.log.push(`exec:${c}`);
      if (c === "cmd:duplicate") f.doc.selection = f.copy;
    };
    const out = f.fns.axiRepair!(f.doc, f.node, [SQUARE]);
    expect(f.log[0]).toBe("select:node");
    expect(f.log).toContain("createDuplicate");
    expect(out).toBe(f.copy);
  });

  it("throws on bad arguments before any SDK call", () => {
    const bad: Array<[string, unknown[], Record<string, unknown>?]> = [
      ["at least 1 polygon", [[]]],
      ["at least 1 polygon", [null]],
      ["polygons[0] needs at least 3", [[[[0, 0], [1, 1]]]]],
      ["polygons[1][2] must be [x, y]", [[SQUARE, [[0, 0], [1, 1], [2]]]]],
      ["polygons[0][0] must be [x, y]", [[[[NaN, 0], [1, 1], [2, 2]]]]],
      ["strength must be a number in 0.25..2, got 0.1", [[SQUARE]], { strength: 0.1 }],
      ["strength must be a number in 0.25..2, got 2.5", [[SQUARE]], { strength: 2.5 }],
      ["strength must be a number in 0.25..2, got fast", [[SQUARE]], { strength: "fast" }],
      ["feather must be a finite number of 0 or more, got -1", [[SQUARE]], { feather: -1 }],
      ["name must be a non-empty string", [[SQUARE]], { name: "" }],
    ];
    for (const [msg, args, o] of bad) {
      const f = fake();
      expect(() => f.fns.axiRepair!(f.doc, f.node, ...args, o)).toThrow(msg);
      expect(f.log).toEqual([]);
    }
  });

  it("refuses a missing node and a layer that is not a pixel layer", () => {
    const f = fake();
    expect(() => f.fns.axiRepair!(f.doc, null, [SQUARE])).toThrow("pass the pixel layer");
    const g = fake({ raster: false });
    g.node.isImageNode = true;
    expect(() => g.fns.axiRepair!(g.doc, g.node, [SQUARE])).toThrow("needs a pixel layer");
    expect(g.log).toEqual([]);
  });
});

describe("axiLocalGrade", () => {
  it("copies, selects the zone on the copy, feathers, keeps only the zone, then grades the copy", () => {
    const f = fake();
    const out = f.fns.axiLocalGrade!(f.doc, f.node, "highlights", { exposure: -0.4 });
    expect(f.log).toEqual([
      'steps:{"exposure":-0.4}',
      "duplicate:identity",
      "select:copy",
      "exec:cmd:highlights",
      "exec:cmd:feather(24)",
      "exec:cmd:invert",
      "exec:cmd:delete(photo,false)",
      "exec:cmd:deselect",
      'grade:photo:{"exposure":-0.4}',
      "select:copy",
    ]);
    expect(out).toBe(f.copy);
    expect(f.copy.userDescription).toBe("photo-local-highlights");
  });

  it("selects every zone with its own command and skips the feather command at 0", () => {
    for (const zone of ["shadows", "midtones", "highlights", "reds", "greens", "blues"]) {
      const f = fake();
      f.fns.axiLocalGrade!(f.doc, f.node, zone, { exposure: 0.1 }, { feather: 0, name: "bed" });
      expect(f.log).toContain(`exec:cmd:${zone}`);
      expect(f.log.some((l) => l.includes("feather"))).toBe(false);
      expect(f.copy.userDescription).toBe(`bed-local-${zone}`);
    }
  });

  it("accepts a look name for the spec and a name for the layer", () => {
    const f = fake();
    f.fns.axiLocalGrade!(f.doc, "photo", "shadows", "airy");
    expect(f.log).toContain("find:photo");
    expect(f.log.some((l) => l === 'grade:photo:{"exposure":0.1}')).toBe(true);
  });

  it("throws on bad arguments before any edit", () => {
    const bad: Array<[string, unknown[]]> = [
      ["zone must be one of shadows, midtones, highlights, reds, greens, blues, got sky", ["sky", { exposure: 0.1 }]],
      ["zone must be one of", [undefined, { exposure: 0.1 }]],
      ["spec must be an axiGrade spec object or a look name", ["reds", null]],
      ["spec must be an axiGrade spec object or a look name", ["reds", {}]],
      ["spec must be an axiGrade spec object or a look name", ["reds", [1]]],
      ["axiLook: unknown look nope", ["reds", "nope"]],
      ["unknown key bad", ["reds", { bad: 1 }]],
      ["feather must be a finite number of 0 or more, got -2", ["reds", { exposure: 0.1 }, { feather: -2 }]],
      ["name must be a non-empty string", ["reds", { exposure: 0.1 }, { name: "" }]],
    ];
    for (const [msg, args] of bad) {
      const f = fake();
      expect(() => f.fns.axiLocalGrade!(f.doc, f.node, ...args)).toThrow(msg);
      expect(f.log.filter((l) => !l.startsWith("steps:") && !l.startsWith("find:"))).toEqual([]);
    }
  });

  it("refuses a layer that is not a pixel layer", () => {
    const g = fake({ raster: false });
    g.node.isImageNode = true;
    expect(() => g.fns.axiLocalGrade!(g.doc, g.node, "reds", { exposure: 0.1 })).toThrow("needs a pixel layer");
  });
});
