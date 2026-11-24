// export --sizes, --densities, --base and --safe-zone against the fake server.
// The export handlers write real RGBA PNGs of the requested size (a centred disc).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Inventory } from "../src/affinity/manifest-types.js";
import { readManifest, writeManifest } from "../src/affinity/manifest.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { slash } from "./helpers/paths.js";

const BOARDS = [
  { index: 0, name: "og", w: 1200, h: 630 },
  { index: 1, name: "square", w: 432, h: 432 },
];

let server: FakeServer;
let root: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const { export: exportCmd } = makeExportModule(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-sizes-"));
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

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An RGBA PNG with a centred opaque disc whose radius is `frac` of half the shorter side. */
function discPng(width: number, height: number, frac: number): Buffer {
  const r = (frac * Math.min(width, height)) / 2;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) <= r) raw.writeUInt32BE(0xff0000ff, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const field = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);
const areaCalls = (): string[] => server.calls.map((c) => String(c.args["script"] ?? "")).filter((s) => s.includes("affinity-axi:area-export"));
const allExportCalls = (): string[] => server.calls.map((c) => String(c.args["script"] ?? "")).filter((s) => /affinity-axi:(area-)?export/.test(s));

interface StubOpts {
  disc?: number;
  docPath?: string;
  pages?: boolean;
}

function stub(o: StubOpts = {}): void {
  const disc = o.disc ?? 0.5;
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG", "JPEG (High quality)"]));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "d.af", dirty: false, units: "Pixel", path: o.docPath ?? "" }] }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: BOARDS.map((b) => ({ index: b.index, name: b.name })) }));
  server.onScript("affinity-axi:export", (script) => {
    const outPath = field(script, "outPath") as string;
    if (o.pages) {
      writeFileSync(outPath.replace(/(\.\w+)$/, "_1$1"), discPng(8, 8, disc));
      writeFileSync(outPath.replace(/(\.\w+)$/, "_2$1"), discPng(8, 8, disc));
      return "{}";
    }
    writeFileSync(outPath, discPng(432, 432, disc));
    return "{}";
  });
  server.onScript("affinity-axi:area-export", (script) => {
    const area = field(script, "area") as { kind: string; index?: number } | null;
    const out = field(script, "outSize") as { width: number; height: number } | null;
    const b = area?.kind === "artboard" ? BOARDS[area.index!]! : { w: 432, h: 432 };
    const dim = out ?? { width: b.w, height: b.h };
    const outPath = field(script, "outPath") as string;
    if (o.pages) {
      writeFileSync(outPath.replace(/(\.\w+)$/, "_1$1"), discPng(8, 8, disc));
      writeFileSync(outPath.replace(/(\.\w+)$/, "_2$1"), discPng(8, 8, disc));
      return "{}";
    }
    writeFileSync(outPath, discPng(dim.width, dim.height, disc));
    return "{}";
  });
  const inv: Inventory = {
    at: "t",
    doc: { uuid: FIXTURE_UUID, title: "d.af", path: "", units: "Pixel", width: 1200, height: 630, dpi: 72 },
    artboards: [],
    nodes: [],
    counts: { nodes: 0, named: 0, text: 0, images: 0 },
  };
  server.onScript("affinity-axi:inspect", JSON.stringify(inv));
}

const png = (...parts: string[]): string => join(desktop, ...parts);

