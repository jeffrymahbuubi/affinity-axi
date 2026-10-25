// export --max-kb: the pure ladder and loop (src/affinity/export-budget.ts), the
// command wiring in export.ts (attempts, no-fit exit, per-artboard, manifest) and
// the alt-text line that every export prints.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Parsed } from "../src/cli/args.js";
import {
  budgetFor,
  fitBudget,
  formatChange,
  isRasterPreset,
  ladderFor,
  MAX_KB_FLAG,
  MIN_SCALE_FLAG,
  noFitMessage,
  scaledDim,
  type Step,
} from "../src/affinity/export-budget.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";
import { readManifest, writeManifest } from "../src/affinity/manifest.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { UsageError } from "../src/output/errors.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const LIVE = [
  "PNG",
  "PNG-8 (dithered)",
  "JPEG (Best quality)",
  "JPEG (High quality)",
  "JPEG (Medium quality)",
  "JPEG (Low quality)",
  "WebP (Best Quality)",
  "WebP (High Quality)",
  "WebP (Medium Quality)",
  "WebP (Low Quality)",
  "WebP (Lossless, smallest)",
  "WebP (Lossless, default)",
  "WebP (Lossless, fastest)",
  "SVG (digital - high quality)",
  "PDF (digital - high quality)",
];
const SIZES = [0.9, 0.8, 0.7, 0.6, 0.5];
const flags = (f: Record<string, string | boolean>): Parsed => ({ positionals: [], flags: f, help: false });
const names = (s: Step[]): string[] => s.map((x) => `${x.preset}@${x.scale}`);
const sizeSteps = (preset: string, scales = SIZES): string[] => scales.map((s) => `${preset}@${s}`);

describe("ladderFor", () => {
  it("steps JPEG quality down, then the size at the lowest quality", () => {
    expect(names(ladderFor("JPEG (Best quality)", LIVE, 0.5))).toEqual([
      "JPEG (Best quality)@1",
      "JPEG (High quality)@1",
      "JPEG (Medium quality)@1",
      "JPEG (Low quality)@1",
      ...sizeSteps("JPEG (Low quality)"),
    ]);
  });

  it("starts at the requested preset and never steps up", () => {
    expect(names(ladderFor("JPEG (Medium quality)", LIVE, 0.9))).toEqual([
      "JPEG (Medium quality)@1",
      "JPEG (Low quality)@1",
      "JPEG (Low quality)@0.9",
    ]);
    expect(names(ladderFor("JPEG (Low quality)", LIVE, 1))).toEqual(["JPEG (Low quality)@1"]);
  });

  it("steps lossy WebP the same way", () => {
    expect(names(ladderFor("WebP (High Quality)", LIVE, 0.8))).toEqual([
      "WebP (High Quality)@1",
      "WebP (Medium Quality)@1",
      "WebP (Low Quality)@1",
      "WebP (Low Quality)@0.9",
      "WebP (Low Quality)@0.8",
    ]);
  });

  it("goes from lossless WebP to smallest, then to the lossy ladder from High", () => {
    const steps = ladderFor("WebP (Lossless, default)", LIVE, 1);
    expect(names(steps)).toEqual([
      "WebP (Lossless, default)@1",
      "WebP (Lossless, smallest)@1",
      "WebP (High Quality)@1",
      "WebP (Medium Quality)@1",
      "WebP (Low Quality)@1",
    ]);
    expect(names(ladderFor("WebP (Lossless, smallest)", LIVE, 1)).slice(0, 2)).toEqual(["WebP (Lossless, smallest)@1", "WebP (High Quality)@1"]);
    expect(formatChange("WebP (Lossless, default)", "WebP (Low Quality)")).toContain("stepped to lossy WebP");
    expect(formatChange("WebP (Lossless, default)", "WebP (Lossless, smallest)")).toBeNull();
  });

  it("goes from PNG to the dithered palette, then to smaller sizes", () => {
    expect(names(ladderFor("PNG", LIVE, 0.8))).toEqual(["PNG@1", "PNG-8 (dithered)@1", "PNG-8 (dithered)@0.9", "PNG-8 (dithered)@0.8"]);
    expect(formatChange("PNG", "PNG-8 (dithered)")).toContain("8-bit palette");
    expect(formatChange("PNG", "PNG")).toBeNull();
    expect(formatChange("JPEG (High quality)", "JPEG (Low quality)")).toBeNull();
  });

  it("skips ladder presets that this install does not list, matching names case-insensitively", () => {
    const live = ["JPEG (High quality)", "jpeg (low quality)"];
    expect(names(ladderFor("JPEG (High quality)", live, 1))).toEqual(["JPEG (High quality)@1", "jpeg (low quality)@1"]);
    expect(names(ladderFor("PNG", ["PNG"], 1))).toEqual(["PNG@1"]);
  });

  it("keeps an unknown variant of a raster family as the only quality step", () => {
    expect(names(ladderFor("JPEG (Print)", LIVE, 0.9))).toEqual(["JPEG (Print)@1", "JPEG (Print)@0.9"]);
  });

  it("bounds the size steps by minScale", () => {
    expect(ladderFor("PNG-8 (dithered)", LIVE, 0.5).filter((s) => s.scale < 1).map((s) => s.scale)).toEqual(SIZES);
    expect(ladderFor("PNG-8 (dithered)", LIVE, 0.7).filter((s) => s.scale < 1).map((s) => s.scale)).toEqual([0.9, 0.8, 0.7]);
    expect(ladderFor("PNG-8 (dithered)", LIVE, 0.95).filter((s) => s.scale < 1)).toEqual([]);
  });

  it.each(["SVG (digital - high quality)", "PDF (digital - high quality)", "Canva Design", "PSD"])("rejects the non-raster preset %s", (p) => {
    expect(() => ladderFor(p, LIVE, 0.5)).toThrow(UsageError);
    expect(() => ladderFor(p, LIVE, 0.5)).toThrow("--max-kb needs a JPEG, WebP or PNG preset");
    expect(isRasterPreset(p)).toBe(false);
  });
});

