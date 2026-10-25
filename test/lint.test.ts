// `lint`: the pure rules (affinity/lint.ts) and the command, in-process against
// the fake MCP server. The inspect handler returns a hand-built Inventory.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/lint.js";
import { loadBrand } from "../src/affinity/brand.js";
import { backgroundFor, fontPx, lintInventory, type LintOptions } from "../src/affinity/lint.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

type Box = [number, number, number, number];

let server: FakeServer;
let dir: string;
const origUrl = process.env["AFFINITY_MCP_URL"];
const origBrand = process.env["AFFINITY_AXI_BRAND"];
const lint = make(fakeConnect());
const KIT = loadBrand("examples/_brand/brand.json").kit;

const board = (path: string, name: string, box: Box, fill?: string): InventoryNode => ({
  path, type: "Artboard", name, box, visible: true, ...(fill ? { fill } : {}),
});
const shape = (path: string, ab: string, box: Box, fill: string, extra: Partial<InventoryNode> = {}): InventoryNode => ({
  path, type: "Shape", name: "", box, visible: true, artboard: ab, fill, ...extra,
});
const txt = (path: string, ab: string, box: Box, fill: string, size: number, extra: Partial<InventoryNode> = {}): InventoryNode => ({
  path, type: "ArtText", name: "", box, visible: true, artboard: ab, text: "Hello", font: `Helvetica ${size}`, fill, ...extra,
});

function inv(nodes: InventoryNode[], boards: Array<{ name: string; path: string; box: Box }> = [{ name: "ig-square", path: "0/0", box: [0, 0, 1080, 1080] }]): Inventory {
  return {
    at: "2026-10-26T00:00:00.000Z",
    doc: { uuid: FIXTURE_UUID, title: "<Untitled>", path: "", units: "Pixel", width: 1080, height: 1080, dpi: 72 },
    artboards: boards,
    nodes,
    counts: { nodes: nodes.length, named: 0, text: 0, images: 0 },
  };
}

const squareOn = (fill: string, ...rest: InventoryNode[]): Inventory => inv([board("0/0", "ig-square", [0, 0, 1080, 1080], fill), ...rest]);
const square = (...rest: InventoryNode[]): Inventory => squareOn("#FFFFFF", ...rest);
const OPTS: LintOptions = { minFont: 20, strict: false };
const run = (i: Inventory, o: Partial<LintOptions> = {}) => lintInventory(i, { ...OPTS, ...o });

function stub(i: Inventory): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
  server.onScript("affinity-axi:inspect", JSON.stringify(i));
}

