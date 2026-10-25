// Export area, size and exiftool helpers (src/affinity/export-area.ts and exif.ts).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Parsed } from "../src/cli/args.js";
import {
  describeAi,
  embedAiMetadata,
  exiftoolAvailable,
  SOURCE_COMPOSITE,
  SOURCE_SYNTHETIC,
  sourceTypeFor,
} from "../src/affinity/exif.js";
import {
  EXPORT_AREA,
  LIST_ARTBOARDS,
  imageKind,
  imageSize,
  parseSizeFlags,
  safeName,
  targetSize,
  uniqueSafeNames,
} from "../src/affinity/export-area.js";
import { appendProvenance, type ProvenanceRecord } from "../src/affinity/provenance.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { UsageError } from "../src/output/errors.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, TINY_JPEG_B64, TINY_JPEG_SIZE } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

function pngBuf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function webpBuf(fourcc: string, width: number, height: number): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write(fourcc, 12, "ascii");
  if (fourcc === "VP8 ") {
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  } else if (fourcc === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  } else {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  }
  return b;
}

const argOf = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

const flags = (f: Record<string, string | boolean>): Parsed => ({ positionals: [], flags: f, help: false });

describe("safeName and uniqueSafeNames", () => {
  it("replaces separators, reserved characters and whitespace", () => {
    expect(safeName("ig-square")).toBe("ig-square");
    expect(safeName("IG Story / 9:16")).toBe("IG-Story-9-16");
    expect(safeName("a\\b*c?d\"e<f>g|h")).toBe("a-b-c-d-e-f-g-h");
    expect(safeName("../../etc/passwd")).toBe("etc-passwd");
    expect(safeName(".hidden")).toBe("hidden");
    expect(safeName("tab\tand\nnewline")).toBe("tab-and-newline");
  });

  it("falls back for empty results and caps the length", () => {
    expect(safeName("///")).toBe("artboard");
    expect(safeName("")).toBe("artboard");
    expect(safeName("x".repeat(300)).length).toBe(80);
  });

  it("never produces a path separator or a parent reference", () => {
    for (const n of ["..", "../x", "a/../b", "/abs", "C:\\win", "\u0000nul"]) {
      const s = safeName(n);
      expect(s).not.toMatch(/[\\/:\u0000]/);
      expect(s).not.toBe("..");
    }
  });

  it("numbers duplicates, case-insensitively", () => {
    expect(uniqueSafeNames(["og", "OG", "og", "a b", "a-b"])).toEqual(["og", "OG-2", "og-3", "a-b", "a-b-2"]);
  });
});

describe("parseSizeFlags and targetSize", () => {
  it("returns null when no size flag is given", () => {
    expect(parseSizeFlags(flags({}))).toBeNull();
  });

  it("accepts each form", () => {
    expect(parseSizeFlags(flags({ width: "400" }))).toEqual({ width: 400 });
    expect(parseSizeFlags(flags({ width: "400", height: "300" }))).toEqual({ width: 400, height: 300 });
    expect(parseSizeFlags(flags({ scale: "2" }))).toEqual({ scale: 2 });
    expect(parseSizeFlags(flags({ scale: "1.5" }))).toEqual({ scale: 1.5 });
    expect(parseSizeFlags(flags({ square: "512" }))).toEqual({ square: 512 });
  });

  it.each([
    [{ width: "0" }, "invalid --width"],
    [{ width: "-3" }, "invalid --width"],
    [{ height: "abc" }, "invalid --height"],
    [{ width: "99999" }, "invalid --width"],
    [{ width: "1.5" }, "invalid --width"],
    [{ scale: "0" }, "invalid --scale"],
    [{ scale: "x2" }, "invalid --scale"],
    [{ scale: "99" }, "invalid --scale"],
    [{ square: "0" }, "invalid --square"],
    [{ square: "512", width: "100" }, "--square cannot be combined"],
    [{ scale: "2", height: "100" }, "--scale cannot be combined"],
  ])("rejects %j", (f, message) => {
    expect(() => parseSizeFlags(flags(f))).toThrow(UsageError);
    expect(() => parseSizeFlags(flags(f))).toThrow(message);
  });

  it("computes targets from the natural size", () => {
    const nat = { width: 1200, height: 630 };
    expect(targetSize(nat, { scale: 2 })).toEqual({ width: 2400, height: 1260 });
    expect(targetSize(nat, { scale: 0.5 })).toEqual({ width: 600, height: 315 });
    expect(targetSize(nat, { width: 600 })).toEqual({ width: 600, height: 315 });
    expect(targetSize(nat, { height: 300 })).toEqual({ width: 571, height: 300 });
    expect(targetSize(nat, { width: 100, height: 100 })).toEqual({ width: 100, height: 100 });
    expect(targetSize(nat, { square: 512 })).toEqual({ width: 512, height: 269 });
    expect(targetSize({ width: 1080, height: 1350 }, { square: 512 })).toEqual({ width: 410, height: 512 });
  });

  it("refuses an output beyond 16384 px", () => {
    expect(() => targetSize({ width: 10000, height: 10000 }, { scale: 2 })).toThrow(UsageError);
  });
});