describe("export --sizes", () => {
  it("exports the natural size once, then one file per size, and reports the table", async () => {
    stub();
    const r = await runCommand(exportCmd, ["current", "PNG", png("icons", "icon-{size}.png"), "--artboard", "og", "--sizes", "192,512", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(areaCalls()).toHaveLength(3);
    expect(readFileSync(png("icons", "icon-192.png")).readUInt32BE(16)).toBe(192);
    expect(readFileSync(png("icons", "icon-192.png")).readUInt32BE(20)).toBe(101);
    expect(readFileSync(png("icons", "icon-512.png")).readUInt32BE(16)).toBe(512);
    expect(r.stdout).toContain("exports[2]{path,bytes,size}:");
    expect(r.stdout).toContain("192x101");
    expect(r.stdout).toContain("512x269");
    expect(r.stdout).toContain("artboard: og");
  });

  it("five densities at base 48 make six calls and five created folders", async () => {
    stub();
    const r = await runCommand(exportCmd, [
      "current", "PNG", png("res", "mipmap-{density}", "ic.png"), "--artboard", "square",
      "--densities", "mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi", "--no-alt",
    ]);
    expect(r.code).toBe(0);
    expect(areaCalls()).toHaveLength(6);
    for (const d of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) expect(existsSync(png("res", `mipmap-${d}`, "ic.png"))).toBe(true);
    expect(readFileSync(png("res", "mipmap-xxxhdpi", "ic.png")).readUInt32BE(16)).toBe(192);
    expect(r.stdout).toContain("base_dp: 48");
    expect(r.stdout).toContain("density");
  });

  it("a size equal to the natural size costs no extra call", async () => {
    stub();
    const r = await runCommand(exportCmd, ["current", "PNG", png("i-{size}.png"), "--artboard", "square", "--sizes", "432", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(areaCalls()).toHaveLength(1);
    expect(existsSync(png("i-432.png"))).toBe(true);
  });

  it("--all-artboards with --densities gives boards times densities and an artboard column", async () => {
    stub();
    const r = await runCommand(exportCmd, [
      "current", "PNG", png("{density}", "{name}.png"), "--all-artboards", "--densities", "mdpi,xhdpi", "--base", "108", "--no-alt",
    ]);
    expect(r.code).toBe(0);
    expect(areaCalls()).toHaveLength(6);
    expect(r.stdout).toContain("exports[4]{artboard,density,path,bytes,size}:");
    expect(r.stdout).toContain("base_dp: 108");
    expect(readFileSync(png("xhdpi", "square.png")).readUInt32BE(16)).toBe(216);
  });

  it("--brief prints one line per file", async () => {
    stub();
    const r = await runCommand(exportCmd, ["current", "PNG", png("i-{size}.png"), "--artboard", "og", "--sizes", "64,128", "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exports[2]{path,bytes,size,sha256}:");
    expect(r.stdout).not.toContain("alt");
  });

  it("usage errors open no session", async () => {
    stub();
    for (const argv of [
      ["current", "PNG", png("a.png"), "--sizes", "192"],
      ["current", "PNG", png("a-{size}.png"), "--sizes", "192", "--densities", "mdpi"],
      ["current", "PNG", png("a-{size}.png"), "--sizes", "0"],
      ["current", "PNG", png("a-{size}.png"), "--sizes", "192", "--base", "48"],
      ["current", "PNG", png("a-{density}.png"), "--densities", "tvdpi"],
      ["current", "PNG", png("a-{size}.png"), "--sizes", "192", "--width", "100"],
      ["current", "PNG", png("a-{size}.png"), "--sizes", "192", "--max-kb", "10"],
      ["current", "PNG", png("a-{size}.svg"), "--sizes", "192"],
      ["current", "PNG", png("a.jpg"), "--safe-zone", "0.8"],
      ["current", "PNG", png("{name}.png"), "--all-artboards", "--safe-zone", "0.8"],
      ["current", "PNG", png("a.png"), "--safe-zone", "2"],
    ]) {
      const r = await runCommand(exportCmd, argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect(server.calls).toHaveLength(0);
  });

  it("names the placeholder in the missing-placeholder error", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", png("x.png"), "--sizes", "192"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain("{size}");
  });

  it("a multi-page reply gives the extended usage error", async () => {
    stub({ pages: true });
    const r = await runCommand(exportCmd, ["current", "PNG", png("i-{size}.png"), "--sizes", "64", "--no-alt"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain("--sizes, --densities, --safe-zone and --max-kb cannot be used with a multi-page export");
  });

  it("records one manifest entry per file", async () => {
    const af = join(root, "d.af");
    writeFileSync(af, "af");
    writeManifest(af, { exports: [], history: [], notes: [] } as never);
    stub({ docPath: af });
    const r = await runCommand(exportCmd, ["current", "PNG", png("i-{size}.png"), "--artboard", "og", "--sizes", "64,128", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(readManifest(af)!.exports).toHaveLength(2);
  });
});

describe("export --safe-zone", () => {
  it("prints safe_zone: ok and exits 0 for a small disc", async () => {
    stub({ disc: 0.5 });
    const r = await runCommand(exportCmd, ["current", "PNG", png("fg.png"), "--artboard", "square", "--safe-zone", "android-adaptive", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("safe_zone: ok");
    expect(areaCalls()).toHaveLength(1);
  });

  it("prints outside and exits 1 with the frozen message for a large disc", async () => {
    stub({ disc: 0.95 });
    const r = await runCommand(exportCmd, ["current", "PNG", png("fg.png"), "--artboard", "square", "--safe-zone", "android-adaptive", "--no-alt"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("safe_zone: outside");
    const text = r.stdout + r.stderr;
    expect(text).toMatch(/safe zone: painted pixels reach \d+\.\d px from the centre of .*fg\.png, \d+\.\d px outside the android-adaptive circle \(limit \d+\.\d px\)/);
    expect(text).toContain("axiSafeZoneClear");
  });

  it("with --sizes checks the largest file", async () => {
    stub({ disc: 0.5 });
    const r = await runCommand(exportCmd, ["current", "PNG", png("i-{size}.png"), "--artboard", "square", "--sizes", "64,256", "--safe-zone", "0.8", "--no-alt"]);
    expect(r.code).toBe(0);
    expect(slash(r.stdout)).toContain("safe_checked:");
    expect(slash(r.stdout)).toContain("i-256.png");
  });
});

describe("export without the new flags", () => {
  it("makes the plain script call and prints the plain report", async () => {
    stub();
    const r = await runCommand(exportCmd, ["current", "PNG", png("logo.png"), "--no-alt"]);
    expect(r.code).toBe(0);
    expect(allExportCalls()).toHaveLength(1);
    expect(r.stdout).toContain("export: ");
    expect(r.stdout).not.toContain("safe_zone");
    expect(r.stdout).not.toContain("base_dp");
  });
});
