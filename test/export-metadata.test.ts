// `export` and Affinity's XMP stamp: default strip, --creator/--copyright, --keep-metadata,
// the kit credit, --max-kb measuring the final file, and the AI label sharing one exiftool call.
// Fake MCP server plus a fake exiftool first on PATH (pattern of export-area.test.ts).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProvenance } from "../src/affinity/provenance.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
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

/** A PNG as Affinity writes a whole-document export: ICC profile plus an iTXt XMP chunk naming the account. */
function stampedPng(xmpPad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0);
  ihdr.writeUInt32BE(50, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const xmp = `XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>account-handle</rdf:li></rdf:Seq></dc:creator>${"x".repeat(xmpPad)}</x:xmpmeta>`;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("sRGB\0\0profile")), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

const argOf = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

describe("export command: creator metadata", () => {
  const origPath = process.env["PATH"];
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const exportCmd = makeExportModule(fakeConnect()).export;
  let server: FakeServer;
  let root: string;
  let desktop: string;
  let log: string;
  let pad = 0;

  /** PATH holding a fake exiftool that records its arguments; omit the exit code for a PATH without exiftool. */
  function pathWith(exit?: number): void {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    if (exit !== undefined) {
      const file = join(bin, "exiftool");
      writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\necho "--" >> "${log}"\nexit ${exit}\n`);
      chmodSync(file, 0o755);
    }
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  }

  /** One array of arguments per exiftool invocation. */
  const calls = (): string[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split("--\n")
          .filter((c) => c !== "")
          .map((c) => c.trimEnd().split("\n"))
      : [];

  const record = () =>
    appendProvenance({
      time: "2026-10-24T10:00:00.000Z",
      script: "SYNTHETIC",
      sha256: "0",
      identifiers: [{ identifier: "generateImage", line: 1 }],
      args: { synthetic: true },
      outcome: "ok",
      documents: [FIXTURE_UUID],
    });

  const brandKit = (credit?: unknown): string =>
    JSON.stringify({ schema: "affinity-axi/brand/1", name: "Kit", colours: { ink: "#111111" }, fonts: { headline: "Arial-BoldMT", body: "ArialMT" }, ...(credit ? { credit } : {}) });

  beforeEach(async () => {
    pad = 0;
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-meta-"));
    desktop = join(root, "Desktop");
    mkdirSync(desktop);
    mkdirSync(join(root, "work"));
    process.chdir(join(root, "work"));
    log = join(root, "exiftool.log");
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    const write = (script: string): string => {
      writeFileSync(argOf(script, "outPath") as string, stampedPng(pad));
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
    if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
    else process.env["AFFINITY_AXI_BRAND"] = origBrand;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (name: string): Buffer => readFileSync(join(desktop, name));

  it("strips the stamp by default, keeps the ICC chunk, calls no exiftool and prints no metadata line", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "plain.png")]);
    expect(r.code).toBe(0);
    const png = read("plain.png");
    expect(png.includes("iTXt")).toBe(false);
    expect(png.includes("account-handle")).toBe(false);
    expect(png.includes("iCCP")).toBe(true);
    expect(png.includes("IDAT")).toBe(true);
    expect(calls()).toEqual([]);
    expect(r.stdout).not.toContain("metadata:");
    expect(r.stdout).toContain(`bytes: ${png.length}`);
    expect(r.stdout).toContain("size: 100x50");
  });

  it("strips even when exiftool is not installed", async () => {
    pathWith();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "plain.png")]);
    expect(r.code).toBe(0);
    expect(read("plain.png").includes("iTXt")).toBe(false);
    expect(r.stdout).not.toContain("metadata:");
  });

  it("--creator and --copyright make one exiftool call that clears XMP then writes the credit", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "c.png"), "--creator", "Studio X", "--copyright", "(c) 2026"]);
    expect(r.code).toBe(0);
    expect(calls()).toHaveLength(1);
    const args = calls()[0]!;
    expect(args).toContain("-overwrite_original");
    expect(args).toContain("-XMP:all=");
    expect(args.indexOf("-XMP:all=")).toBeLessThan(args.indexOf("-XMP-dc:Creator=Studio X"));
    expect(args).toContain("-XMP-dc:Creator=Studio X");
    expect(args).toContain("-XMP-dc:Rights=(c) 2026");
    expect(args).toContain("-XMP-xmpRights:Marked=true");
    expect(args).toContain(join(desktop, "c.png"));
    expect(r.stdout).toContain("metadata: creator and copyright embedded");
    expect(read("c.png").includes("iTXt")).toBe(false);
  });

  it("--creator alone writes no rights tags", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "c.png"), "--creator", "Studio X"]);
    expect(r.stdout).toContain("metadata: creator embedded");
    expect(calls()[0]!.some((a) => a.startsWith("-XMP-dc:Rights") || a.startsWith("-XMP-xmpRights"))).toBe(false);
  });

  it("--creator without exiftool still strips the PNG and reports what was not written", async () => {
    pathWith();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "n.png"), "--creator", "Studio X"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("metadata: creator NOT embedded (exiftool not found)");
    expect(read("n.png").includes("iTXt")).toBe(false);
  });

  it("a failing exiftool never fails the export", async () => {
    pathWith(1);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "f.png"), "--creator", "Studio X"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("metadata: creator NOT embedded (exiftool failed");
    expect(read("f.png").includes("iTXt")).toBe(false);
  });

  it("an AI document with --creator gets one exiftool call with both tag sets, and its sidecar", async () => {
    record();
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "ai.png"), "--creator", "Studio X"]);
    expect(r.code).toBe(0);
    expect(calls()).toHaveLength(1);
    const args = calls()[0]!;
    expect(args.some((a) => a.startsWith("-XMP-iptcExt:DigitalSourceType="))).toBe(true);
    expect(args.some((a) => a.startsWith("-XMP-dc:Description="))).toBe(true);
    expect(args).toContain("-XMP-dc:Creator=Studio X");
    expect(r.stdout).toContain("provenance: ai-generated");
    expect(r.stdout).toContain("metadata: iptc embedded, creator embedded");
    expect(existsSync(join(desktop, "ai.png.provenance.json"))).toBe(true);
  });

  it("--keep-metadata keeps the iTXt chunk, calls no exiftool and says so", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "k.png"), "--keep-metadata"]);
    expect(r.code).toBe(0);
    expect(read("k.png").equals(stampedPng())).toBe(true);
    expect(calls()).toEqual([]);
    expect(r.stdout).toContain("metadata: Affinity XMP kept");
  });

  it("--keep-metadata with --creator or --copyright is a usage error before connecting", async () => {
    pathWith(0);
    const a = await runCommand(exportCmd, ["current", "PNG", join(desktop, "u.png"), "--keep-metadata", "--creator", "x"]);
    expect(a.code).toBe(2);
    const b = await runCommand(exportCmd, ["current", "PNG", join(desktop, "u.png"), "--keep-metadata", "--copyright", "x"]);
    expect(b.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
    expect(existsSync(join(desktop, "u.png"))).toBe(false);
  });

  it("--copyright without a creator is a usage error before connecting", async () => {
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "u.png"), "--copyright", "(c)"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--copyright needs --creator");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--max-kb measures the file after the strip: fits on the first attempt and reports the on-disk size", async () => {
    pad = 3000;
    pathWith(0);
    const dest = join(desktop, "b.png");
    expect(stampedPng(pad).length).toBeGreaterThan(3000);
    const r = await runCommand(exportCmd, ["current", "PNG", dest, "--max-kb", "1"]);
    expect(r.code).toBe(0);
    const size = statSync(dest).size;
    expect(size).toBeLessThan(1024);
    expect(r.stdout).toContain(`bytes: ${size}`);
    expect(r.stdout).toMatch(/PNG,100x50,\d+,true/);
    expect(r.stdout.match(/,true/g)).toHaveLength(1);
  });

  it("a brand.json in the working folder supplies the credit when no flag is given", async () => {
    writeFileSync(join(root, "work", "brand.json"), brandKit({ creator: "Kit Studio", copyright: "(c) Kit" }));
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "kit.png")]);
    expect(r.code).toBe(0);
    const args = calls()[0]!;
    expect(args).toContain("-XMP-dc:Creator=Kit Studio");
    expect(args).toContain("-XMP-dc:Rights=(c) Kit");
    expect(r.stdout).toContain("metadata: creator and copyright embedded");
  });

  it("--creator wins over the kit, and --creator \"\" writes no credit", async () => {
    writeFileSync(join(root, "work", "brand.json"), brandKit({ creator: "Kit Studio" }));
    pathWith(0);
    const a = await runCommand(exportCmd, ["current", "PNG", join(desktop, "a.png"), "--creator", "Flag Studio"]);
    expect(a.code).toBe(0);
    expect(calls()[0]).toContain("-XMP-dc:Creator=Flag Studio");
    const b = await runCommand(exportCmd, ["current", "PNG", join(desktop, "b.png"), "--creator", ""]);
    expect(b.code).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(b.stdout).not.toContain("metadata:");
    expect(read("b.png").includes("iTXt")).toBe(false);
  });

  it("an explicit --brand kit is used", async () => {
    writeFileSync(join(root, "work", "other.brand.json"), brandKit({ creator: "Other Studio" }));
    pathWith(0);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "o.png"), "--brand", "./other.brand.json"]);
    expect(r.code).toBe(0);
    expect(calls()[0]).toContain("-XMP-dc:Creator=Other Studio");
  });
});