describe("fitBudget", () => {
  const steps: Step[] = [
    { preset: "A", scale: 1 },
    { preset: "B", scale: 1 },
    { preset: "B", scale: 0.9 },
    { preset: "B", scale: 0.8 },
  ];
  const run = (bytes: number[], budget: number) => {
    let n = 0;
    const seen: Step[] = [];
    return fitBudget(steps, budget, async (s) => {
      seen.push(s);
      return { bytes: bytes[n++]!, size: `${Math.round(100 * s.scale)}x${Math.round(100 * s.scale)}` };
    }).then((r) => ({ ...r, seen }));
  };

  it("stops at the first file at or under the budget and records every attempt", async () => {
    const r = await run([900, 700, 400, 100], 700);
    expect(r.attempts).toEqual([
      { preset: "A", size: "100x100", bytes: 900, fit: false },
      { preset: "B", size: "100x100", bytes: 700, fit: true },
    ]);
    expect(r.fit).toBe(r.attempts[1]);
    expect(r.seen).toHaveLength(2);
  });

  it("returns fit null with all attempts when nothing fits", async () => {
    const r = await run([900, 700, 400, 300], 100);
    expect(r.fit).toBeNull();
    expect(r.attempts.map((a) => a.fit)).toEqual([false, false, false, false]);
    expect(r.seen).toHaveLength(4);
  });
});

describe("budgetFor and helpers", () => {
  it("returns null without --max-kb and parses KB as 1024 bytes", () => {
    expect(budgetFor(flags({}))).toBeNull();
    expect(budgetFor(flags({ "max-kb": "40" }))).toEqual({ bytes: 40960, kb: 40, minScale: 0.5 });
    expect(budgetFor(flags({ "max-kb": "150", "min-scale": "0.7" }))).toEqual({ bytes: 153600, kb: 150, minScale: 0.7 });
    expect(budgetFor(flags({ "max-kb": "5", "min-scale": "1" }))?.minScale).toBe(1);
  });

  it.each([
    [{ "max-kb": "0" }, "invalid --max-kb"],
    [{ "max-kb": "-3" }, "invalid --max-kb"],
    [{ "max-kb": "1.5" }, "invalid --max-kb"],
    [{ "max-kb": "abc" }, "invalid --max-kb"],
    [{ "max-kb": "40", "min-scale": "0.05" }, "invalid --min-scale"],
    [{ "max-kb": "40", "min-scale": "1.5" }, "invalid --min-scale"],
    [{ "max-kb": "40", "min-scale": "half" }, "invalid --min-scale"],
    [{ "min-scale": "0.5" }, "--min-scale needs --max-kb"],
  ])("rejects %j", (f, message) => {
    expect(() => budgetFor(flags(f))).toThrow(UsageError);
    expect(() => budgetFor(flags(f))).toThrow(message);
  });

  it("scales a size to at least one pixel per side; formats the no-fit message", () => {
    expect(scaledDim({ width: 1080, height: 1350 }, 0.9)).toEqual({ width: 972, height: 1215 });
    expect(scaledDim({ width: 1, height: 3 }, 0.5)).toEqual({ width: 1, height: 2 });
    expect(noFitMessage("/x/ad.jpg", 1, { preset: "JPEG (Low quality)", size: "540x540", bytes: 2048, fit: false })).toBe(
      "cannot fit /x/ad.jpg under 1 KB (smallest 2.0 KB at JPEG (Low quality) 540x540)",
    );
    expect(MAX_KB_FLAG.name).toBe("max-kb");
    expect(MIN_SCALE_FLAG.name).toBe("min-scale");
  });
});