const STORY = [{ name: "story", path: "0/0", box: [0, 0, 1080, 1920] as Box }];
const storyDoc = (...rest: InventoryNode[]): Inventory => inv([board("0/0", "story", [0, 0, 1080, 1920], "#FFFFFF"), ...rest], STORY);

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  delete process.env["AFFINITY_AXI_BRAND"];
  dir = mkdtempSync(join(tmpdir(), "axi-lint-"));
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  if (origBrand !== undefined) process.env["AFFINITY_AXI_BRAND"] = origBrand;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("contrast", () => {
  it("flags low contrast over a shape and prints the measured ratio", () => {
    const r = run(square(shape("0/0/0", "ig-square", [0, 0, 1080, 400], "#888888"), txt("0/0/1", "ig-square", [100, 100, 300, 40], "#777777", 28)));
    const f = r.findings.filter((x) => x.check === "contrast");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.detail).toBe("1.26:1 #777777 on #888888 (shape 0/0/0) needs 3:1");
  });

  it("needs 4.5:1 under 24 px and 3:1 from 24 px up", () => {
    const small = run(square(txt("0/0/0", "ig-square", [100, 100, 300, 20], "#8C8C8C", 16)));
    expect(small.findings.map((f) => f.check)).toEqual(["contrast", "min-font"]);
    expect(small.findings[0]!.detail).toContain("needs 4.5:1");
    const big = run(square(txt("0/0/0", "ig-square", [100, 100, 300, 40], "#8C8C8C", 30)));
    expect(big.findings).toEqual([]);
  });

  it("falls back to the artboard fill, then to assumed white", () => {
    const withFill = inv([board("0/0", "ig-square", [0, 0, 1080, 1080], "#888888"), txt("0/0/0", "ig-square", [100, 100, 300, 40], "#777777", 30)]);
    expect(backgroundFor(withFill, withFill.nodes[1]!)).toEqual({ hex: "#888888", assumed: false, from: "artboard ig-square" });
    expect(run(withFill).findings[0]!.detail).toBe("1.26:1 #777777 on #888888 (artboard ig-square) needs 3:1");

    const bare = inv([board("0/0", "ig-square", [0, 0, 1080, 1080]), txt("0/0/0", "ig-square", [100, 100, 300, 40], "#DDDDDD", 30)]);
    expect(backgroundFor(bare, bare.nodes[1]!)).toEqual({ hex: "#FFFFFF", assumed: true, from: "assumed" });
    const f = run(bare).findings[0]!;
    expect(f.check).toBe("contrast");
    expect(f.detail).toContain("against #FFFFFF (assumed)");
  });

  it("uses the nearest solid fill below, ignores shapes that miss the text centre, hidden ones and ones above", () => {
    const i = square(
      shape("0/0/0", "ig-square", [0, 0, 1080, 1080], "#000000"),
      shape("0/0/1", "ig-square", [600, 600, 100, 100], "#FFFFFF"),
      shape("0/0/2", "ig-square", [0, 0, 1080, 1080], "#FF0000", { visible: false }),
      txt("0/0/3", "ig-square", [100, 100, 300, 40], "#FFFFFF", 30),
      shape("0/0/4", "ig-square", [0, 0, 1080, 1080], "#FFFFFF"),
    );
    expect(backgroundFor(i, i.nodes[4]!)).toEqual({ hex: "#000000", assumed: false, from: "shape 0/0/0" });
    expect(run(i).findings.filter((f) => f.check === "contrast")).toEqual([]);
  });

  it("skips text over a photo or gradient and with no solid fill, and counts it", () => {
    const photo = square(
      { path: "0/0/0", type: "Image", name: "", box: [0, 0, 1080, 1080], visible: true, artboard: "ig-square" },
      txt("0/0/1", "ig-square", [100, 100, 300, 40], "#777777", 30),
    );
    expect(run(photo)).toMatchObject({ findings: [], skipped: 1 });
    const grad = square(shape("0/0/0", "ig-square", [0, 0, 1080, 1080], "gradient"), txt("0/0/1", "ig-square", [100, 100, 300, 40], "#777777", 30));
    expect(run(grad).skipped).toBe(1);
    const noFill = square(txt("0/0/0", "ig-square", [100, 100, 300, 40], "gradient", 30));
    expect(run(noFill)).toMatchObject({ findings: [], skipped: 1 });
  });
});

describe("safe zone", () => {
  it("flags text inside the top inset of a story-sized artboard and passes it clear of the insets", () => {
    const r = run(storyDoc(txt("0/0/0", "story", [100, 100, 600, 80], "#000000", 40)));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: "error", check: "safe-zone" });
    expect(r.findings[0]!.detail).toBe("crosses top safe inset (250 px) of story");
    expect(run(storyDoc(txt("0/0/0", "story", [100, 400, 600, 80], "#000000", 40))).findings).toEqual([]);
  });

  it("flags the bottom inset and names both sides when two are crossed", () => {
    const b = run(storyDoc(txt("0/0/0", "story", [100, 1700, 600, 80], "#000000", 40)));
    expect(b.findings[0]!.detail).toBe("crosses bottom safe inset (340 px) of story");
    const both = run(storyDoc(txt("0/0/0", "story", [100, 100, 600, 1700], "#000000", 40)));
    expect(both.findings[0]!.detail).toBe("crosses top safe inset (250 px) and bottom safe inset (340 px) of story");
  });

  it("--platform ig-portrait applies the 34 px side insets", () => {
    const portrait = inv(
      [board("0/0", "post", [0, 0, 1080, 1350], "#FFFFFF"), txt("0/0/0", "post", [10, 400, 300, 40], "#000000", 40), txt("0/0/1", "post", [800, 400, 270, 40], "#000000", 40)],
      [{ name: "post", path: "0/0", box: [0, 0, 1080, 1350] }],
    );
    const auto = run(portrait);
    expect(auto.findings.map((f) => f.detail)).toEqual(["crosses left safe inset (34 px) of ig-portrait", "crosses right safe inset (34 px) of ig-portrait"]);
    expect(run(portrait, { platform: "ig-portrait" }).findings).toHaveLength(2);
    expect(run(portrait, { platform: "ig-square" }).findings).toHaveLength(0);
  });

  it("an explicit platform applies to every artboard when none has its size", () => {
    const i = square(txt("0/0/0", "ig-square", [100, 100, 600, 80], "#000000", 40));
    expect(run(i).findings).toEqual([]);
    expect(run(i, { platform: "story" }).findings[0]!.detail).toContain("top safe inset (250 px) of story");
  });

  it("an explicit platform skips artboards of another size when one matches", () => {
    const two = inv(
      [board("0/0", "story", [0, 0, 1080, 1920], "#FFFFFF"), txt("0/0/0", "story", [100, 400, 600, 80], "#000000", 40), board("0/1", "square", [1200, 0, 1080, 1080], "#FFFFFF"), txt("0/1/0", "square", [1300, 50, 600, 80], "#000000", 40)],
      [{ name: "story", path: "0/0", box: [0, 0, 1080, 1920] }, { name: "square", path: "0/1", box: [1200, 0, 1080, 1080] }],
    );
    expect(run(two, { platform: "story" }).findings).toEqual([]);
  });

  it("insets are measured from the artboard, not the spread origin", () => {
    const off = inv(
      [board("0/0", "story", [2000, 500, 1080, 1920], "#FFFFFF"), txt("0/0/0", "story", [2100, 600, 600, 80], "#000000", 40)],
      [{ name: "story", path: "0/0", box: [2000, 500, 1080, 1920] }],
    );
    expect(run(off).findings[0]!.check).toBe("safe-zone");
  });
});

