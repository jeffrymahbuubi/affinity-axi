// Icon helpers (axiIconDoc, axiSafeZoneClear): source hygiene, validation before
// a document exists, boards, safe circles, guides and overlays against a stubbed
// document. The live look was not checked here (no Affinity in the unit).

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { NAMED_SOURCE } from "../src/affinity/helpers-named.js";
import { ICONS_INDEX, ICONS_INTERNAL, ICONS_SOURCE } from "../src/affinity/helpers-icons.js";

type Fn = (...a: any[]) => any;

// --- source hygiene ---------------------------------------------------------

describe("ICONS_SOURCE", () => {
  const declared = [...ICONS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(ICONS_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE + ICONS_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and never closes anything", () => {
    expect(scanForBlocking(ICONS_SOURCE)).toEqual([]);
    expect(scanForAi(ICONS_SOURCE)).toEqual([]);
    expect(ICONS_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick, dollar-brace or backslash (it lives in a String.raw block)", () => {
    expect(ICONS_SOURCE).not.toContain("`");
    expect(ICONS_SOURCE).not.toContain("${");
    expect(ICONS_SOURCE).not.toContain("\\");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of ICONS_INDEX) expect(declared).toContain(h.name);
    expect(declared.filter((n) => !ICONS_INDEX.some((h) => h.name === n)).sort()).toEqual([...ICONS_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = ICONS_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi\w+\(/);
  });

  it("collides with no name in the existing helpers", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("every index entry has a signature naming the helper and a summary with the frozen facts", () => {
    for (const h of ICONS_INDEX) {
      expect(h.signature.startsWith(`${h.name}(`)).toBe(true);
      expect(h.summary.length).toBeGreaterThan(10);
    }
    const s = ICONS_INDEX.find((h) => h.name === "axiIconDoc")!.summary;
    for (const w of ["foreground", "background", "monochrome", "maskable", "432", "512", "transparent", "export --all-artboards --densities", "--base 108", "axiSafeZoneClear"]) {
      expect(s).toContain(w);
    }
  });

  it("keeps SDK requires inside functions", () => {
    expect(ICONS_SOURCE.split("\n").filter((l) => /^\S/.test(l) && l.includes("require("))).toEqual([]);
  });
});

// --- a stubbed document ---------------------------------------------------------

interface Ab {
  description: string;
  spreadBaseBox: { x: number; y: number; width: number; height: number };
  node: Record<string, any>;
  fill: unknown;
}

const EXTRA = `
  axiHex = function (h) { return 'H' + h; };
  axiEllipse = function (doc, o) { return globalThis.__shape(doc, 'ellipse', o); };
  axiRect = function (doc, o) { return globalThis.__shape(doc, 'rect', o); };
`;

function makeEnv() {
  const log = { docs: [] as Array<Record<string, any>>, shapes: [] as Array<Record<string, any>>, guides: [] as Array<[string, boolean, number]>, transparent: [] as boolean[] };
  const names = [...(HELPERS_SOURCE + NAMED_SOURCE + ICONS_SOURCE).matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\n${NAMED_SOURCE}\n${ICONS_SOURCE}\n${EXTRA}\n` + `axiDoc = function (w, h, dpi, o) { return globalThis.__newDoc(w, h, dpi, o); };\nreturn { ${names.join(", ")} };`;
  (globalThis as any).__newDoc = (w: number, h: number, dpi: number, o: any) => {
    const abs: Ab[] = [];
    const spread = { children: [] as any[] };
    const state = { selected: undefined as any };
    const doc: Record<string, any> = {
      w, h, dpi, o, abs, sessionUuid: "uuid-1234", spreads: [spread],
      get artboards() { return abs; },
      get selection() { return { nodes: { first: state.selected } }; },
      set selection(n: any) { state.selected = n; },
      addArtboard(def: any) {
        const node: Record<string, any> = { isNode: true, userDescription: "" };
        abs.push({ get description() { return node.userDescription; }, spreadBaseBox: { x: def.box.x, y: def.box.y, width: def.box.width, height: def.box.height }, node, fill: def.fill } as Ab);
      },
      addGuide(horizontal: boolean, pos: number) {
        log.guides.push([String(state.selected && state.selected.userDescription), horizontal, pos]);
      },
    };
    log.docs.push(doc);
    log.transparent.push(!!(o && o.transparent));
    return doc;
  };
  (globalThis as any).__shape = (doc: any, kind: string, o: any) => {
    const node = { kind, ...o, userDescription: o.name, isLocked: false, board: String(doc.selection.nodes.first.userDescription) };
    log.shapes.push(node);
    return node;
  };
  const req = (id: string) => {
    if (id === "/nodes.js") return { ShapeNodeDefinition: { create: (_s: unknown, box: any, fill: unknown) => ({ box, fill }) } };
    if (id === "/shapes.js") return { ShapeRectangle: { create: () => ({}) } };
    throw new Error(`SDK module ${id} not available in tests`);
  };
  const h = new Function("require", body)(req) as Record<string, Fn>;
  return { h, log };
}

const guidesOf = (log: ReturnType<typeof makeEnv>["log"], board: string) => log.guides.filter((g) => g[0] === board).map((g) => [g[1], g[2]]);

describe("axiIconDoc validation", () => {
  it("rejects an unknown preset and bad sizes before a document is created", () => {
    const { h, log } = makeEnv();
    expect(() => h.axiIconDoc("ios")).toThrow("axiIconDoc: unknown preset ios; use android-adaptive or pwa-maskable");
    expect(() => h.axiIconDoc(undefined)).toThrow(/unknown preset undefined/);
    expect(() => h.axiIconDoc("android-adaptive", { size: 107 })).toThrow("axiIconDoc: size must be a whole number of at least 108");
    expect(() => h.axiIconDoc("android-adaptive", { size: 216.5 })).toThrow(/whole number of at least 108/);
    expect(() => h.axiIconDoc("android-adaptive", { size: "432" })).toThrow(/whole number/);
    expect(() => h.axiIconDoc("pwa-maskable", { size: 95 })).toThrow("axiIconDoc: size must be a whole number of at least 96");
    expect(() => h.axiIconDoc("pwa-maskable", { size: NaN })).toThrow(/at least 96/);
    expect(log.docs).toEqual([]);
  });
});

describe("axiIconDoc android-adaptive", () => {
  it("makes a transparent 432 document with three boards and safe r 132 at each centre", () => {
    const { h, log } = makeEnv();
    const r = h.axiIconDoc("android-adaptive");
    expect(log.transparent).toEqual([true]);
    expect([r.doc.w, r.doc.h, r.doc.dpi]).toEqual([432, 432, 72]);
    expect(r.uuid).toBe("uuid-1234");
    expect(r.preset).toBe("android-adaptive");
    expect(r.boards.map((b: any) => b.name)).toEqual(["foreground", "background", "monochrome"]);
    expect(r.boards.map((b: any) => [b.x, b.y, b.w, b.h])).toEqual([[0, 0, 432, 432], [532, 0, 432, 432], [1064, 0, 432, 432]]);
    for (const b of r.boards) expect(b.safe).toEqual({ cx: b.x + 216, cy: 216, r: 132 });
    expect(r.doc.selection.nodes.first.userDescription).toBe("foreground");
  });

  it("freezes 66/108 for the safe circle and 72/108 for the viewport", () => {
    const { h, log } = makeEnv();
    const r = h.axiIconDoc("android-adaptive", { size: 108 });
    expect(r.boards[0].safe.r).toBe(33);
    expect(guidesOf(log, "foreground")).toContainEqual(Array.of(true, 54 - 36));
    expect(guidesOf(log, "foreground")).toContainEqual(Array.of(false, 54 + 36));
  });

  it("adds 8 guides per layer board at the tangents and viewport edges", () => {
    const { h, log } = makeEnv();
    h.axiIconDoc("android-adaptive");
    expect(guidesOf(log, "foreground")).toEqual([
      [true, 84], [true, 348], [false, 84], [false, 348],
      [true, 72], [true, 360], [false, 72], [false, 360],
    ]);
    expect(guidesOf(log, "background").map((g) => g[1])).toEqual([84, 348, 616, 880, 72, 360, 604, 892]);
    expect(log.guides.filter((g) => g[0] === "monochrome").length).toBe(8);
    expect(log.guides.length).toBe(24);
  });

  it("legacy:true adds two 192 boards without a safe circle", () => {
    const { h, log } = makeEnv();
    const r = h.axiIconDoc("android-adaptive", { legacy: true });
    expect(r.boards.map((b: any) => b.name)).toEqual(["foreground", "background", "monochrome", "legacy", "legacy-round"]);
    expect(r.boards.slice(3).map((b: any) => [b.w, b.h, b.safe])).toEqual([[192, 192, null], [192, 192, null]]);
    expect(log.guides.filter((g) => g[0].startsWith("legacy")).length).toBe(0);
  });

  it("size 216 halves everything", () => {
    const { h } = makeEnv();
    const r = h.axiIconDoc("android-adaptive", { size: 216, legacy: true });
    expect(r.boards[0].safe).toEqual({ cx: 108, cy: 108, r: 66 });
    expect(r.boards[3].w).toBe(96);
  });

  it("fill reaches background only", () => {
    const { h } = makeEnv();
    const r = h.axiIconDoc("android-adaptive", { fill: "#112233" });
    const fills = r.doc.abs.map((a: Ab) => a.fill);
    expect(fills).toEqual([null, "H#112233", null]);
  });

  it("overlay:true adds stroke-only outlines named axi-safe-zone, none without it", () => {
    const off = makeEnv();
    off.h.axiIconDoc("android-adaptive");
    expect(off.log.shapes).toEqual([]);
    const { h, log } = makeEnv();
    h.axiIconDoc("android-adaptive", { overlay: true });
    expect(log.shapes.length).toBe(6);
    for (const s of log.shapes) {
      expect(s.name).toBe("axi-safe-zone");
      expect(s.fill).toBeUndefined();
      expect(s.stroke).toBe("#ff0000");
      expect(s.strokeWidth).toBe(2);
      expect(s.isLocked).toBe(false);
    }
    const first = log.shapes[0];
    expect(first.kind).toBe("ellipse");
    expect(first.board).toBe("foreground");
    // the outer edge of the stroke is the safe circle: box inset by half the width
    expect([first.x - first.strokeWidth / 2, first.y - first.strokeWidth / 2, first.w + first.strokeWidth]).toEqual([84, 84, 264]);
    expect(log.shapes[1].kind).toBe("rect");
    expect([log.shapes[1].x, log.shapes[1].y, log.shapes[1].w, log.shapes[1].h]).toEqual([72, 72, 288, 288]);
  });
});

describe("axiIconDoc pwa-maskable", () => {
  it("makes maskable and icon at 512 with safe r 204.8 on maskable only", () => {
    const { h, log } = makeEnv();
    const r = h.axiIconDoc("pwa-maskable");
    expect([r.doc.w, r.doc.h]).toEqual([512, 512]);
    expect(r.boards.map((b: any) => [b.name, b.w])).toEqual([["maskable", 512], ["icon", 512]]);
    expect(r.boards[0].safe).toEqual({ cx: 256, cy: 256, r: 204.8 });
    expect(r.boards[1].safe).toBeNull();
    expect(r.boards[0].safe.r / 512).toBeCloseTo(0.4, 10);
    expect(guidesOf(log, "maskable").length).toBe(4);
    expect(guidesOf(log, "icon").length).toBe(0);
    expect(r.doc.selection.nodes.first.userDescription).toBe("maskable");
  });

  it("shortcut:true adds a 96 board and fill reaches maskable and icon", () => {
    const { h } = makeEnv();
    const r = h.axiIconDoc("pwa-maskable", { shortcut: true, fill: "#ffffff" });
    expect(r.boards.map((b: any) => [b.name, b.w, b.safe === null])).toEqual([["maskable", 512, false], ["icon", 512, true], ["shortcut", 96, true]]);
    expect(r.doc.abs.map((a: Ab) => a.fill)).toEqual(["H#ffffff", "H#ffffff", null]);
  });

  it("overlay:true adds one ellipse on maskable and no rect", () => {
    const { h, log } = makeEnv();
    h.axiIconDoc("pwa-maskable", { overlay: true });
    expect(log.shapes.map((s) => [s.kind, s.board, s.name, s.strokeWidth])).toEqual([["ellipse", "maskable", "axi-safe-zone", 2]]);
    const e = log.shapes[0];
    expect([e.x - 1, e.w + 2]).toEqual([256 - 204.8, 409.6]);
  });
});

// --- axiSafeZoneClear -----------------------------------------------------------

describe("axiSafeZoneClear", () => {
  function clearDoc(names: Array<[string, boolean]>) {
    const deleted: any[] = [];
    const unlocked: any[] = [];
    const nodes = names.map(([n, locked]) => {
      const node: Record<string, any> = { isNode: true, userDescription: n, isLocked: locked, children: [] };
      node.unlock = () => {
        node.isLocked = false;
        unlocked.push(node);
      };
      return node;
    });
    const spread = { children: nodes };
    const doc = {
      spreads: [spread],
      deleteSelection(n: any) {
        if (n.isLocked) throw new Error("locked");
        deleted.push(n);
        spread.children = spread.children.filter((k) => k !== n);
      },
    };
    return { doc, deleted, unlocked, nodes };
  }

  it("deletes every axi-safe-zone node, unlocking locked ones, and leaves the rest", () => {
    const { h } = makeEnv();
    const { doc, deleted, unlocked, nodes } = clearDoc([["logo", false], ["axi-safe-zone", true], ["axi-safe-zone", false], ["bg", false], ["axi-safe-zone", true]]);
    expect(h.axiSafeZoneClear(doc)).toBe(3);
    expect(deleted).toEqual([nodes[1], nodes[2], nodes[4]]);
    expect(unlocked).toEqual([nodes[1], nodes[4]]);
    expect(doc.spreads[0]!.children.map((n: any) => n.userDescription)).toEqual(["logo", "bg"]);
    expect(h.axiSafeZoneClear(doc)).toBe(0);
  });

  it("returns 0 on a clean document without deleting", () => {
    const { h } = makeEnv();
    const { doc, deleted } = clearDoc([["logo", false]]);
    expect(h.axiSafeZoneClear(doc)).toBe(0);
    expect(deleted).toEqual([]);
  });
});
