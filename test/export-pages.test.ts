// Multi-page exports: Affinity writes <stem>_<k><ext> instead of the asked path on a document with
// more than one page. A spread export is renamed to the asked name; a whole-document export keeps the
// page files, each cleaned of Affinity's XMP stamp. Fake MCP server plus temp dirs (pattern of export-metadata.test.ts).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestPath, readManifest } from "../src/affinity/manifest.js";
import { pageFilesFor, pagesNote, recoverPages } from "../src/affinity/export-pages.js";
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

/** A PNG as Affinity writes it: ICC profile plus an iTXt XMP chunk naming the account. */
function stampedPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0);
  ihdr.writeUInt32BE(50, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const xmp = "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>account-handle</rdf:li></rdf:Seq></dc:creator></x:xmpmeta>";
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("sRGB\0\0profile")), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

const argOf = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);
/** `<dir>/<stem>_<k><ext>` for an asked path. */
const pageOf = (path: string, k: number): string => join(dirname(path), `${basename(path, extname(path))}_${k}${extname(path)}`);

describe("export-pages: finding page files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "axi-pages-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pageFilesFor orders by page number and ignores other names and old files", () => {
    const target = join(dir, "s.png");
    for (const n of ["s_2.png", "s_10.png", "s_1.png", "s_0.png", "s_1.jpg", "t_1.png", "s_x.png", "s.png"]) writeFileSync(join(dir, n), "x");
    const past = new Date(Date.now() - 60000);
    utimesSync(join(dir, "s_10.png"), past, past);
    expect(pageFilesFor(target, Date.now() - 5000).map((f) => basename(f))).toEqual(["s_1.png", "s_2.png"]);
    expect(pageFilesFor(target, 0).map((f) => basename(f))).toEqual(["s_1.png", "s_2.png", "s_10.png"]);
  });

  it("recoverPages renames the single page of a spread export and keeps every page of a whole export", () => {
    const target = join(dir, "s.png");
    writeFileSync(pageOf(target, 1), "one");
    expect(recoverPages(target, "spread", Date.now() - 5000)).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("one");
    expect(existsSync(pageOf(target, 1))).toBe(false);

    const whole = join(dir, "w.png");
    writeFileSync(pageOf(whole, 1), "a");
    expect(recoverPages(whole, "whole", Date.now() - 5000)).toEqual([pageOf(whole, 1)]);
    expect(existsSync(whole)).toBe(false);
    expect(pagesNote([pageOf(whole, 1), pageOf(whole, 2)])).toBe("pages: 2 files (w_1.png … w_2.png; Affinity names multi-page exports per page)");
  });

  it("recoverPages leaves a freshly written target alone", () => {
    const target = join(dir, "s.png");
    writeFileSync(target, "fresh");
    writeFileSync(pageOf(target, 1), "page");
    expect(recoverPages(target, "spread", Date.now() - 5000)).toBeNull();
    expect(existsSync(pageOf(target, 1))).toBe(true);
  });
});