describe("min-font", () => {
  it("warns below 20 px by default and honours --min-font", () => {
    const i = square(txt("0/0/0", "ig-square", [100, 100, 300, 20], "#000000", 14));
    expect(run(i).findings).toEqual([expect.objectContaining({ severity: "warning", check: "min-font", detail: "14 px is below the 20 px minimum" })]);
    const mid = square(txt("0/0/0", "ig-square", [100, 100, 300, 24], "#000000", 24));
    expect(run(mid).findings).toEqual([]);
    expect(run(mid, { minFont: 28 }).findings[0]!.detail).toBe("24 px is below the 28 px minimum");
  });

  it("fontPx reads the trailing number and is null without a font", () => {
    const n = txt("0/0/0", "x", [0, 0, 1, 1], "#000000", 48);
    expect(fontPx(n, square())).toBe(48);
    expect(fontPx({ ...n, font: "Fancy Face 12.5" }, square())).toBe(12.5);
    expect(fontPx({ ...n, font: undefined }, square())).toBeNull();
  });
});

describe("slot names", () => {
  const named = (path: string, name: string, extra: Partial<InventoryNode> = {}): InventoryNode =>
    shape(path, "ig-square", [0, 0, 10, 10], "#FFFFFF", { name, ...extra });

  it("an empty key is an error", () => {
    const f = run(square(named("0/0/0", "slot:"))).findings;
    expect(f).toEqual([expect.objectContaining({ severity: "error", check: "slot", node: "slot:" })]);
    expect(f[0]!.detail).toContain("empty key");
  });

  it("a duplicate is reported on the second and later nodes only", () => {
    const f = run(square(named("0/0/0", "slot:title"), named("0/0/1", "slot:title"), named("0/0/2", "slot:title"))).findings;
    expect(f.map((x) => x.path)).toEqual(["0/0/1", "0/0/2"]);
    expect(f.every((x) => x.severity === "error" && x.check === "slot")).toBe(true);
  });

  it("the same slot on different artboards is not a duplicate", () => {
    const two = inv([board("0/0", "a", [0, 0, 100, 100]), shape("0/0/0", "a", [0, 0, 10, 10], "#FFFFFF", { name: "slot:title" }), board("0/1", "b", [200, 0, 100, 100]), shape("0/1/0", "b", [200, 0, 10, 10], "#FFFFFF", { name: "slot:title" })]);
    expect(run(two).findings).toEqual([]);
  });

  it("a key that does not match the pattern is a warning", () => {
    const f = run(square(named("0/0/0", "slot:2x"))).findings;
    expect(f).toEqual([expect.objectContaining({ severity: "warning", check: "slot" })]);
    expect(run(square(named("0/0/0", "slot:price_1-a"), named("0/0/1", "headline"))).findings).toEqual([]);
  });
});

describe("off-kit", () => {
  it("flags a colour outside the kit and accepts kit colours in any case", () => {
    const i = squareOn("#F2F5F9", shape("0/0/0", "ig-square", [0, 0, 10, 10], "#FF00AA", { name: "pill" }), shape("0/0/1", "ig-square", [0, 0, 10, 10], "#1f2a44"), txt("0/0/2", "ig-square", [0, 0, 100, 30], "#1F2A44", 30));
    const f = run(i, { kit: KIT }).findings.filter((x) => x.check === "off-kit");
    expect(f).toEqual([expect.objectContaining({ severity: "warning", node: "pill", detail: "#FF00AA not in kit Lumen Studio (ink, sky, sun, mist)" })]);
  });

  it("is silent without a kit; the artboard fill counts too", () => {
    const i = square(shape("0/0/0", "ig-square", [0, 0, 10, 10], "#FF00AA"));
    expect(run(i).findings).toEqual([]);
    expect(run(i, { kit: KIT }).findings.map((f) => f.path)).toEqual(["0/0", "0/0/0"]);
  });
});

