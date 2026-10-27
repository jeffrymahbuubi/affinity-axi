// Export and presets (split from commands-run-render-export.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type CommandModule, type Registry } from "../src/cli/router.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { make as makeRun } from "../src/commands/run.js";
import { make as makeRender } from "../src/commands/render.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, FIXTURE_UUID_2, TINY_JPEG_B64, TINY_JPEG_SIZE } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-u3-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const run = makeRun(fakeConnect());
const render = makeRender(fakeConnect());
const { export: exportCmd, presets } = makeExportModule(fakeConnect());

function writeScript(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

function stubDocs(current: string | null = FIXTURE_UUID): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current, documents: FIXTURE_DOCS }));
}

function stubApp(desktopPath: string = desktop): void {
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop: desktopPath }));
}

function stubPresets(names: string[] = FIXTURE_PRESETS): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify(names));
}

const scriptCalls = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

async function captureDispatch(reg: Registry, argv: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
  try {
    return { code: await dispatch(reg, argv), stdout: chunks.join("") };
  } finally {
    process.stdout.write = write;
  }
}

describe("export", () => {
  it("an inexact preset exits 2 and suggests the nearest names", async () => {
    stubPresets([
      "PNG",
      "SVG (digital - high quality)",
      "SVG (digital - small size)",
      "SVG (for export)",
      "SVG (flatten)",
      "PDF (digital - high quality)",
    ]);
    stubApp();
    stubDocs();
    const r = await runCommand(exportCmd, ["current", "SVG", join(desktop, "x.svg")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("unknown export preset 'SVG'");
    for (const n of ["SVG (digital - high quality)", "SVG (digital - small size)", "SVG (for export)", "SVG (flatten)"]) {
      expect(r.stdout).toContain(n);
    }
    expect(r.stdout).not.toContain("closest: PNG");
    expect(r.stdout).toContain("affinity-axi presets");
    expect(scriptCalls().some((s) => s.includes("affinity-axi:export"))).toBe(false);
  });

  it("matches preset substrings case-insensitively", async () => {
    stubPresets();
    const r = await runCommand(exportCmd, ["current", "png", join(desktop, "x.png")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("closest: PNG");
  });

  it("with no near match still points at the presets command", async () => {
    stubPresets();
    const r = await runCommand(exportCmd, ["current", "Nonsense", join(desktop, "x.png")]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("closest:");
    expect(r.stdout).toContain("affinity-axi presets");
  });

  it("refuses a path outside the Desktop folder with exit 2 and never runs the export", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    const r = await runCommand(exportCmd, ["current", "PNG", join(root, "elsewhere", "x.png")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(r.stdout).toContain(desktop);
    expect(scriptCalls().some((s) => s.includes("affinity-axi:export"))).toBe(false);
  });

  it("refuses a sibling folder that merely shares the Desktop prefix", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    const r = await runCommand(exportCmd, ["current", "PNG", desktop + "-evil/x.png"]);
    expect(r.code).toBe(2);
  });

  it("refuses a hidden folder in the template ({name} is probed, not the literal) before connecting", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, ".out", "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("hidden folder or file ('.out')");
    expect(r.stdout).toContain("export path");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("refuses a dot-prefixed file name before connecting", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, ".a.png")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("hidden folder or file ('.a.png')");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("exports under the Desktop and reports path, doc, preset and bytes", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    const target = join(desktop, "logo.png");
    server.onScript("affinity-axi:export", (script) => {
      writeFileSync(argOf(script, "outPath") as string, "p".repeat(1842));
      return JSON.stringify({ exported: target, echo: script.length > 0 });
    });
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`export: ${target}`);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("preset: PNG");
    expect(r.stdout).toContain("bytes: 1842");
    const sent = scriptCalls().find((s) => s.includes("affinity-axi:export"))!;
    expect(sent).toContain(JSON.stringify(FIXTURE_UUID));
    const sentOut = String(argOf(sent, "outPath"));
    expect(sentOut.startsWith(join(desktop, "logo.axi-tmp-")) && sentOut.endsWith(".png") && sentOut.length === target.length + 15).toBe(true);
  });

  it("resolves a relative path against the current directory", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    process.chdir(desktop);
    const target = join(process.cwd(), "rel.png");
    server.onScript("affinity-axi:export", (script) => (writeFileSync(argOf(script, "outPath") as string, "abc"), "{}"));
    const r = await runCommand(exportCmd, [FIXTURE_UUID_2.slice(0, 8), "PNG", "rel.png"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`export: ${target}`);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID_2}`);
    expect(r.stdout).toContain("bytes: 3");
  });

  it("exit 1 when the export script reports an SDK error", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    server.onScript("affinity-axi:export", "ERROR: could not write file\n");
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export failed: ERROR: could not write file");
  });

  it("exit 1 when the export succeeds but no file appears", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    server.onScript("affinity-axi:export", "{}");
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "ghost.png")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("was not written");
  });

  it("an unmatched document reference exits 2 before exporting", async () => {
    stubPresets();
    stubApp();
    stubDocs();
    const r = await runCommand(exportCmd, ["FFFFFFFF", "PNG", join(desktop, "x.png")]);
    expect(r.code).toBe(2);
    expect(scriptCalls().some((s) => s.includes("affinity-axi:export"))).toBe(false);
  });

  it("requires all three arguments", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG"]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});

// ---- export area, size and embedded AI metadata ----

const BOARDS = [
  { index: 0, name: "ig-square", w: 1080, h: 1080 },
  { index: 1, name: "ig-portrait", w: 1080, h: 1350 },
  { index: 2, name: "og", w: 1200, h: 630 },
];

function pngBuf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const pngDims = (file: string): string => {
  const b = readFileSync(file);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

/** Stubs the artboard listing and an area-aware export that writes PNGs of the right size. */
function stubBoards(names: string[] = BOARDS.map((b) => b.name), exportReply?: (script: string) => string): void {
  stubPresets();
  stubApp();
  stubDocs();
  const boards = names.map((name, index) => ({ index, name }));
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: boards }));
  server.onScript("affinity-axi:area-export", exportReply ?? ((script) => {
    const field = (n: string): unknown => JSON.parse(new RegExp(`const ${n} = (.*);`).exec(script)![1]!);
    const area = field("area") as { kind: string; index?: number } | null;
    const out = field("outSize") as { width: number; height: number } | null;
    const b = area?.kind === "artboard" ? BOARDS[area.index!] : undefined;
    const nat = b ? { width: b.w, height: b.h } : { width: 3000, height: 1000 };
    const dim = out ?? nat;
    writeFileSync(field("outPath") as string, pngBuf(dim.width, dim.height));
    return "{}";
  }));
}

const areaCalls = (): string[] => scriptCalls().filter((s) => s.includes("affinity-axi:area-export"));
const argOf = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

describe("export area", () => {
  it("--all-artboards lists the artboards and writes one file per name", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "out-{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exports[3]{artboard,path,bytes,size,alt}:");
    expect(r.stdout).toContain(`  ig-square,${join(desktop, "out-ig-square.png")},33,1080x1080`);
    expect(r.stdout).toContain(`  ig-portrait,${join(desktop, "out-ig-portrait.png")},33,1080x1350`);
    expect(r.stdout).toContain(`  og,${join(desktop, "out-og.png")},33,1200x630`);
    expect(pngDims(join(desktop, "out-og.png"))).toBe("1200x630");
    const list = scriptCalls().find((s) => s.includes("affinity-axi:list-artboards"))!;
    expect(list).toContain("const spreadIndex = 0;");
    expect(areaCalls().map((s) => argOf(s, "area"))).toEqual([
      { kind: "artboard", spread: 0, index: 0 },
      { kind: "artboard", spread: 0, index: 1 },
      { kind: "artboard", spread: 0, index: 2 },
    ]);
    expect(r.stdout).not.toContain("metadata:");
  });

  it("expands {name} to filesystem-safe, unique names inside the Desktop", async () => {
    stubBoards(["IG Story / 9:16", "../evil", "og", "OG"]);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(0);
    for (const f of ["IG-Story-9-16.png", "evil.png", "og.png", "OG-2.png"]) {
      expect(existsSync(join(desktop, f))).toBe(true);
    }
    expect(r.stdout).toContain("  IG Story / 9:16,");
    for (const line of r.stdout.split("\n").filter((l) => l.includes(desktop))) expect(line.split(",")[1]).not.toContain("..");
  });

  it("--all-artboards without {name} exits 2 before connecting", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png"), "--all-artboards"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("needs {name}");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("{name} without an artboard flag exits 2", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png")]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("rejects conflicting area flags before connecting", async () => {
    for (const argv of [["--artboard", "og", "--selection"], ["--all-artboards", "--selection"], ["--selection", "--spread", "0"], ["--spread", "x"]]) {
      const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), ...argv]);
      expect(r.code).toBe(2);
    }
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--artboard exports one artboard by exact or case-insensitive name", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}@card.png"), "--artboard", "OG"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`export: ${join(desktop, "og@card.png")}`);
    expect(r.stdout).toContain("artboard: og");
    expect(r.stdout).toContain("size: 1200x630");
    expect(areaCalls()).toHaveLength(1);
    expect(argOf(areaCalls()[0]!, "area")).toEqual({ kind: "artboard", spread: 0, index: 2 });
  });

  it("an unknown artboard exits 2 and lists the real names; nothing is exported", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png"), "--artboard", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("no artboard named 'nope'");
    expect(r.stdout).toContain("ig-square, ig-portrait, og");
    expect(areaCalls()).toHaveLength(0);
  });

  it("a document without artboards exits 2", async () => {
    stubBoards([]);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("has no artboards");
  });

  it("--spread picks the artboard spread; alone it exports that spread", async () => {
    stubBoards();
    await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards", "--spread", "1"]);
    expect(scriptCalls().find((s) => s.includes("affinity-axi:list-artboards"))).toContain("const spreadIndex = 1;");
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "spread.png"), "--spread", "1"]);
    expect(r.code).toBe(0);
    expect(argOf(areaCalls().at(-1)!, "area")).toEqual({ kind: "spread", spread: 1 });
  });

  it("--selection exports the selection and reports its size", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "sel.png"), "--selection"]);
    expect(r.code).toBe(0);
    expect(argOf(areaCalls()[0]!, "area")).toEqual({ kind: "selection" });
    expect(r.stdout).toContain("size: 3000x1000");
  });

  it("an area outside the Desktop is refused, {name} included", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(root, "elsewhere", "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(areaCalls()).toHaveLength(0);
  });

  it("a failing artboard export names the artboard and stops", async () => {
    stubBoards(undefined, () => "ERROR: boom\n");
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export of artboard 'ig-square' failed: ERROR: boom");
  });
});

describe("export size", () => {
  it.each([
    ["--width", "0"],
    ["--height", "abc"],
    ["--scale", "-2"],
    ["--square", "99999"],
  ])("%s %s exits 2 before connecting", async (flag, value) => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png"), flag, value]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("combining --square with --width exits 2 before connecting", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png"), "--square", "512", "--width", "100"]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("size flags on a vector path exit 2", async () => {
    const r = await runCommand(exportCmd, ["current", "SVG", join(desktop, "x.svg"), "--scale", "2"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("raster output path");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--scale 2 exports natural size, then re-exports at 2x and prints the file's size", async () => {
    stubBoards();
    const target = join(desktop, "og@2x.png");
    const r = await runCommand(exportCmd, ["current", "PNG", target, "--artboard", "og", "--scale", "2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("size: 2400x1260");
    expect(pngDims(target)).toBe("2400x1260");
    expect(areaCalls().map((s) => argOf(s, "outSize"))).toEqual([null, { width: 2400, height: 1260 }]);
  });

  it("--square 512 fits the longer side of a selection", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "i.png"), "--selection", "--square", "512"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("size: 512x171");
  });

  it("--width keeps the aspect ratio; --width and --height together set both", async () => {
    stubBoards();
    const a = await runCommand(exportCmd, ["current", "PNG", join(desktop, "a.png"), "--artboard", "ig-portrait", "--width", "540"]);
    expect(a.stdout).toContain("size: 540x675");
    const b = await runCommand(exportCmd, ["current", "PNG", join(desktop, "b.png"), "--artboard", "og", "--width", "300", "--height", "300"]);
    expect(b.stdout).toContain("size: 300x300");
  });

  it("skips the second export when the size already matches", async () => {
    stubBoards();
    await runCommand(exportCmd, ["current", "PNG", join(desktop, "same.png"), "--artboard", "og", "--width", "1200"]);
    expect(areaCalls()).toHaveLength(1);
  });

  it("applies the size to every artboard", async () => {
    stubBoards();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards", "--scale", "0.5"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(",540x540");
    expect(r.stdout).toContain(",540x675");
    expect(r.stdout).toContain(",600x315");
  });

  it("exit 1 when the exported file has no readable size", async () => {
    stubBoards(undefined, (script) => (writeFileSync(argOf(script, "outPath") as string, "not an image"), "{}"));
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "bad.png"), "--selection", "--scale", "2"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("cannot read the pixel size");
  });
});

describe("presets", () => {
  it("lists every preset with one script call", async () => {
    stubPresets();
    const r = await runCommand(presets, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`presets[${FIXTURE_PRESETS.length}]{name}:`);
    expect(r.stdout).toContain("\n  PNG\n");
    expect(r.stdout).toContain('  "WebP (Lossless, default)"');
    expect(r.stdout).toContain("  SVG (digital - high quality)");
    expect(server.calls.map((c) => c.name)).toEqual(["read_sdk_documentation_topic", "execute_script"]);
  });
});