// ---- the command, against the fake server ----

let server: FakeServer;
let root: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const { export: exportCmd } = makeExportModule(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-f3-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const BOARDS = [
  { index: 0, name: "ig-square", w: 1080, h: 1080 },
  { index: 1, name: "og", w: 1200, h: 630 },
];

function pngOf(width: number, height: number, bytes: number): Buffer {
  const b = Buffer.alloc(Math.max(33, bytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const field = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);
const areaCalls = (): string[] => server.calls.map((c) => String(c.args["script"] ?? "")).filter((s) => s.includes("affinity-axi:area-export"));
const inspectCalls = (): string[] => server.calls.map((c) => String(c.args["script"] ?? "")).filter((s) => s.includes("affinity-axi:inspect"));

interface StubOpts {
  /** File sizes in order of area exports, one list per artboard index (default: shared list). */
  schedule: number[];
  docPath?: string;
  text?: Array<{ artboard: string; text: string; box: [number, number, number, number] }>;
  noInspect?: boolean;
}

/** Stubs the app, presets, documents, artboards, an area export that follows the schedule, and the inventory. */
function stub(o: StubOpts): { exported: Array<{ preset: string; out: unknown }> } {
  const seen: Array<{ preset: string; out: unknown }> = [];
  let n = 0;
  server.onScript("affinity-axi:list-presets", JSON.stringify(LIVE));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "ad.af", dirty: false, units: "Pixel", path: o.docPath ?? "" }] }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: BOARDS.map((b) => ({ index: b.index, name: b.name })) }));
  const nextBytes = (): number => o.schedule[Math.min(n++, o.schedule.length - 1)]!;
  server.onScript("affinity-axi:export", (script) => {
    seen.push({ preset: field(script, "presetName") as string, out: "plain" });
    writeFileSync(field(script, "outPath") as string, pngOf(1080, 1080, nextBytes()));
    return "{}";
  });
  server.onScript("affinity-axi:area-export", (script) => {
    const area = field(script, "area") as { kind: string; index?: number } | null;
    const out = field(script, "outSize") as { width: number; height: number } | null;
    const b = area?.kind === "artboard" ? BOARDS[area.index!]! : { w: 3000, h: 1000 };
    const dim = out ?? { width: b.w, height: b.h };
    const bytes = nextBytes();
    seen.push({ preset: field(script, "presetName") as string, out });
    writeFileSync(field(script, "outPath") as string, pngOf(dim.width, dim.height, bytes));
    return "{}";
  });
  if (!o.noInspect) {
    const nodes: InventoryNode[] = (o.text ?? []).map((t, i) => ({
      path: `0/${i}`, type: "ArtText", name: "", box: t.box, visible: true, artboard: t.artboard, text: t.text,
    }));
    const inv: Inventory = {
      at: "t",
      doc: { uuid: FIXTURE_UUID, title: "ad.af", path: "", units: "Pixel", width: 1080, height: 1080, dpi: 72 },
      artboards: [],
      nodes,
      counts: { nodes: nodes.length, named: 0, text: nodes.length, images: 0 },
    };
    server.onScript("affinity-axi:inspect", JSON.stringify(inv));
  }
  return { exported: seen };
}