describe("what is checked", () => {
  it("skips hidden nodes, their children and axi-safe-zone guides", () => {
    const i = squareOn(
      "#F2F5F9",
      txt("0/0/0", "ig-square", [100, 100, 300, 20], "#777777", 10, { visible: false }),
      shape("0/0/1", "ig-square", [0, 0, 10, 10], "#FF00AA", { name: "axi-safe-zone" }),
      shape("0/0/2", "ig-square", [0, 0, 10, 10], "#FF00AA", { name: "group", visible: false }),
      txt("0/0/2/0", "ig-square", [100, 100, 300, 20], "#777777", 10),
    );
    expect(run(i, { kit: KIT })).toMatchObject({ findings: [], checked: 1 });
  });

  it("--artboard limits the rules to that artboard", () => {
    const two = inv(
      [board("0/0", "a", [0, 0, 1080, 1080], "#FFFFFF"), txt("0/0/0", "a", [0, 0, 300, 20], "#000000", 10), board("0/1", "b", [1200, 0, 1080, 1080], "#FFFFFF"), txt("0/1/0", "b", [1200, 0, 300, 20], "#000000", 10)],
      [{ name: "a", path: "0/0", box: [0, 0, 1080, 1080] }, { name: "b", path: "0/1", box: [1200, 0, 1080, 1080] }],
    );
    expect(run(two).findings.map((f) => f.path)).toEqual(["0/0/0", "0/1/0"]);
    expect(run(two, { artboard: "b" })).toMatchObject({ checked: 2 });
    expect(run(two, { artboard: "b" }).findings.map((f) => f.path)).toEqual(["0/1/0"]);
  });

  it("sorts errors first, then by path numerically", () => {
    const i = square(
      txt("0/0/10", "ig-square", [0, 0, 300, 20], "#000000", 10),
      txt("0/0/2", "ig-square", [0, 0, 300, 20], "#000000", 10),
      shape("0/0/9", "ig-square", [0, 0, 600, 600], "#888888"),
      txt("0/0/11", "ig-square", [100, 100, 300, 40], "#777777", 30),
    );
    expect(run(i).findings.map((f) => `${f.severity}:${f.path}`)).toEqual(["error:0/0/11", "warning:0/0/2", "warning:0/0/10"]);
  });

  it("--strict turns warnings into errors", () => {
    const f = run(square(txt("0/0/0", "ig-square", [0, 0, 300, 20], "#000000", 10)), { strict: true }).findings;
    expect(f.map((x) => x.severity)).toEqual(["error"]);
  });

  it("names a node by its name, else its path and text", () => {
    const i = square(txt("0/0/0", "ig-square", [0, 0, 300, 20], "#000000", 10, { name: "caption" }), txt("0/0/1", "ig-square", [0, 0, 300, 20], "#000000", 10));
    expect(run(i).findings.map((f) => f.node)).toEqual(["caption", '0/0/1 "Hello"']);
  });
});

