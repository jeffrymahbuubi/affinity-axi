// render --artboard (F6): one artboard through a PNG export and a copy. Fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRender } from "../src/commands/render.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-u5-"));
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

const render = makeRender(fakeConnect());

function pngBuf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

interface Board {
  name: string;
  w: number;
  h: number;
}
const BOARDS: Board[] = [
  { name: "Hero", w: 1024, h: 1024 },
  { name: "wide", w: 1200, h: 630 },
  { name: "2", w: 800, h: 800 },
  { name: "big", w: 4096, h: 2048 },
];

function stub(opts: { presets?: string[]; boards?: Board[]; exportError?: boolean } = {}): void {
  const boards = opts.boards ?? BOARDS;
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(opts.presets ?? FIXTURE_PRESETS));
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: boards.map((b, index) => ({ index, name: b.name })) }));
  server.onScript("affinity-axi:area-export", (script) => {
    const field = (n: string): unknown => JSON.parse(new RegExp(`const ${n} = (.*);`).exec(script)![1]!);
    const area = field("area") as { index: number };
    const size = field("outSize") as { width: number; height: number } | null;
    const b = boards[area.index]!;
    const dim = size ?? { width: b.w, height: b.h };
    writeFileSync(field("outPath") as string, pngBuf(dim.width, dim.height));
    if (opts.exportError) throw new Error("boom");
    return "{}";
  });
}

const exports = (): string[] =>
  server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"])).filter((s) => s.includes("affinity-axi:area-export"));
const sizeOf = (p: string): string => {
  const b = readFileSync(p);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};
const leftovers = (): string[] => readdirSync(desktop).filter((f) => f.startsWith("affinity-axi-render-"));
const OUT = join(".affinity-axi", "renders");

describe("render --artboard", () => {
  it("renders by exact name into .affinity-axi/renders and removes the temp file", async () => {
    stub();
    const r = await runCommand(render, ["current", "--artboard", "Hero"]);
    expect(r.code).toBe(0);
    const out = join(OUT, `${FIXTURE_UUID.slice(0, 8)}-Hero.png`);
    expect(r.stdout).toContain("artboard: Hero");
    expect(r.stdout).toContain("size: 1024x1024");
    expect(r.stdout).toContain("at its own size; a temp file on the Desktop was written and removed");
    expect(r.stdout).toContain(`export ${FIXTURE_UUID.slice(0, 8)} PNG <path-under-Desktop> --artboard Hero`);
    expect(sizeOf(out)).toBe("1024x1024");
    expect(leftovers()).toEqual([]);
    expect(exports()).toHaveLength(1);
  });

  it("matches a case-insensitive name", async () => {
    stub();
    const r = await runCommand(render, ["current", "--artboard", "WIDE"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("artboard: wide");
    expect(r.stdout).toContain("size: 1200x630");
  });

  it("matches an index, and a name made of digits wins over the index", async () => {
    stub();
    const byIndex = await runCommand(render, ["current", "--artboard", "1"]);
    expect(byIndex.stdout).toContain("artboard: wide");
    const byName = await runCommand(render, ["current", "--artboard", "2"]);
    expect(byName.stdout).toContain("artboard: 2");
    expect(byName.stdout).toContain("size: 800x800");
  });

  it("lists index:name for an unknown or ambiguous name", async () => {
    stub({ boards: [{ name: "a", w: 10, h: 10 }, { name: "A", w: 10, h: 10 }, { name: "b", w: 10, h: 10 }] });
    const unknown = await runCommand(render, ["current", "--artboard", "zzz"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("no artboard named 'zzz'");
    expect(unknown.stdout).toContain("artboards: 0:a, 1:A, 2:b");
    const dup = await runCommand(render, ["current", "--artboard", "B"]);
    expect(dup.code).toBe(0);
  });

  it("refuses a name shared by two artboards", async () => {
    stub({ boards: [{ name: "x", w: 10, h: 10 }, { name: "x", w: 10, h: 10 }] });
    const amb = await runCommand(render, ["current", "--artboard", "x"]);
    expect(amb.code).toBe(2);
    expect(amb.stdout).toContain("ambiguous");
    expect(amb.stdout).toContain("artboards: 0:x, 1:x");
  });

  it("fails when the spread has no artboards", async () => {
    stub({ boards: [] });
    const r = await runCommand(render, ["current", "--artboard", "x"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("has no artboards on spread 0");
    expect(exports()).toHaveLength(0);
  });

  it("scales a 4096 px artboard down to 2048 with a second export", async () => {
    stub();
    const r = await runCommand(render, ["current", "--artboard", "big"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("size: 2048x1024");
    expect(r.stdout).toContain("2048x1024, scaled from 4096x2048");
    expect(exports()).toHaveLength(2);
    expect(JSON.parse(/const outSize = (.*);/.exec(exports()[1]!)![1]!)).toEqual({ width: 2048, height: 1024 });
    expect(leftovers()).toEqual([]);
  });

  it("--width 512 gives a second export 512 wide", async () => {
    stub();
    const r = await runCommand(render, ["current", "--artboard", "Hero", "--width", "512", "--out", "x/h.png"]);
    expect(r.code).toBe(0);
    expect(exports()).toHaveLength(2);
    expect(JSON.parse(/const outSize = (.*);/.exec(exports()[1]!)![1]!)).toEqual({ width: 512, height: 512 });
    expect(sizeOf(join("x", "h.png"))).toBe("512x512");
  });

  it("uses a PNG preset by prefix when there is no plain PNG", async () => {
    stub({ presets: ["JPEG (High quality)", "PNG (24-bit)"] });
    const r = await runCommand(render, ["current", "--artboard", "Hero"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(/const presetName = (.*);/.exec(exports()[0]!)![1]!)).toBe("PNG (24-bit)");
  });

  it("explains when there is no PNG preset", async () => {
    stub({ presets: ["JPEG (High quality)"] });
    const r = await runCommand(render, ["current", "--artboard", "Hero"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("no PNG export preset in this Affinity install");
    expect(r.stdout).toContain("affinity-axi export <doc> <preset> <path-under-Desktop> --artboard <name>");
  });

  it("removes the temp file when the export fails", async () => {
    stub({ exportError: true });
    const r = await runCommand(render, ["current", "--artboard", "Hero"]);
    expect(r.code).toBe(1);
    expect(leftovers()).toEqual([]);
    expect(existsSync(OUT)).toBe(false);
  });

  it("usage errors open no session", async () => {
    stub();
    const cases: Array<[string[], string]> = [
      [["--artboard", "a", "--selection"], "--artboard and --selection cannot be combined"],
      [["--width", "100"], "--width needs --artboard <name|index>"],
      [["--artboard", " "], "--artboard needs a name"],
      [["--artboard", "a", "--out", "x.jpg"], "--out must end in .png"],
      [["--artboard", "a", "--width", "0"], "invalid --width '0'"],
      [["--artboard", "a", "--width", "99999"], "invalid --width '99999'"],
      [["--artboard", "a", "--width", "1.5"], "invalid --width '1.5'"],
    ];
    for (const [args, text] of cases) {
      const r = await runCommand(render, ["current", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stdout).toContain(text);
    }
    expect(server.calls).toHaveLength(0);
  });

  it("plain render is unchanged", async () => {
    stub();
    const r = await runCommand(render, ["current"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("spread: 0");
    expect(r.stdout).toContain("preview capped at 1024px");
    expect(exports()).toHaveLength(0);
  });
});