describe("export --max-kb", () => {
  it("steps the preset until the file fits, prints every attempt and keeps the fitting file", async () => {
    const s = stub({ schedule: [90_000, 70_000, 45_000, 30_000] });
    const target = join(desktop, "ad.jpg");
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", target, "--artboard", "ig-square", "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("budget_kb: 40");
    expect(r.stdout).toContain("attempts[4]{preset,size,bytes,fit}:");
    expect(r.stdout).toContain("  JPEG (High quality),1080x1080,90000,false");
    expect(r.stdout).toContain("  JPEG (Medium quality),1080x1080,70000,false");
    expect(r.stdout).toContain("  JPEG (Low quality),1080x1080,45000,false");
    expect(r.stdout).toContain("  JPEG (Low quality),972x972,30000,true");
    expect(r.stdout).toContain("preset: JPEG (Low quality)");
    expect(r.stdout).toContain("requested: JPEG (High quality)");
    expect(r.stdout).toContain("bytes: 30000");
    expect(r.stdout).toContain("size: 972x972");
    expect(readFileSync(target).length).toBe(30_000);
    expect(30_000).toBeLessThanOrEqual(40 * 1024);
    // The first attempt reuses the first export: High, Medium, Low, then Low at 0.9.
    expect(s.exported.map((e) => e.preset)).toEqual(["JPEG (High quality)", "JPEG (Medium quality)", "JPEG (Low quality)", "JPEG (Low quality)"]);
    expect(s.exported.map((e) => e.out)).toEqual([null, null, null, { width: 972, height: 972 }]);
  });

  it("a file that fits at once makes one export, no requested line and one attempt", async () => {
    const s = stub({ schedule: [20_000] });
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", join(desktop, "a.jpg"), "--artboard", "og", "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("attempts[1]{preset,size,bytes,fit}:");
    expect(r.stdout).not.toContain("requested:");
    expect(s.exported).toHaveLength(1);
  });

  it("whole-document exports are budgeted too", async () => {
    const s = stub({ schedule: [60_000, 20_000] });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "w.png"), "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("preset: PNG-8 (dithered)");
    expect(r.stdout).toContain("note: PNG stepped to an 8-bit palette (PNG-8 (dithered))");
    expect(s.exported.map((e) => e.out)).toEqual(["plain", null]); // the plain export, then one lower-quality step
  });

  it("exits 1 with the attempts table when nothing fits, and keeps the smallest file", async () => {
    stub({ schedule: [90_000, 80_000, 70_000, 60_000, 50_000, 45_000, 40_000, 35_000, 30_000] });
    const target = join(desktop, "big.jpg");
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", target, "--artboard", "ig-square", "--max-kb", "10", "--no-alt"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("attempts[8]{preset,size,bytes,fit}:");
    expect(r.stdout).toContain("cannot fit " + target + " under 10 KB (smallest 34.2 KB at JPEG (Low quality) 540x540)");
    expect(r.stdout).toContain("raise --max-kb");
    expect(readFileSync(target).length).toBe(35_000);
  });

  it("--min-scale limits how far the size steps", async () => {
    const s = stub({ schedule: [90_000, 80_000, 70_000, 60_000, 50_000, 45_000, 40_000, 35_000, 30_000] });
    const r = await runCommand(exportCmd, ["current", "JPEG (Medium quality)", join(desktop, "m.jpg"), "--artboard", "og", "--max-kb", "1", "--min-scale", "0.8", "--no-alt"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("attempts[4]{preset,size,bytes,fit}:");
    expect(s.exported.at(-1)!.out).toEqual({ width: 960, height: 504 });
  });

  it("--all-artboards budgets each board and lists the attempts per artboard", async () => {
    stub({ schedule: [90_000, 30_000, 20_000] });
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", join(desktop, "{name}.jpg"), "--all-artboards", "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("attempts[3]{artboard,preset,size,bytes,fit}:");
    expect(r.stdout).toContain("  ig-square,JPEG (High quality),1080x1080,90000,false");
    expect(r.stdout).toContain("  ig-square,JPEG (Medium quality),1080x1080,30000,true");
    expect(r.stdout).toContain("  og,JPEG (High quality),1200x630,20000,true");
    expect(r.stdout).toContain("exports[2]{artboard,path,preset,bytes,size}:");
    expect(readFileSync(join(desktop, "og.jpg")).length).toBe(20_000);
  });

  it("--all-artboards still writes every board when one cannot fit, then exits 1", async () => {
    stub({ schedule: [90_000, 80_000, 70_000, 60_000, 50_000, 49_000, 48_000, 47_000, 46_000, 45_000, 5_000] });
    const r = await runCommand(exportCmd, ["current", "JPEG (Low quality)", join(desktop, "{name}.jpg"), "--all-artboards", "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("cannot fit " + join(desktop, "ig-square.jpg") + " under 40 KB");
    expect(readFileSync(join(desktop, "og.jpg")).length).toBe(5_000);
  });

  it("--scale 2 steps down from the 2x size", async () => {
    const s = stub({ schedule: [90_000, 50_000, 30_000] });
    const r = await runCommand(exportCmd, ["current", "JPEG (Low quality)", join(desktop, "s.jpg"), "--artboard", "og", "--scale", "2", "--max-kb", "40", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(s.exported.map((e) => e.out)).toEqual([null, { width: 2400, height: 1260 }, { width: 2160, height: 1134 }]);
    expect(r.stdout).toContain("size: 2160x1134");
  });

  it("records the final preset, requested, attempts and alt in the manifest of a saved document", async () => {
    const af = join(root, "ad.af");
    writeFileSync(af, "af");
    writeManifest(af, { exports: [], history: [], notes: [] } as never);
    stub({ schedule: [90_000, 70_000, 45_000, 30_000], docPath: af, text: [{ artboard: "ig-square", text: "Light, measured", box: [10, 10, 100, 50] }] });
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", join(desktop, "ad.jpg"), "--artboard", "ig-square", "--max-kb", "40"]);
    expect(r.code).toBe(0);
    const entry = readManifest(af)!.exports[0]!;
    expect(entry).toMatchObject({ preset: "JPEG (Low quality)", requested: "JPEG (High quality)", attempts: 4, bytes: 30_000, size: "972x972", alt: "Light, measured" });
  });

  it("usage errors make zero connections", async () => {
    for (const argv of [
      ["current", "JPEG (High quality)", join(desktop, "a.jpg"), "--max-kb", "0"],
      ["current", "JPEG (High quality)", join(desktop, "a.jpg"), "--max-kb", "40", "--min-scale", "2"],
      ["current", "JPEG (High quality)", join(desktop, "a.jpg"), "--min-scale", "0.5"],
      ["current", "PNG", join(desktop, "a.svg"), "--max-kb", "40"],
      ["current", "SVG (digital - high quality)", join(desktop, "a.png"), "--max-kb", "40"],
    ]) {
      const r = await runCommand(exportCmd, argv);
      expect(r.code).toBe(2);
    }
    expect(server.sessionsOpened()).toBe(0);
  });

  it("declares --max-kb, --min-scale and --no-alt in the spec (so --help shows them)", () => {
    const names = exportCmd.spec.flags!.map((f) => f.name);
    for (const f of ["max-kb", "min-scale", "no-alt"]) expect(names).toContain(f);
    expect(exportCmd.spec.examples!.some((e) => e.includes("--max-kb"))).toBe(true);
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("export alt text", () => {
  const TEXT = [
    { artboard: "ig-square", text: "Studio hours", box: [90, 680, 300, 60] as [number, number, number, number] },
    { artboard: "ig-square", text: "Light, measured", box: [90, 440, 700, 120] as [number, number, number, number] },
    { artboard: "og", text: "Other board", box: [10, 10, 100, 30] as [number, number, number, number] },
  ];

  it("prints the text top-down and a help line, from one inventory call asking for 160 characters", async () => {
    stub({ schedule: [5_000], text: TEXT });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "card.png"), "--artboard", "ig-square"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alt: Light, measured. Studio hours");
    expect(r.stdout).toContain("help[1]:\n  edit the alt text before publishing");
    expect(inspectCalls()).toHaveLength(1);
    expect(field(inspectCalls()[0]!, "textChars")).toBe(160);
  });

  it("--no-alt makes no inventory call and prints no alt line", async () => {
    stub({ schedule: [5_000], text: TEXT });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "card.png"), "--artboard", "ig-square", "--no-alt"]);
    expect(r.stdout).not.toContain("alt:");
    expect(r.stdout).not.toContain("help[");
    expect(inspectCalls()).toHaveLength(0);
  });

  it("an area with no text prints the add-one line, with no help line", async () => {
    stub({ schedule: [5_000], text: [{ artboard: "og", text: "Elsewhere", box: [0, 0, 10, 10] }] });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "card.png"), "--artboard", "ig-square"]);
    expect(r.stdout).toContain("alt: (none; add one)");
  });

  it("--all-artboards adds an alt column with one stub per board", async () => {
    stub({ schedule: [5_000], text: TEXT });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards"]);
    expect(r.stdout).toContain("exports[2]{artboard,path,bytes,size,alt}:");
    expect(r.stdout).toContain('"Light, measured. Studio hours"');
    expect(r.stdout).toContain("Other board");
    expect(inspectCalls()).toHaveLength(1);
  });

  it("a spread export reads that spread's text", async () => {
    stub({ schedule: [5_000], text: [{ artboard: "ig-square", text: "Hello", box: [0, 0, 10, 10] }] });
    const ok = await runCommand(exportCmd, ["current", "PNG", join(desktop, "spread.png"), "--spread", "0"]);
    expect(ok.stdout).toContain("alt: Hello");
  });

  it("falls back to an unavailable note when the inventory cannot be read", async () => {
    stub({ schedule: [5_000], noInspect: true });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "card.png"), "--artboard", "ig-square"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("alt: (unavailable; read the text with inspect)");
    expect(r.stdout).toContain("bytes: 5000");
  });
});