describe("lint command", () => {
  const planted = () =>
    squareOn(
      "#F2F5F9",
      shape("0/0/0", "ig-square", [0, 0, 1080, 400], "#F2F5F9"),
      txt("0/0/1", "ig-square", [100, 100, 300, 60], "#1F2A44", 48, { name: "headline" }),
      txt("0/0/2", "ig-square", [100, 200, 300, 20], "#1F2A44", 14, { name: "caption" }),
      shape("0/0/3", "ig-square", [100, 300, 100, 40], "#FF00AA", { name: "pill" }),
    );

  it("prints doc, the table with a header, a summary and help; warnings exit 0", async () => {
    stub(planted());
    const r = await runCommand(lint, ["current", "--brand", "examples/_brand/brand.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("brand: Lumen Studio");
    expect(r.stdout).toContain("lint[2]{severity,check,node,detail}:");
    expect(r.stdout).toContain("  warning,min-font,caption,14 px is below the 20 px minimum");
    expect(r.stdout).toContain('  warning,off-kit,pill,"#FF00AA not in kit Lumen Studio (ink, sky, sun, mist)"');
    expect(r.stdout).toContain("summary: 0 errors, 2 warnings");
    expect(r.stdout).toMatch(/help\[2\]:/);
    expect(r.stdout).toContain(`lint ${FIXTURE_UUID.slice(0, 8)} --strict`);
    expect(r.stdout.indexOf("lint[2]")).toBeLessThan(r.stdout.indexOf("summary:"));
  });

  it("errors exit 1 and sort before warnings", async () => {
    stub(square(shape("0/0/0", "ig-square", [0, 0, 600, 600], "#888888"), txt("0/0/1", "ig-square", [100, 100, 300, 20], "#777777", 14, { name: "tiny" })));
    const r = await runCommand(lint, ["current"]);
    expect(r.code).toBe(1);
    const lines = r.stdout.split("\n");
    const first = lines.findIndex((l) => l.startsWith("  error,contrast,tiny"));
    const second = lines.findIndex((l) => l.startsWith("  warning,min-font,tiny"));
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(r.stdout).toContain("summary: 1 errors, 1 warnings");
  });

  it("a story text at y 100 is an error through the command", async () => {
    stub(storyDoc(txt("0/0/0", "story", [100, 100, 600, 80], "#000000", 40, { name: "title" })));
    const r = await runCommand(lint, ["current"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error,safe-zone,title,crosses top safe inset (250 px) of story");
  });

  it("clean prints the node count and exits 0", async () => {
    stub(square(txt("0/0/0", "ig-square", [100, 100, 300, 60], "#000000", 40)));
    const r = await runCommand(lint, ["current"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("lint: clean (2 nodes checked)");
    expect(r.stdout).toContain("summary: 0 errors, 0 warnings");
    expect(r.stdout).not.toContain("lint[");
  });

  it("notes the text it could not measure", async () => {
    stub(square(txt("0/0/0", "ig-square", [100, 100, 300, 60], "gradient", 40)));
    const r = await runCommand(lint, ["current"]);
    expect(r.stdout).toContain("note: 1 text nodes skipped (no solid fill)");
  });

  it("--strict exits 1 on warnings only", async () => {
    stub(planted());
    const r = await runCommand(lint, ["current", "--brand", "examples/_brand/brand.json", "--strict"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("summary: 2 errors, 0 warnings");
  });

  it("--platform and --min-font reach the rules", async () => {
    stub(square(txt("0/0/0", "ig-square", [100, 100, 300, 40], "#000000", 24, { name: "t" })));
    const r = await runCommand(lint, ["current", "--platform", "story", "--min-font", "28"]);
    expect(r.stdout).toContain("warning,min-font,t,24 px is below the 28 px minimum");
    expect(r.stdout).toContain("error,safe-zone,t,crosses top safe inset (250 px)");
  });

  it("--artboard narrows the scope; an unknown artboard exits 2 and lists the names", async () => {
    stub(planted());
    const ok = await runCommand(lint, ["current", "--artboard", "ig-square"]);
    expect(ok.code).toBe(0);
    const bad = await runCommand(lint, ["current", "--artboard", "nope"]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("no artboard named 'nope'");
    expect(bad.stdout).toContain("ig-square");
  });

  it("--out writes the findings JSON with its schema and prints the table", async () => {
    stub(planted());
    const out = join(dir, "sub", "lint.json");
    const r = await runCommand(lint, ["current", "--brand", "examples/_brand/brand.json", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`out: ${out}`);
    const j = JSON.parse(readFileSync(out, "utf8"));
    expect(j.schema).toBe("affinity-axi/lint/1");
    expect(j.doc).toBe(FIXTURE_UUID);
    expect(j.findings).toHaveLength(2);
    expect(j.counts).toMatchObject({ errors: 0, warnings: 2 });
    expect(typeof j.at).toBe("string");
  });

  it("makes one listing call and one inspect call", async () => {
    stub(planted());
    await runCommand(lint, ["current"]);
    const scripts = server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
    expect(scripts.filter((s) => s.startsWith("/* affinity-axi:list-documents */"))).toHaveLength(1);
    expect(scripts.filter((s) => s.startsWith("/* affinity-axi:inspect */"))).toHaveLength(1);
    expect(scripts.find((s) => s.startsWith("/* affinity-axi:inspect */"))).toContain("const onlyNamed = false;");
  });

  it("usage errors exit 2 and make zero connections", async () => {
    for (const args of [["current", "--platform", "nope"], ["current", "--min-font", "0"], ["current", "--min-font", "big"], ["current", "--brand", join(dir, "missing.brand.json")]]) {
      const r = await runCommand(lint, args);
      expect(r.code).toBe(2);
    }
    expect(server.calls).toHaveLength(0);
  });

  it("an unknown platform names the platforms command", async () => {
    const r = await runCommand(lint, ["current", "--platform", "nope"]);
    expect(r.stdout).toContain("unknown platform 'nope'");
    expect(r.stdout).toContain("platforms");
  });
});
