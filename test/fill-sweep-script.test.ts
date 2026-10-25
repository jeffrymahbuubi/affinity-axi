// `fill` apply script, sweep fixes (D1b, D2, D10, J1, J2, J4): picture types, EXIF orientation
// in the plan, text shrinking and floor notes (no node is moved), and undo on failure. The apply script is evaluated in
// plain Node against stub helpers and a stub document. No Affinity.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { FILL_APPLY, IMAGE_EXT, planEdits, type ApplyReply } from "../src/affinity/fill-script.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

const dir = mkdtempSync(join(tmpdir(), "axi-fill-sweep-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const UUID = "00000000-0000-4000-8000-000000000001";

/** A JPEG whose Exif APP1 carries this orientation (little-endian TIFF). */
function jpegWith(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, body, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

function put(name: string, body: Buffer | string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("picture types (J1)", () => {
  it("IMAGE_EXT accepts the eight extensions, case-insensitively", () => {
    for (const ext of ["png", "jpg", "jpeg", "webp", "heic", "heif", "tif", "tiff", "PNG", "HeIc", "TIFF"]) expect(IMAGE_EXT.test(`photo.${ext}`)).toBe(true);
    for (const ext of ["gif", "bmp", "psd", "svg", "txt"]) expect(IMAGE_EXT.test(`photo.${ext}`)).toBe(false);
  });

  it("a plain string naming an existing HEIC or TIFF is an image candidate", () => {
    put("a.heic", "x");
    put("b.TIFF", "x");
    const e = planEdits({ a: "a.heic", b: "b.TIFF" }, undefined, dir);
    expect(e[0]!.strImage).toBe(join(dir, "a.heic"));
    expect(e[1]!.strImage).toBe(join(dir, "b.TIFF"));
  });

  it("an existing .gif or .bmp is a usage error naming the type and the eight extensions", () => {
    put("c.gif", "x");
    put("d.bmp", "x");
    for (const f of ["c.gif", "d.bmp"]) {
      expect(() => planEdits({ photo: f }, undefined, dir)).toThrow(`slot 'photo': '${f}' is an unsupported image type`);
      try {
        planEdits({ photo: f }, undefined, dir);
      } catch (e) {
        expect(String((e as { suggestion?: string }).suggestion)).toContain("png, jpg, jpeg, webp, heic, heif, tif or tiff");
      }
    }
  });

  it("text that merely looks like a file name stays text: no such file, or whitespace", () => {
    expect(planEdits({ t: "report.txt" }, undefined, dir)[0]).toEqual({ key: "t", ref: "slot:t", str: "report.txt" });
    put("e.gif", "x");
    expect(planEdits({ t: "see e.gif now" }, undefined, dir)[0]!.str).toBe("see e.gif now");
    expect(planEdits({ t: "3.50" }, undefined, dir)[0]!.str).toBe("3.50");
  });

  it("the object form lists the eight extensions when image has another type", () => {
    put("f.gif", "x");
    expect(() => planEdits({ p: { image: "f.gif" } }, undefined, dir)).toThrow(/not a \.png, \.jpg, \.jpeg, \.webp, \.heic, \.heif, \.tif or \.tiff file/);
    put("g.heic", "x");
    expect(planEdits({ p: { image: "g.heic" } }, undefined, dir)[0]!.image).toBe(join(dir, "g.heic"));
  });
});

describe("EXIF orientation in the plan (J2)", () => {
  it("orientation 6 gives rotate 90 on the plain string and on the object form", () => {
    put("rot6.jpg", jpegWith(6));
    const [s, o] = planEdits({ a: "rot6.jpg", b: { image: "rot6.jpg", fit: "cover" } }, undefined, dir);
    expect(s).toMatchObject({ strImage: join(dir, "rot6.jpg"), rotate: 90 });
    expect(s).not.toHaveProperty("mirror");
    expect(o).toMatchObject({ fit: "cover", rotate: 90 });
  });

  it("other orientations map to rotate and mirror; 1 and a PNG add no field", () => {
    put("rot3.jpg", jpegWith(3));
    put("rot5.jpg", jpegWith(5));
    put("rot2.jpg", jpegWith(2));
    put("rot1.jpg", jpegWith(1));
    put("flat.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    const e = planEdits({ a: "rot3.jpg", b: "rot5.jpg", c: "rot2.jpg", d: "rot1.jpg", f: "flat.png" }, undefined, dir);
    expect(e[0]).toMatchObject({ rotate: 180 });
    expect(e[1]).toMatchObject({ rotate: 270, mirror: true });
    expect(e[2]).toMatchObject({ mirror: true });
    expect(e[2]).not.toHaveProperty("rotate");
    for (const i of [3, 4]) {
      expect(e[i]).not.toHaveProperty("rotate");
      expect(e[i]).not.toHaveProperty("mirror");
    }
  });
});

describe("apply script source", () => {
  const script = FILL_APPLY(UUID, planEdits({ headline: "Hi" }, undefined, dir), false);

  it("uses the anchor, board and shrink helpers and undoes on failure", () => {
    for (const s of ["axiAlignOf", "axiBoardBox", "axiShrinkText", "doc.undo()", "canUndo", "out.error", "out.cleaned", "notes: []"]) expect(script).toContain(s);
  });

  it("carries the note vocabularies", () => {
    for (const s of ["text shrunk from ", " to stay on ", " to fit its ", "(the floor); still ", " px past the ", " edge of ", " into the ", " margin of ", "' frame'"]) expect(script).toContain(s);
    expect(script).not.toContain(" frame even at ");
    expect(script).not.toContain(" even at ");
    expect(script).toContain("overflows its ");
    expect(script).toContain("runs ");
    expect(script).toContain("(cannot shrink below 8 px)");
  });

  it("is syntactically valid with the helpers and passes the blocking and AI scans", () => {
    expect(() => new Function(script + "\n" + HELPERS_SOURCE)).not.toThrow();
    expect(scanForBlocking(script)).toEqual([]);
    expect(scanForAi(script)).toEqual([]);
  });

  it("the image tuple has nine entries: rotate at 7, mirror at 8", () => {
    expect(script).toContain("ops[ops.length - 1].push(e.rotate || 0, !!e.mirror)");
    expect(script).toContain("'', false, '', '', 0, e.rotate || 0, !!e.mirror]");
    expect(script).toContain("if (op[7]) { io.rotate = op[7]; }");
    expect(script).toContain("if (op[8]) { io.mirror = true; }");
  });
});

// ---- evaluating the apply script against stubs ----

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface StubNode {
  box: Box;
  align: "l" | "c" | "r";
  /** Width after setText (the old width when absent). */
  grownW?: number;
  [Symbol.toStringTag]?: string;
  isImageNode?: boolean;
}
interface Rig {
  nodes: Record<string, StubNode>;
  texts?: string[];
  board: Box & { name: string };
  /** What axiShrinkText answers; may edit the node box. */
  shrink?: (o: { w: number; h: number }, n: StubNode) => { from: number; size: number; fits: boolean };
  /** Throws at the n-th mutation (1-based) with this message. */
  failAt?: { n: number; message: string };
  /** Refuses to become clean. */
  stubbornDirty?: boolean;
  startDirty?: boolean;
}

const PREAMBLE = `
function axiNames(d) { return Object.keys(T.rig.nodes).map(function (k) { return { name: k }; }); }
function axiResolve(d, ref) {
  const n = T.rig.nodes[ref];
  return n ? [{ node: n, path: '0/1', text: n.isImageNode ? null : 'x' }] : [];
}
function axiFind(d, ref) { return T.rig.nodes[ref]; }
function axiNodeBox(n) { return { x: n.box.x, y: n.box.y, w: n.box.w, h: n.box.h }; }
function axiAlignOf(n) { return n.align; }
function axiBoardBox(d, n) { return T.rig.board; }
function axiSetText(d, ref, text) { T.touch('text:' + ref + ':' + text); const n = T.rig.nodes[ref]; if (n.grownW) { n.box.w = n.grownW; } return n; }
function axiShrinkText(d, ref, o) { T.log.push('shrink:' + ref + ':' + Math.round(o.w) + 'x' + (o.h > 1e8 ? 'inf' : Math.round(o.h))); return T.rig.shrink(o, T.rig.nodes[ref]); }
function axiSetBox(d, ref, b) { T.touch('box:' + ref + ':' + JSON.stringify(b)); if (b.x !== undefined) { T.rig.nodes[ref].box.x = b.x; } }
function axiSetFill(d, ref, hex) { T.touch('fill:' + ref + ':' + hex); }
function axiReplaceImage(d, node, path, io) { T.touch('image:' + path + ':' + JSON.stringify(io)); return node; }
function axiColourise() { T.touch('colourise'); }
function axiCutout() { T.touch('cutout'); }
`;

function evaluate(rig: Rig, edits: ReturnType<typeof planEdits>, ignoreUnknown = false): { reply: ApplyReply; log: string[]; undos: number } {
  const log: string[] = [];
  let mutations = 0;
  let undos = 0;
  const doc: any = {
    sessionUuid: UUID,
    isDirty: rig.startDirty ?? false,
    get canUndo() {
      return doc.isDirty;
    },
    undo: () => {
      undos++;
      mutations = Math.max(0, mutations - 1);
      if (!rig.stubbornDirty && mutations === 0) doc.isDirty = false;
    },
  };
  const T = {
    rig,
    log,
    touch: (what: string) => {
      mutations++;
      doc.isDirty = true;
      log.push(what);
      if (rig.failAt && mutations === rig.failAt.n) throw new Error(rig.failAt.message);
    },
  };
  const modules: Record<string, unknown> = {
    "/document.js": { Document: { all: [doc] } },
    "/commands.js": { DocumentCommand: {} },
    "/selections.js": { Selection: {} },
  };
  const outputs: string[] = [];
  const script = FILL_APPLY(UUID, edits, ignoreUnknown);
  new Function("require", "console", "T", `${PREAMBLE}\n${script}`)((id: string) => modules[id], { log: (s: string) => outputs.push(s) }, T);
  return { reply: JSON.parse(outputs[0]!) as ApplyReply, log, undos };
}

const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const BOARD = { x: 0, y: 0, w: 1080, h: 1080, name: "ig-square" };
const tag = (n: StubNode, t: string): StubNode => {
  n[Symbol.toStringTag] = t;
  return n;
};
const edit = (key: string, value: string) => planEdits({ [key]: value }, undefined, dir);

describe("apply script: text anchor and shrink (D1b, D2, D10)", () => {
  it("a frame slot that does not fit gets a shrink note with the frame size", () => {
    const rig: Rig = {
      nodes: { "slot:para": tag({ box: box(90, 200, 400, 120), align: "l" }, "FrameTextNode") },
      texts: [],
      board: BOARD,
      shrink: (o) => ({ from: 32, size: 19, fits: true }),
    };
    const { reply, log } = evaluate(rig, edit("para", "A very long paragraph"));
    expect(log).toContain("shrink:slot:para:400x120");
    expect(reply.notes).toEqual(["para: text shrunk from 32 to 19 px to fit its 400x120 frame"]);
    expect(reply.applied).toEqual(["para"]);
  });

  it("a frame that cannot fit at the floor says so; one that fits says nothing", () => {
    const base = (): Rig => ({ nodes: { "slot:para": tag({ box: box(90, 200, 400, 120), align: "l" }, "FrameTextNode") }, texts: [], board: BOARD });
    const over = evaluate({ ...base(), shrink: () => ({ from: 32, size: 16, fits: false }) }, edit("para", "x"));
    expect(over.reply.notes).toEqual(["para: text shrunk from 32 to 16 px (the floor); still overflows its 400x120 frame"]);
    const stuck = evaluate({ ...base(), shrink: () => ({ from: 8, size: 8, fits: false }) }, edit("para", "x"));
    expect(stuck.reply.notes).toEqual(["para: overflows its 400x120 frame at 8 px (cannot shrink below 8 px)"]);
    const ok = evaluate({ ...base(), shrink: () => ({ from: 32, size: 32, fits: true }) }, edit("para", "x"));
    expect(ok.reply.notes).toEqual([]);
  });

  it("a right-anchored art line is never moved", () => {
    const rig: Rig = {
      nodes: { "slot:right": { box: box(500, 100, 400, 60), align: "r", grownW: 500 } },
      texts: [],
      board: BOARD,
      shrink: () => ({ from: 64, size: 64, fits: true }),
    };
    const { log, reply } = evaluate(rig, edit("right", "longer text"));
    expect(log).toContain("shrink:slot:right:720xinf"); // 900 - 0 - (1080 - 900)
    expect(log.filter((s) => s.startsWith("box:"))).toEqual([]);
    expect(rig.nodes["slot:right"]!.box.x).toBe(500);
    expect(reply.notes).toEqual([]);
  });

  it("a centre line is never moved; a left line is never moved either", () => {
    const centre: Rig = { nodes: { "slot:mid": { box: box(340, 100, 400, 60), align: "c", grownW: 600 } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 64, fits: true }) };
    const c = evaluate(centre, edit("mid", "wider"));
    expect(c.log).toContain("shrink:slot:mid:1080xinf");
    expect(c.log.filter((s) => s.startsWith("box:"))).toEqual([]);
    expect(centre.nodes["slot:mid"]!.box.x).toBe(340);
    const left: Rig = { nodes: { "slot:left": { box: box(90, 100, 400, 60), align: "l", grownW: 600 } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 64, fits: true }) };
    const l = evaluate(left, edit("left", "wider"));
    expect(l.log).toContain("shrink:slot:left:900xinf"); // 1080 - 90 margin - 90 x
    expect(l.log.filter((s) => s.startsWith("box:"))).toEqual([]);
    expect(left.nodes["slot:left"]!.box.x).toBe(90);
  });

  it("art text shrunk to stay on the board says so, naming the board or the document", () => {
    const mk = (): Rig => ({ nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l", grownW: 1100 } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 41, fits: true }) });
    expect(evaluate(mk(), edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 41 px to stay on ig-square"]);
    const noBoard = mk();
    noBoard.board = { ...BOARD, name: "" };
    expect(evaluate(noBoard, edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 41 px to stay on the document"]);
  });

  it("art text at the floor says how far it still runs: into the margin, then past the edge", () => {
    const mk = (grownW: number): Rig => ({ nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l", grownW } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 32, fits: false }) });
    expect(evaluate(mk(950), edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 32 px (the floor); still runs 50 px into the right margin of ig-square"]);
    expect(evaluate(mk(1110), edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 32 px (the floor); still runs 120 px past the right edge of ig-square"]);
    const noBoard = mk(1110);
    noBoard.board = { ...BOARD, name: "" };
    expect(evaluate(noBoard, edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 32 px (the floor); still runs 120 px past the right edge of the document"]);
  });

  it("art text already at 8 px that still runs off says it cannot shrink further", () => {
    const rig: Rig = { nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l", grownW: 1200 } }, texts: [], board: BOARD, shrink: () => ({ from: 8, size: 8, fits: false }) };
    expect(evaluate(rig, edit("headline", "long")).reply.notes).toEqual(["headline: runs 210 px past the right edge of ig-square at 8 px (cannot shrink below 8 px)"]);
  });

  it("a right-anchored line at the floor inside the board reports the left margin", () => {
    // Affinity keeps the right edge (900) on its anchor: the grown line starts at 100, the mirrored margin is 180.
    const rig: Rig = {
      nodes: { "slot:right": { box: box(500, 100, 400, 60), align: "r", grownW: 800 } },
      texts: [],
      board: BOARD,
      shrink: (_o, n) => {
        n.box.x = 900 - n.box.w;
        return { from: 64, size: 32, fits: false };
      },
    };
    const { reply, log } = evaluate(rig, edit("right", "long"));
    expect(reply.notes).toEqual(["right: text shrunk from 64 to 32 px (the floor); still runs 80 px into the left margin of ig-square"]);
    expect(log.filter((s) => s.startsWith("box:"))).toEqual([]);
  });

  it("a floor with no measured overshoot still names the shrink", () => {
    const rig: Rig = { nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l" } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 32, fits: false }) };
    expect(evaluate(rig, edit("headline", "long")).reply.notes).toEqual(["headline: text shrunk from 64 to 32 px (the floor)"]);
  });

  it("an empty value skips the fit and the notes", () => {
    const rig: Rig = { nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l" } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 20, fits: true }) };
    const { log, reply } = evaluate(rig, edit("headline", ""));
    expect(log.some((s) => s.startsWith("shrink:"))).toBe(false);
    expect(reply.notes).toEqual([]);
    expect(reply.applied).toEqual(["headline"]);
  });

  it("an image op passes rotate, mirror and fit to axiReplaceImage", () => {
    put("o7.jpg", jpegWith(7));
    const rig: Rig = { nodes: { "slot:photo": { box: box(0, 0, 400, 400), align: "l", isImageNode: true } }, texts: [], board: BOARD };
    const edits = planEdits({ photo: { image: "o7.jpg", fit: "cover" } }, undefined, dir);
    const { log } = evaluate(rig, edits);
    expect(log).toContain(`image:${join(dir, "o7.jpg")}:{"fit":"cover","rotate":90,"mirror":true}`);
    const plain = evaluate(rig, planEdits({ photo: "o7.jpg" }, undefined, dir));
    expect(plain.log).toContain(`image:${join(dir, "o7.jpg")}:{"rotate":90,"mirror":true}`);
  });
});

describe("apply script: exception safety (J4)", () => {
  const photo = (): Rig => ({ nodes: { "slot:headline": { box: box(90, 100, 400, 60), align: "l" }, "slot:photo": { box: box(0, 0, 400, 400), align: "l", isImageNode: true } }, texts: [], board: BOARD, shrink: () => ({ from: 64, size: 64, fits: true }) });

  it("a failing step is caught, undone until clean and reported", () => {
    put("p.png", "x");
    const rig = photo();
    rig.failAt = { n: 2, message: "axiSelectSubject: no subject found" };
    const edits = planEdits({ headline: "Hi", photo: { image: "p.png" } }, undefined, dir);
    const { reply, undos } = evaluate(rig, edits);
    expect(reply.error).toBe("axiSelectSubject: no subject found");
    expect(reply.cleaned).toBe(true);
    expect(reply.applied).toEqual([]);
    expect(undos).toBeGreaterThanOrEqual(2);
  });

  it("reports cleaned false when undo cannot clean the document", () => {
    put("p.png", "x");
    const rig = photo();
    rig.failAt = { n: 2, message: "boom" };
    rig.stubbornDirty = true;
    const { reply, undos } = evaluate(rig, planEdits({ headline: "Hi", photo: { image: "p.png" } }, undefined, dir));
    expect(reply.error).toBe("boom");
    expect(reply.cleaned).toBe(false);
    expect(undos).toBe(200);
  });

  it("never undoes a document that was already dirty", () => {
    const rig = photo();
    rig.startDirty = true;
    rig.failAt = { n: 1, message: "boom" };
    const { reply, undos } = evaluate(rig, edit("headline", "Hi"));
    expect(undos).toBe(0);
    expect(reply).toMatchObject({ error: "boom", cleaned: false, applied: [] });
  });

  it("a clean run has no error field and a notes array", () => {
    const { reply } = evaluate(photo(), edit("headline", "Hi"));
    expect(reply).not.toHaveProperty("error");
    expect(reply).not.toHaveProperty("cleaned");
    expect(reply.notes).toEqual([]);
  });
});
