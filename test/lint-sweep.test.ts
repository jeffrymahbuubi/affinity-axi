// Live-sweep lint fixes: pixel layers (Raster), --min-font scaled by dpi,
// off-board text, and zero-width-space text. Hand-built inventories as in
// lint.test.ts; one command test through the fake MCP server.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/lint.js";
import { lintInventory, type LintOptions } from "../src/affinity/lint.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

type Box = [number, number, number, number];

let server: FakeServer;
const origUrl = process.env["AFFINITY_MCP_URL"];
const lint = make(fakeConnect());

const board = (path: string, name: string, box: Box, fill?: string): InventoryNode => ({
  path, type: "Artboard", name, box, visible: true, ...(fill ? { fill } : {}),
});
const shape = (path: string, ab: string, box: Box, fill: string): InventoryNode => ({
  path, type: "Shape", name: "", box, visible: true, artboard: ab, fill,
});
const layer = (path: string, ab: string, type: string, box: Box): InventoryNode => ({
  path, type, name: "", box, visible: true, artboard: ab,
});
const txt = (path: string, ab: string | undefined, box: Box, fill: string, size: number, extra: Partial<InventoryNode> = {}): InventoryNode => ({
  path, type: "ArtText", name: "", box, visible: true, ...(ab !== undefined ? { artboard: ab } : {}),
  text: "Hello", font: `Helvetica ${size}`, fill, ...extra,
});

function inv(nodes: InventoryNode[], boards: Array<{ name: string; path: string; box: Box }>, dpi = 72, w = 1080, h = 1080): Inventory {
  return {
    at: "2026-11-01T00:00:00.000Z",
    doc: { uuid: FIXTURE_UUID, title: "<Untitled>", path: "", units: "Pixel", width: w, height: h, dpi },
    artboards: boards,
    nodes,
    counts: { nodes: nodes.length, named: 0, text: 0, images: 0 },
  };
}

const BOARD = [{ name: "ig-square", path: "0/0", box: [0, 0, 1080, 1080] as Box }];
const square = (...rest: InventoryNode[]): Inventory => inv([board("0/0", "ig-square", [0, 0, 1080, 1080], "#FFFFFF"), ...rest], BOARD);
const bare = (dpi: number, ...rest: InventoryNode[]): Inventory => inv(rest, [], dpi);
const OPTS: LintOptions = { minFont: 20, strict: false };
const run = (i: Inventory, o: Partial<LintOptions> = {}) => lintInventory(i, { ...OPTS, ...o });
const of = (r: ReturnType<typeof run>, check: string) => r.findings.filter((f) => f.check === check);

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
});