describe("export command: multi-page documents", () => {
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const exportCmd = makeExportModule(fakeConnect()).export;
  let server: FakeServer;
  let root: string;
  let desktop: string;
  let pageCount = 2;
  let writePages = true;

  beforeEach(async () => {
    pageCount = 2;
    writePages = true;
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-pages-cmd-"));
    desktop = join(root, "Desktop");
    mkdirSync(desktop);
    mkdirSync(join(root, "work"));
    process.chdir(join(root, "work"));
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: [{ ...FIXTURE_DOCS[0]!, path: join(desktop, "doc.af") }] }));
    // A two-page document: the scripts write <stem>_<k><ext> and never the asked path.
    const write = (script: string): string => {
      const out = argOf(script, "outPath") as string;
      if (writePages) for (let k = 1; k <= pageCount; k++) writeFileSync(pageOf(out, k), stampedPng());
      return "{}";
    };
    server.onScript("affinity-axi:area-export", write);
    server.onScript("affinity-axi:export", write);
  });
  afterEach(async () => {
    process.chdir(origCwd);
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
    else process.env["AFFINITY_AXI_BRAND"] = origBrand;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const read = (name: string): Buffer => readFileSync(join(desktop, name));
  const files = (): string[] => readdirSync(desktop).filter((n) => n.endsWith(".png")).sort();
  const withManifest = (): void => writeFileSync(manifestPath(join(desktop, "doc.af")), JSON.stringify({ schema: "affinity-axi/manifest/1", file: "doc.af", exports: [] }));

  it("--spread with one page file renames it to the asked path, strips it and records it", async () => {
    pageCount = 1;
    withManifest();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "s1.png"), "--spread", "1"]);
    expect(r.code).toBe(0);
    expect(files()).toEqual(["s1.png"]);
    const png = read("s1.png");
    expect(png.includes("iTXt")).toBe(false);
    expect(png.includes("account-handle")).toBe(false);
    expect(png.includes("iCCP")).toBe(true);
    expect(r.stdout).toContain(`export: ${join(desktop, "s1.png")}`);
    expect(r.stdout).toContain(`bytes: ${png.length}`);
    expect(r.stdout).toContain("size: 100x50");
    expect(r.stdout).not.toContain("pages:");
    const m = readManifest(join(desktop, "doc.af"))!;
    expect(m.exports.map((e: { path: string; area: string }) => [e.path, e.area])).toEqual([[join(desktop, "s1.png"), "spread:1"]]);
  });

  it("a whole-document export keeps both page files, strips each, prints a line per file and a note", async () => {
    withManifest();
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "s0.png")]);
    expect(r.code).toBe(0);
    expect(files()).toEqual(["s0_1.png", "s0_2.png"]);
    for (const n of files()) {
      expect(read(n).includes("iTXt")).toBe(false);
      expect(read(n).includes("account-handle")).toBe(false);
      expect(r.stdout).toContain(`export: ${join(desktop, n)}`);
    }
    expect(r.stdout.match(/^export: /gm)).toHaveLength(2);
    expect(r.stdout).toContain("note: pages: 2 files (s0_1.png … s0_2.png; Affinity names multi-page exports per page)");
    const m = readManifest(join(desktop, "doc.af"))!;
    expect(m.exports.map((e: { path: string; area: string }) => [e.path, e.area])).toEqual([
      [join(desktop, "s0_1.png"), "whole"],
      [join(desktop, "s0_2.png"), "whole"],
    ]);
  });

  it("--spread on a document where several page files appear keeps them all", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "sp.png"), "--spread", "0"]);
    expect(r.code).toBe(0);
    expect(files()).toEqual(["sp_1.png", "sp_2.png"]);
    expect(r.stdout).toContain("pages: 2 files");
  });

  it("size flags with page files clean the files first, then fail naming them", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "z.png"), "--width", "50"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("multi-page");
    expect(r.stdout).toContain("z_1.png");
    expect(read("z_1.png").includes("iTXt")).toBe(false);
    expect(read("z_2.png").includes("iTXt")).toBe(false);
  });

  it("an old page file from an earlier export is ignored: the usual 'not written' error", async () => {
    writePages = false;
    const old = join(desktop, "s_1.png");
    writeFileSync(old, stampedPng());
    const past = new Date(Date.now() - 60000);
    utimesSync(old, past, past);
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "s.png"), "--spread", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("was not written");
    expect(files()).toEqual(["s_1.png"]);
    expect(read("s_1.png").includes("iTXt")).toBe(true);
  });

  it("no page files and no target is today's 'not written' error", async () => {
    writePages = false;
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "none.png")]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("was not written");
  });

  it("--selection never looks for page files", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "sel.png"), "--selection"]);
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("was not written");
    expect(files()).toEqual(["sel_1.png", "sel_2.png"]);
    expect(read("sel_1.png").includes("iTXt")).toBe(true);
  });
});