describe("image readers", () => {
  it("reads PNG IHDR", () => {
    expect(imageKind(pngBuf(1, 1))).toBe("png");
    expect(imageSize(pngBuf(1080, 1350))).toEqual({ width: 1080, height: 1350 });
  });

  it("reads JPEG SOF through jpeg.ts", () => {
    const buf = Buffer.from(TINY_JPEG_B64, "base64");
    expect(imageKind(buf)).toBe("jpeg");
    expect(imageSize(buf)).toEqual(TINY_JPEG_SIZE);
  });

  it("reads WebP lossy, lossless and extended headers", () => {
    expect(imageKind(webpBuf("VP8 ", 5, 5))).toBe("webp");
    expect(imageSize(webpBuf("VP8 ", 540, 540))).toEqual({ width: 540, height: 540 });
    expect(imageSize(webpBuf("VP8L", 300, 200))).toEqual({ width: 300, height: 200 });
    expect(imageSize(webpBuf("VP8X", 600, 315))).toEqual({ width: 600, height: 315 });
  });

  it("returns null for other formats and junk", () => {
    expect(imageKind(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(imageSize(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(imageSize(Buffer.alloc(0))).toBeNull();
    expect(imageSize(pngBuf(1, 1).subarray(0, 20))).toBeNull();
  });
});

describe("area scripts", () => {
  it("LIST_ARTBOARDS reads descriptions from the chosen spread", () => {
    const s = LIST_ARTBOARDS("ABC-1", 2);
    expect(s.startsWith("/* affinity-axi:list-artboards */")).toBe(true);
    expect(s).toContain('const targetUuid = "ABC-1";');
    expect(s).toContain("const spreadIndex = 2;");
    expect(s).toContain("a.description");
    expect(s).toContain("console.log(");
  });

  it("EXPORT_AREA embeds JSON-quoted arguments and the real SDK calls", () => {
    const s = EXPORT_AREA("U-1", 'My "Preset"', "/d/x {y}.png", { kind: "artboard", spread: 0, index: 1 }, { width: 10, height: 20 });
    expect(s.startsWith("/* affinity-axi:area-export */")).toBe(true);
    expect(s).toContain(`const presetName = ${JSON.stringify('My "Preset"')};`);
    expect(s).toContain('const outPath = "/d/x {y}.png";');
    expect(s).toContain('const area = {"kind":"artboard","spread":0,"index":1};');
    expect(s).toContain('const outSize = {"width":10,"height":20};');
    for (const sdk of ["FileExportArea.createForArtboard", "FileExportArea.createForSelection", "FileExportArea.createForSpreads", "doc.export("]) {
      expect(s).toContain(sdk);
    }
    expect(s).not.toContain("close(");
  });

  it("EXPORT_AREA passes null for no area and no size", () => {
    const s = EXPORT_AREA("U-1", "PNG", "/d/x.png", null, null);
    expect(s).toContain("const area = null;");
    expect(s).toContain("const outSize = null;");
  });
});

describe("exif module", () => {
  let dir: string;
  let log: string;
  const origPath = process.env["PATH"];

  const shim = (exit = 0): void => {
    const file = join(dir, "bin", "exiftool");
    writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\nexit ${exit}\n`);
    chmodSync(file, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-exif-"));
    mkdirSync(join(dir, "bin"));
    log = join(dir, "args.log");
    process.env["PATH"] = join(dir, "bin") + ":/usr/bin:/bin";
  });

  afterEach(() => {
    process.env["PATH"] = origPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects exiftool through -ver", () => {
    expect(exiftoolAvailable()).toBe(false); // PATH is only the empty shim dir plus /usr/bin:/bin
    shim();
    expect(exiftoolAvailable()).toBe(true);
  });

  it("embeds with -overwrite_original, DigitalSourceType and a description, no shell", () => {
    shim();
    const r = embedAiMetadata("/x/my file.png", SOURCE_SYNTHETIC, "desc; rm -rf /");
    expect(r).toEqual({ ok: true });
    expect(readFileSync(log, "utf8").trimEnd().split("\n")).toEqual([
      "-overwrite_original",
      "-XMP-iptcExt:DigitalSourceType=http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia",
      "-XMP-dc:Description=desc; rm -rf /",
      "/x/my file.png",
    ]);
  });

  it("reports a failing exiftool instead of throwing", () => {
    shim(1);
    expect(embedAiMetadata("/x/a.png", SOURCE_SYNTHETIC, "d").ok).toBe(false);
  });

  it("reports a missing exiftool instead of throwing", () => {
    const r = embedAiMetadata("/x/a.png", SOURCE_SYNTHETIC, "d");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("picks compositeSynthetic only when a generative edit was logged", () => {
    const rec = (identifier: string): ProvenanceRecord => ({
      time: "t",
      script: "s",
      sha256: "h",
      identifiers: [{ identifier, line: 1 }],
      args: null,
      outcome: "ok",
      documents: [],
    });
    expect(sourceTypeFor([rec("generateImage")])).toBe(SOURCE_SYNTHETIC);
    expect(sourceTypeFor([rec("createGenerateImage")])).toBe(SOURCE_SYNTHETIC);
    expect(sourceTypeFor([rec("generativeEditImage")])).toBe(SOURCE_COMPOSITE);
    expect(sourceTypeFor([rec("generateImage"), rec("createGenerativeEditImage")])).toBe(SOURCE_COMPOSITE);
    expect(SOURCE_SYNTHETIC.endsWith("/trainedAlgorithmicMedia")).toBe(true);
    expect(SOURCE_COMPOSITE.endsWith("/compositeSynthetic")).toBe(true);
  });

  it("describes the tool and the date", () => {
    const text = describeAi(SOURCE_SYNTHETIC, new Date("2026-10-24T12:00:00Z"));
    expect(text).toContain("affinity-axi");
    expect(text).toContain("2026-10-24");
    expect(describeAi(SOURCE_COMPOSITE, new Date("2026-10-24T12:00:00Z"))).toContain("composite");
  });
});

describe("export command: embedded AI metadata", () => {
  const origPath = process.env["PATH"];
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const exportCmd = makeExportModule(fakeConnect()).export;
  let server: FakeServer;
  let root: string;
  let desktop: string;
  let log: string;

  const record = (identifier: string) =>
    appendProvenance({
      time: "2026-10-24T10:00:00.000Z",
      script: "SYNTHETIC",
      sha256: "0",
      identifiers: [{ identifier, line: 1 }],
      args: { synthetic: true },
      outcome: "ok",
      documents: [FIXTURE_UUID],
    });

  /** PATH holding a fake exiftool that records its arguments; omit the exit code for a PATH without exiftool. */
  function pathWith(exit?: number): void {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    if (exit !== undefined) {
      const file = join(bin, "exiftool");
      writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\nexit ${exit}\n`);
      chmodSync(file, 0o755);
    }
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  }

  const exiftoolArgs = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : []);

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    root = mkdtempSync(join(tmpdir(), "axi-meta-"));
    desktop = join(root, "Desktop");
    mkdirSync(desktop);
    mkdirSync(join(root, "work"));
    process.chdir(join(root, "work"));
    log = join(root, "exiftool.log");
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    server.onScript(
      "affinity-axi:list-artboards",
      JSON.stringify({ spreads: 1, artboards: ["ig-square", "ig-portrait", "og"].map((name, index) => ({ index, name })) }),
    );
    // Any export writes a tiny PNG (an SVG stub for .svg paths) at the requested path.
    const write = (script: string): string => {
      const out = argOf(script, "outPath") as string;
      writeFileSync(out, out.endsWith(".svg") ? "<svg/>" : pngBuf(100, 50));
      return "{}";
    };
    server.onScript("affinity-axi:area-export", write);
    server.onScript("affinity-axi:export", write);
  });
  afterEach(async () => {
    process.env["PATH"] = origPath;
    process.chdir(origCwd);
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("embeds DigitalSourceType and a description into each exported PNG, and still writes sidecars", async () => {
    record("generateImage");
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provenance: ai-generated");
    expect(r.stdout).toContain("metadata: iptc embedded");
    expect(r.stdout).toContain("provenance_files: 3");
    const args = exiftoolArgs();
    expect(args.filter((a) => a === "-overwrite_original")).toHaveLength(3);
    expect(args.filter((a) => a.endsWith("digitalsourcetype/trainedAlgorithmicMedia"))).toHaveLength(3);
    expect(args.filter((a) => a.startsWith("-XMP-iptcExt:DigitalSourceType="))).toHaveLength(3);
    expect(args.filter((a) => a.startsWith("-XMP-dc:Description=") && a.includes("affinity-axi") && /\d{4}-\d\d-\d\d/.test(a))).toHaveLength(3);
    for (const n of ["ig-square", "ig-portrait", "og"]) {
      expect(args).toContain(join(desktop, `${n}.png`));
      const side = JSON.parse(readFileSync(join(desktop, `${n}.png.provenance.json`), "utf8"));
      expect(side.ai_generated).toBe(true);
      expect(side.document).toBe(FIXTURE_UUID);
    }
  });

  it("uses compositeSynthetic when a generative edit was logged", async () => {
    record("generativeEditImage");
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "e.png"), "--selection"]);
    expect(r.stdout).toContain("metadata: iptc embedded");
    expect(exiftoolArgs().some((a) => a.endsWith("digitalsourcetype/compositeSynthetic"))).toBe(true);
    expect(r.stdout).toContain("provenance_file:");
  });

  it("without exiftool the export succeeds with sidecar only", async () => {
    record("generateImage");
    pathWith();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "n.png"), "--selection"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("metadata: sidecar only (exiftool not found)");
    expect(existsSync(join(desktop, "n.png.provenance.json"))).toBe(true);
    expect(exiftoolArgs()).toEqual([]);
  });

  it("a failing exiftool never fails the export", async () => {
    record("generateImage");
    pathWith(1);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "f.png"), "--selection"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("metadata: sidecar only (exiftool failed");
    expect(existsSync(join(desktop, "f.png.provenance.json"))).toBe(true);
    expect(statSync(join(desktop, "f.png")).size).toBe(33);
  });

  it("a document that is not AI-generated is never touched and prints no metadata line", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "h.png"), "--selection"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("metadata:");
    expect(r.stdout).not.toContain("provenance");
    expect(exiftoolArgs()).toEqual([]);
    expect(existsSync(join(desktop, "h.png.provenance.json"))).toBe(false);
  });

  it("vector output gets the sidecar and a format note, and exiftool is not called", async () => {
    record("generateImage");
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "v.svg")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("metadata: sidecar only (format not supported for embedding)");
    expect(exiftoolArgs()).toEqual([]);
    expect(existsSync(join(desktop, "v.svg.provenance.json"))).toBe(true);
  });
});
