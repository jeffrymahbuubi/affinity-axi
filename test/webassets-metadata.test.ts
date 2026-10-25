// `webassets` and Affinity's XMP stamp: every PNG under the out dir comes out without text chunks
// (ICC kept), WebP without XMP is untouched and never reaches exiftool, and the output shape is unchanged.
// Fake MCP server whose area-export writes a stamped PNG; a fake exiftool on PATH logs its calls.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageSize } from "../src/affinity/export-area.js";
import { make } from "../src/commands/webassets.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A PNG of the given size as Affinity writes it: ICC profile plus an iTXt XMP chunk naming the account. */
function stampedPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const xmp = "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>account-handle</rdf:li></rdf:Seq></dc:creator></x:xmpmeta>";
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("sRGB\0\0profile")), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

/** A WebP (VP8X header) of the given size with no XMP chunk. */
function cleanWebp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8X", 8, "ascii");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const BOARDS = [
  { index: 0, name: "mark", w: 512, h: 512 },
  { index: 1, name: "og", w: 1200, h: 630 },
  { index: 2, name: "x-card", w: 1200, h: 600 },
  { index: 3, name: "hero", w: 1920, h: 1080 },
];
const PRESETS = ["PNG", "SVG (for export)", "WebP (High Quality)", "JPEG (High quality)"];
const field = (script: string, name: string): any => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);
const hasText = (buf: Buffer): boolean => ["iTXt", "tEXt", "zTXt"].some((t) => buf.includes(t));

describe("webassets: XMP strip", () => {
  const origPath = process.env["PATH"];
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const cmd = make(fakeConnect());
  let server: FakeServer;
  let root: string;
  let desktop: string;
  let out: string;
  let log: string;

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    root = mkdtempSync(join(tmpdir(), "axi-wa-meta-"));
    desktop = join(root, "Desktop");
    out = join(desktop, "site");
    log = join(root, "exiftool.log");
    mkdirSync(desktop);
    process.chdir(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const tool = join(bin, "exiftool");
    writeFileSync(tool, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\nexit 0\n`);
    chmodSync(tool, 0o755);
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
    server.onScript("affinity-axi:list-presets", JSON.stringify(PRESETS));
    server.onScript("affinity-axi:app-info", JSON.stringify({ version: "3.3.1", desktop }));
    server.onScript(
      "affinity-axi:list-documents",
      JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "site.af", dirty: false, units: "Pixel", path: "" }] }),
    );
    server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: BOARDS.map((b) => ({ index: b.index, name: b.name })) }));
    server.onScript("affinity-axi:area-export", (script) => {
      const area = field(script, "area") as { index: number };
      const size = field(script, "outSize") as { width: number; height: number } | null;
      const b = BOARDS[area.index]!;
      const dim = size ?? { width: b.w, height: b.h };
      const file = field(script, "outPath") as string;
      writeFileSync(file, file.endsWith(".webp") ? cleanWebp(dim.width, dim.height) : stampedPng(dim.width, dim.height));
      return "{}";
    });
  });

  afterEach(async () => {
    process.env["PATH"] = origPath;
    process.chdir(origCwd);
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("strips the XMP chunk from every PNG, keeps the ICC profile and the pixel sizes, and leaves WebP alone", async () => {
    const r = await runCommand(cmd, ["current", "--out-dir", out, "--responsive", "hero"]);
    expect(r.code, r.stdout).toBe(0);
    const pngs = readdirSync(out).filter((f) => f.endsWith(".png"));
    expect(pngs.length).toBeGreaterThanOrEqual(8);
    for (const f of pngs) {
      const buf = readFileSync(join(out, f));
      expect(hasText(buf)).toBe(false);
      expect(buf.includes("iCCP")).toBe(true);
      expect(buf.includes("account-handle")).toBe(false);
    }
    expect(imageSize(readFileSync(join(out, "og.png")))).toEqual({ width: 1200, height: 630 });
    const webps = readdirSync(out).filter((f) => f.endsWith(".webp"));
    expect(webps).toEqual(["hero.webp", "hero@2x.webp"]);
    for (const f of webps) {
      const buf = readFileSync(join(out, f));
      const dim = imageSize(buf)!;
      expect(buf.equals(cleanWebp(dim.width, dim.height))).toBe(true);
    }
    expect(existsSync(log)).toBe(false); // PNG strip is pure Node; clean WebP needs no exiftool
  });

  it("output shape is unchanged: no metadata note, the usual files, record and head", async () => {
    const r = await runCommand(cmd, ["current", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toContain("metadata");
    expect(r.stdout).toContain("{role,file,size,bytes}:");
    expect(r.stdout).toContain(`manifest: ${join(out, "webassets.json")}`);
    const record = JSON.parse(readFileSync(join(out, "webassets.json"), "utf8")) as { files: Array<{ file: string; bytes: number }> };
    const og = record.files.find((f) => f.file === "og.png")!;
    expect(og.bytes).toBe(readFileSync(join(out, "og.png")).length); // bytes are measured after the strip
    expect(readFileSync(join(out, "head.html"), "utf8")).toContain("og.png");
  });

  it("the favicon.ico is built from the stripped PNGs", async () => {
    const r = await runCommand(cmd, ["current", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(hasText(readFileSync(join(out, "favicon.ico")))).toBe(false);
  });
});