describe("L1: text over a pixel layer", () => {
  const white = txt("0/0/1", "ig-square", [100, 100, 300, 60], "#FFFFFF", 40);

  it("a Raster node under the text centre skips the contrast check", () => {
    const r = run(square(layer("0/0/0", "ig-square", "Raster", [0, 0, 1080, 1080]), white));
    expect(of(r, "contrast")).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("an Image node still skips it", () => {
    const r = run(square(layer("0/0/0", "ig-square", "Image", [0, 0, 1080, 1080]), white));
    expect(of(r, "contrast")).toHaveLength(0);
    expect(r.skipped).toBe(1);
  });

  it("a solid shape between the text and the raster still wins", () => {
    const r = run(square(layer("0/0/0", "ig-square", "Raster", [0, 0, 1080, 1080]), shape("0/0/1", "ig-square", [0, 0, 1080, 400], "#FFFFFF"), { ...white, path: "0/0/2" }));
    expect(r.skipped).toBe(0);
    expect(of(r, "contrast")).toHaveLength(1);
    expect(of(r, "contrast")[0]!.detail).toBe("1.00:1 #FFFFFF on #FFFFFF (shape 0/0/1) needs 3:1");
  });
});

describe("L2: --min-font scales with dpi", () => {
  it("300 dpi: font 20 warns with the dpi detail, font 90 passes", () => {
    const r = run(bare(300, txt("0/0", undefined, [10, 10, 200, 40], "#000000", 20, { name: "small" }), txt("0/1", undefined, [10, 100, 400, 120], "#000000", 90, { name: "big" })));
    const f = of(r, "min-font");
    expect(f).toHaveLength(1);
    expect(f[0]!.node).toBe("small");
    expect(f[0]!.severity).toBe("warning");
    expect(f[0]!.detail).toBe("20 px is below the 83 px minimum at 300 dpi (20 px at 72 dpi; 4.8 pt)");
  });

  it("72 dpi wording is unchanged", () => {
    const r = run(square(txt("0/0/1", "ig-square", [100, 100, 300, 20], "#000000", 14)));
    expect(of(r, "min-font")[0]!.detail).toBe("14 px is below the 20 px minimum");
  });

  it("the scaled minimum is named before the 72 dpi figure", () => {
    const r = run(bare(300, txt("0/0", undefined, [10, 10, 200, 40], "#000000", 20, { name: "small" })));
    const d = of(r, "min-font")[0]!.detail;
    expect(d).toMatch(/below the \d+ px minimum at \d+ dpi/);
    expect(d.indexOf("83 px minimum")).toBeLessThan(d.indexOf("20 px at 72 dpi"));
  });

  it("a font exactly at the scaled minimum passes", () => {
    const r = run(bare(144, txt("0/0", undefined, [10, 10, 200, 40], "#000000", 40)));
    expect(of(r, "min-font")).toHaveLength(0);
    const w = run(bare(144, txt("0/0", undefined, [10, 10, 200, 40], "#000000", 39)));
    expect(of(w, "min-font")[0]!.detail).toBe("39 px is below the 40 px minimum at 144 dpi (20 px at 72 dpi; 19.5 pt)");
  });
});

describe("D10: off-board", () => {
  it("text leaving a document without artboards is an error against the document", () => {
    const r = run(bare(72, txt("0/0", undefined, [762, 101, 464, 64], "#000000", 64, { name: "slot:headline" })));
    const f = of(r, "off-board");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.node).toBe("slot:headline");
    expect(f[0]!.detail).toBe("extends 146 px past the right edge of the document");
  });

  it("names the artboard when the text sits on one", () => {
    const r = run(square(txt("0/0/1", "ig-square", [762, 101, 464, 64], "#000000", 64)));
    expect(of(r, "off-board")[0]!.detail).toBe("extends 146 px past the right edge of ig-square");
  });

  it("text inside the artboard (and touching its edge) gives none", () => {
    const r = run(square(txt("0/0/1", "ig-square", [90, 101, 900, 64], "#000000", 64), txt("0/0/2", "ig-square", [600, 900, 480, 180], "#000000", 64)));
    expect(of(r, "off-board")).toHaveLength(0);
  });

  it("two sides are joined with and, in one finding", () => {
    const r = run(square(txt("0/0/1", "ig-square", [-20, 1000, 300, 100], "#000000", 40)));
    const f = of(r, "off-board");
    expect(f).toHaveLength(1);
    expect(f[0]!.detail).toBe("extends 20 px past the left edge of ig-square and 20 px past the bottom edge of ig-square");
  });

  it("uses the artboard box, not the document, and ignores platform insets", () => {
    const boards = [{ name: "ig-square", path: "0/0", box: [2000, 0, 1080, 1080] as Box }];
    const i = inv([board("0/0", "ig-square", [2000, 0, 1080, 1080], "#FFFFFF"), txt("0/0/1", "ig-square", [2100, 100, 300, 60], "#000000", 40)], boards, 72, 4000, 1080);
    expect(of(run(i), "off-board")).toHaveLength(0);
    const out = inv([board("0/0", "ig-square", [2000, 0, 1080, 1080], "#FFFFFF"), txt("0/0/1", "ig-square", [1900, 100, 300, 60], "#000000", 40)], boards, 72, 4000, 1080);
    expect(of(run(out), "off-board")[0]!.detail).toBe("extends 100 px past the left edge of ig-square");
  });

  it("uses the ink box: a spread box 19 px past the edge with the ink inside gives none", () => {
    const r = run(square(txt("0/0/1", "ig-square", [790, 101, 299, 64], "#000000", 64, { ink: [788, 101, 280, 64] })));
    expect(of(r, "off-board")).toHaveLength(0);
  });

  it("an ink box past the edge is an error carrying the ink overshoot", () => {
    const r = run(square(txt("0/0/1", "ig-square", [790, 101, 280, 64], "#000000", 64, { ink: [800, 101, 290, 64] })));
    expect(of(r, "off-board")[0]!.detail).toBe("extends 10 px past the right edge of ig-square");
  });

  it("a text row without ink falls back to the spread box", () => {
    const r = run(square(txt("0/0/1", "ig-square", [790, 101, 299, 64], "#000000", 64)));
    expect(of(r, "off-board")[0]!.detail).toBe("extends 9 px past the right edge of ig-square");
  });

  it("text outside every artboard of an artboard document (pasteboard) is not checked", () => {
    const r = run(square(txt("0/1", undefined, [5000, 5000, 300, 60], "#000000", 40)));
    expect(of(r, "off-board")).toHaveLength(0);
  });

  it("--strict leaves errors as errors and errors sort first", () => {
    const i = square(txt("0/0/1", "ig-square", [762, 101, 464, 14], "#000000", 14, { name: "w" }));
    const r = run(i, { strict: true });
    expect(r.findings.map((f) => `${f.severity}:${f.check}`)).toEqual(["error:min-font", "error:off-board"]);
    const lax = run(i);
    expect(lax.findings.map((f) => `${f.severity}:${f.check}`)).toEqual(["error:off-board", "warning:min-font"]);
  });
});

describe("D5: zero-width-space text is empty", () => {
  const ZW = String.fromCharCode(8203);

  it("produces no contrast, min-font or off-board finding and is not counted as skipped", () => {
    const r = run(square(txt("0/0/1", "ig-square", [1200, 100, 300, 14], "#FFFFFF", 8, { text: ZW })));
    expect(r.findings).toHaveLength(0);
    expect(r.skipped).toBe(0);
  });

  it("text with real ink next to a zero-width space is still checked", () => {
    const r = run(square(txt("0/0/1", "ig-square", [100, 100, 300, 14], "#FFFFFF", 14, { text: ZW + "Hi" })));
    expect(of(r, "contrast")).toHaveLength(1);
    expect(of(r, "min-font")).toHaveLength(1);
  });
});

describe("command", () => {
  it("--min-font 20 on a 300 dpi document prints the dpi detail", async () => {
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    server.onScript("affinity-axi:inspect", JSON.stringify(bare(300, txt("0/0", undefined, [10, 10, 200, 40], "#000000", 20, { name: "small" }))));
    const r = await runCommand(lint, ["current", "--min-font", "20"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("small,20 px is below the 83 px minimum at 300 dpi (20 px at 72 dpi; 4.8 pt)");
  });

  it("an off-board text exits 1", async () => {
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    server.onScript("affinity-axi:inspect", JSON.stringify(bare(72, txt("0/0", undefined, [762, 101, 464, 64], "#000000", 64, { name: "slot:headline" }))));
    const r = await runCommand(lint, ["current"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error,off-board,slot:headline,extends 146 px past the right edge of the document");
  });
});
