// axiBake, axiSnapshot, axiRestore, axiStraighten and the axiCoverScale maths. The
// helper source is evaluated in plain Node with a fake `require` that returns stub
// SDK modules (a small affine Transform) and a fake document that logs commands.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS } from "../src/affinity/helpers.js";
import { PHOTO_INDEX, PHOTO_INTERNAL } from "../src/affinity/helpers-photo.js";
import { REPAIR_INDEX, REPAIR_INTERNAL, REPAIR_SOURCE } from "../src/affinity/helpers-repair.js";

type Fn = (...a: any[]) => any;

/** Affine matrix: x' = a x + c y + e, y' = b x + d y + f. multiply(o) = this after o. */
class FakeTransform {
  constructor(
    public a = 1,
    public b = 0,
    public c = 0,
    public d = 1,
    public e = 0,
    public f = 0,
  ) {}
  static createTranslate(x: number, y: number) {
    return new FakeTransform(1, 0, 0, 1, x, y);
  }
  static createScale(x: number, y = x) {
    return new FakeTransform(x, 0, 0, y, 0, 0);
  }
  static createRotate(r: number) {
    return new FakeTransform(Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0);
  }
  multiply(o: FakeTransform) {
    return new FakeTransform(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
  }
  applyToPoint(p: { x: number; y: number }) {
    return { x: this.a * p.x + this.c * p.y + this.e, y: this.b * p.x + this.d * p.y + this.f };
  }
}

function makeNode(over: Record<string, unknown>, w: number, h: number, x: number, y: number): any {
  return {
    userDescription: "",
    children: [],
    baseBoxInterface: { baseBox: { x: 0, y: 0, width: w, height: h } },
    transform: FakeTransform.createTranslate(x, y),
    ...over,
  };
}

/** A frame (fw x fh at fx, fy) holding a picture (pw x ph at px, py), both on one spread. */
function makeScene(fw: number, fh: number, pw = fw, ph = fh, fx = 100, fy = 50, px = fx, py = fy) {
  const pic = makeNode({ userDescription: "photo", isImageNode: false, isRasterNode: true }, pw, ph, px, py);
  const frame = makeNode({ userDescription: "photo-frame", pictureFrameEnabled: true, isImageNode: false, isRasterNode: false, children: [pic] }, fw, fh, fx, fy);
  pic.parent = frame;
  const spread: any = { isSpreadNode: true, children: [frame] };
  spread.isSameNode = (o: unknown) => o === spread;
  frame.parent = spread;
  return { pic, frame, spread };
}

function setup(spread: any, o: { scaleChildren?: boolean } = {}): { h: Record<string, Fn>; log: string[]; doc: any } {
  const log: string[] = [];
  const scaleChildren = o.scaleChildren !== false;
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const body = `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`;
  const label = (n: any) => String(n.userDescription);
  const modules: Record<string, unknown> = {
    "/geometry.js": { Transform: FakeTransform },
    "/selections.js": { Selection: { create: (_d: unknown, n: any) => ({ node: n }) } },
    "/commands.js": {
      DocumentCommand: {
        createTransform: (sel: any, xf: FakeTransform) => ({ kind: "transform", node: sel.node, xf }),
        createAddDocumentSnapshot: (name: string) => ({ kind: "snapshot", name }),
        createRestoreDocumentSnapshot: (snap: any) => ({ kind: "restore", snap }),
        createRasteriseObjects: (sel: any, a: boolean, b: boolean) => ({ kind: "rasterise", node: sel.node, a, b }),
      },
    },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    return modules[id];
  };
  const h = new Function("require", body)(req) as Record<string, Fn>;
  const move = (node: any, xf: FakeTransform, withKids: boolean) => {
    node.transform = xf.multiply(node.transform);
    if (withKids) for (const c of node.children) move(c, xf, true);
  };
  const doc: any = {
    spreads: [spread],
    currentSpread: spread,
    snapshots: [] as Array<{ description: string }>,
    selection: { nodes: { first: null as any } },
    applyTransform: (xf: FakeTransform, node: any) => {
      log.push(`apply:${label(node)}`);
      move(node, xf, scaleChildren);
    },
    executeCommand: (c: any) => {
      if (c.kind === "transform") {
        log.push(`transform:${label(c.node)}`);
        move(c.node, c.xf, true);
      } else if (c.kind === "snapshot") {
        log.push(`snapshot:${c.name}`);
        doc.snapshots.push({ description: c.name });
      } else if (c.kind === "restore") {
        log.push(`restore:${c.snap.description}`);
      } else if (c.kind === "rasterise") {
        log.push(`rasterise:${label(c.node)}:${c.a}:${c.b}`);
        const parent = c.node.parent;
        const fresh = makeNode({ userDescription: label(c.node), isRasterNode: true, isImageNode: false, parent }, 10, 10, 0, 0);
        parent.children = parent.children.map((k: any) => (k === c.node ? fresh : k));
        doc.selection.nodes.first = fresh;
      }
    },
  };
  return { h, log, doc };
}

/** Bounding box of a fake node, as the helpers measure it. */
function box(h: Record<string, Fn>, n: any) {
  return h.axiNodeBox!(n);
}

describe("registration", () => {
  it("indexes the helpers once, lists the internals, and registers the repair helpers", () => {
    expect(PHOTO_INDEX.map((r) => r.name)).toEqual(["axiBake", "axiSnapshot", "axiRestore", "axiStraighten"]);
    for (const row of PHOTO_INDEX) {
      expect(HELPER_INDEX.filter((r) => r.name === row.name)).toHaveLength(1);
      expect(row.signature.startsWith(row.name + "(")).toBe(true);
    }
    for (const n of PHOTO_INTERNAL) expect(INTERNAL_HELPERS.filter((x) => x === n)).toHaveLength(1);
    expect(HELPERS_SOURCE).toContain(REPAIR_SOURCE);
    for (const row of REPAIR_INDEX) expect(HELPER_INDEX.filter((r) => r.name === row.name)).toHaveLength(1);
    for (const n of REPAIR_INTERNAL) expect(INTERNAL_HELPERS.filter((x) => x === n)).toHaveLength(1);
  });

  it("collision: every helper function is declared at most once in HELPERS_SOURCE", () => {
    const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    for (const n of ["axiBake", "axiSnapshot", "axiRestore", "axiStraighten", "axiCoverScale", "axiPhotoNode", "axiPhotoTarget", "axiSnapshotNamed"]) {
      expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBe(1);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("builds without a backtick, ${ or backslash slipping into the block", () => {
    const { spread } = makeScene(300, 400);
    expect(() => setup(spread)).not.toThrow();
  });
});

describe("axiSnapshot and axiRestore", () => {
  it("saves a snapshot, refuses a duplicate or empty name, and restores by name", () => {
    const { spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    expect(h.axiSnapshot!(doc, "before")).toBe("before");
    expect(() => h.axiSnapshot!(doc, "before")).toThrow(/a snapshot named before already exists/);
    expect(() => h.axiSnapshot!(doc, "")).toThrow(/name must be a non-empty string/);
    expect(() => h.axiSnapshot!(doc, 3)).toThrow(/name must be a non-empty string/);
    expect(h.axiRestore!(doc, "before")).toBe("before");
    expect(log).toEqual(["snapshot:before", "restore:before"]);
  });

  it("throws on an unknown snapshot and lists the known names", () => {
    const { spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    h.axiSnapshot!(doc, "a");
    h.axiSnapshot!(doc, "b");
    log.length = 0;
    expect(() => h.axiRestore!(doc, "c")).toThrow(/no snapshot named c; known: a, b/);
    expect(() => h.axiRestore!(doc, " ")).toThrow(/name must be a non-empty string/);
    expect(log).toEqual([]);
  });
});

describe("axiBake", () => {
  it("saves the bake snapshot, then rasterises, and returns the node found again by name", () => {
    const { frame, pic, spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    const out = h.axiBake!(doc, pic);
    expect(log).toEqual(["snapshot:bake:photo", "rasterise:photo:false:true"]);
    expect(out).not.toBe(pic);
    expect(out.userDescription).toBe("photo");
    expect(frame.children[0]).toBe(out);
  });

  it("accepts a name or the frame, numbers a repeated snapshot, and skips it with snapshot false", () => {
    const { spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    h.axiBake!(doc, "photo");
    h.axiBake!(doc, "photo-frame");
    h.axiBake!(doc, "photo", { snapshot: false });
    expect(log.filter((l) => l.startsWith("snapshot:"))).toEqual(["snapshot:bake:photo", "snapshot:bake:photo:2"]);
    expect(log.filter((l) => l.startsWith("rasterise:"))).toHaveLength(3);
    expect(log[log.length - 1]).toBe("rasterise:photo:false:true");
  });

  it("validates before any command", () => {
    const { spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    expect(() => h.axiBake!(doc, "photo", { snapshot: "yes" })).toThrow(/snapshot must be true or false/);
    expect(() => h.axiBake!(doc, "nothing-here")).toThrow(/nothing matches/);
    expect(() => h.axiBake!(doc, { isImageNode: false, isRasterNode: false, children: [] })).toThrow(/not an image, a pixel layer or a picture frame/);
    expect(() => h.axiBake!(doc, null)).toThrow(/nothing selected/);
    expect(log).toEqual([]);
  });
});

describe("axiCoverScale", () => {
  const f = (w: number, hh: number, deg: number) => setup(makeScene(10, 10).spread).h.axiCoverScale!(w, hh, (deg * Math.PI) / 180);
  const rad = (d: number) => (d * Math.PI) / 180;

  it("is 1 at 0 degrees", () => {
    expect(f(300, 400, 0)).toBe(1);
    expect(f(500, 500, 0)).toBe(1);
  });

  it("matches cos + max/min * sin at 2.5 degrees on 3:4 (about 1.0572, lost about 0.105)", () => {
    const s = f(300, 400, 2.5);
    expect(s).toBeCloseTo(Math.cos(rad(2.5)) + (4 / 3) * Math.sin(rad(2.5)), 12);
    expect(s).toBeCloseTo(1.0572, 4);
    expect(1 - 1 / (s * s)).toBeCloseTo(0.1053, 3);
  });

  it("matches the closed form at 10 degrees on 16:9 and is symmetric in sign and orientation", () => {
    expect(f(1600, 900, 10)).toBeCloseTo(Math.cos(rad(10)) + (16 / 9) * Math.sin(rad(10)), 12);
    expect(f(1600, 900, -10)).toBeCloseTo(f(1600, 900, 10), 12);
    expect(f(900, 1600, 10)).toBeCloseTo(f(1600, 900, 10), 12);
    expect(f(500, 500, 10)).toBeCloseTo(Math.cos(rad(10)) + Math.sin(rad(10)), 12);
  });

  it("covers the box: its four corners, turned back by -rad and shrunk by 1/s, land inside the box", () => {
    for (const deg of [1, 2.5, -4, 10, -10]) {
      for (const [w, hh] of [[300, 400], [400, 300], [500, 500], [1600, 900]] as const) {
        const s = f(w, hh, deg);
        const r = rad(-deg);
        for (const [x, y] of [[w / 2, hh / 2], [-w / 2, hh / 2], [w / 2, -hh / 2], [-w / 2, -hh / 2]] as const) {
          const px = (x * Math.cos(r) - y * Math.sin(r)) / s;
          const py = (x * Math.sin(r) + y * Math.cos(r)) / s;
          expect(Math.abs(px)).toBeLessThanOrEqual(w / 2 + 1e-9);
          expect(Math.abs(py)).toBeLessThanOrEqual(hh / 2 + 1e-9);
        }
      }
    }
  });

  it("rejects bad input", () => {
    const { h } = setup(makeScene(10, 10).spread);
    expect(() => h.axiCoverScale!(0, 400, 0.05)).toThrow(/w and h must be positive/);
    expect(() => h.axiCoverScale!(300, -1, 0.05)).toThrow(/w and h must be positive/);
    expect(() => h.axiCoverScale!(300, 400, NaN)).toThrow(/rad must be a finite number/);
  });
});

describe("axiStraighten", () => {
  it("validates degrees and crop before any command", () => {
    const { pic, spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    expect(() => h.axiStraighten!(doc, pic, "2")).toThrow(/degrees must be a finite number/);
    expect(() => h.axiStraighten!(doc, pic, NaN)).toThrow(/degrees must be a finite number/);
    expect(() => h.axiStraighten!(doc, pic, 0)).toThrow(/degrees must not be 0/);
    expect(() => h.axiStraighten!(doc, pic, 10.5)).toThrow(/within -10\.\.10, got 10\.5/);
    expect(() => h.axiStraighten!(doc, pic, -11)).toThrow(/within -10\.\.10/);
    expect(() => h.axiStraighten!(doc, pic, 2, { crop: "yes" })).toThrow(/crop must be true or false/);
    expect(() => h.axiStraighten!(doc, "nothing-here", 2)).toThrow(/nothing matches/);
    expect(log).toEqual([]);
  });

  it("records one transform on the picture and leaves the frame box unchanged", () => {
    const { frame, pic, spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    const before = box(h, frame);
    const res = h.axiStraighten!(doc, "photo", 2.5);
    expect(log).toEqual(["transform:photo"]);
    expect(res.node).toBe(pic);
    const rad = (2.5 * Math.PI) / 180;
    const s = Math.cos(rad) + (4 / 3) * Math.sin(rad);
    expect(res.lost).toBeCloseTo(1 - 1 / (s * s), 12);
    expect(res.lost).toBeCloseTo(0.1053, 3);
    expect(box(h, frame)).toEqual(before);
    // The picture is the 300 x 400 original turned 2.5 degrees and scaled by s about the frame centre.
    const pb = box(h, pic);
    expect(pb.w).toBeCloseTo(s * (300 * Math.cos(rad) + 400 * Math.sin(rad)), 6);
    expect(pb.h).toBeCloseTo(s * (300 * Math.sin(rad) + 400 * Math.cos(rad)), 6);
    expect(pb.x + pb.w / 2).toBeCloseTo(250, 6);
    expect(pb.y + pb.h / 2).toBeCloseTo(250, 6);
  });

  it("covers the frame: the frame corners, mapped back into the picture, stay within it", () => {
    for (const deg of [2.5, -4, 10, -10]) {
      const { frame, pic, spread } = makeScene(300, 400);
      const { h, doc } = setup(spread);
      h.axiStraighten!(doc, frame, deg);
      const fb = box(h, frame);
      const m = pic.transform;
      const det = m.a * m.d - m.b * m.c;
      for (const [x, y] of [[fb.x, fb.y], [fb.x + fb.w, fb.y], [fb.x, fb.y + fb.h], [fb.x + fb.w, fb.y + fb.h]] as const) {
        // invert the picture transform to get the point in the picture's own 300 x 400 box
        const dx = x - m.e;
        const dy = y - m.f;
        const lx = (m.d * dx - m.c * dy) / det;
        const ly = (-m.b * dx + m.a * dy) / det;
        expect(lx).toBeGreaterThanOrEqual(-1e-6);
        expect(lx).toBeLessThanOrEqual(300 + 1e-6);
        expect(ly).toBeGreaterThanOrEqual(-1e-6);
        expect(ly).toBeLessThanOrEqual(400 + 1e-6);
      }
    }
  });

  it("works when ref is the frame, and the sign of degrees picks the turn direction", () => {
    const a = makeScene(300, 400);
    const sa = setup(a.spread);
    const res = sa.h.axiStraighten!(sa.doc, a.frame, 4);
    expect(res.node).toBe(a.pic);
    const rad = (4 * Math.PI) / 180;
    const s = Math.cos(rad) + (4 / 3) * Math.sin(rad);
    expect(res.lost).toBeCloseTo(1 - 1 / (s * s), 12);
    const b = makeScene(300, 400);
    const sb = setup(b.spread);
    sb.h.axiStraighten!(sb.doc, b.frame, -4);
    expect(Math.sign(a.pic.transform.b)).toBe(-Math.sign(b.pic.transform.b));
    expect(a.pic.transform.b).not.toBe(0);
  });

  it("with crop false rotates at scale 1 and reports lost 0", () => {
    const { frame, pic, spread } = makeScene(300, 400);
    const { h, log, doc } = setup(spread);
    const res = h.axiStraighten!(doc, "photo", 3, { crop: false });
    expect(log).toEqual(["transform:photo"]);
    expect(res.lost).toBe(0);
    expect(box(h, frame).w).toBeCloseTo(300, 9);
    const rad = (3 * Math.PI) / 180;
    expect(box(h, pic).w).toBeCloseTo(300 * Math.cos(rad) + 400 * Math.sin(rad), 6);
  });

  it("a bare pixel layer uses its artboard box, else the document box", () => {
    const rad = (2.5 * Math.PI) / 180;
    const bare = makeNode({ userDescription: "bare", isRasterNode: true, isImageNode: false }, 600, 800, 0, 0);
    const board = makeNode({ userDescription: "board", isArtboardEnabled: true, children: [bare] }, 600, 800, 0, 0);
    bare.parent = board;
    const spread: any = { isSpreadNode: true, children: [board] };
    board.parent = spread;
    const a = setup(spread);
    const res = a.h.axiStraighten!(a.doc, bare, 2.5);
    expect(a.log).toEqual(["transform:bare"]);
    const s = Math.cos(rad) + (4 / 3) * Math.sin(rad);
    expect(res.lost).toBeCloseTo(1 - 1 / (s * s), 12);
    const bb = box(a.h, bare);
    expect(bb.x + bb.w / 2).toBeCloseTo(300, 6);

    const lone = makeNode({ userDescription: "lone", isRasterNode: true, isImageNode: false }, 1000, 500, 0, 0);
    const spread2: any = { isSpreadNode: true, children: [lone] };
    lone.parent = spread2;
    const b = setup(spread2);
    b.doc.widthPixels = 1000;
    b.doc.heightPixels = 500;
    const res2 = b.h.axiStraighten!(b.doc, lone, 2.5);
    const s2 = Math.cos(rad) + 2 * Math.sin(rad);
    expect(res2.lost).toBeCloseTo(1 - 1 / (s2 * s2), 12);
  });
});
