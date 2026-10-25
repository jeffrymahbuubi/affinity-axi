// `batch --out-dir` and Affinity's XMP stamp: rasters a template wrote to the top level of --out-dir
// since the record started are cleaned (and get the kit credit), older files are left alone, and the
// `cleaned: <n>` line appears only with --out-dir. Fake MCP server; a fake exiftool on PATH logs its calls.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/batch.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
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
function stampedPng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(100, 0);
  ihdr.writeUInt32BE(50, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const xmp = "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>account-handle</rdf:li></rdf:Seq></dc:creator></x:xmpmeta>";
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("iCCP", Buffer.from("sRGB\0\0profile")), chunk("iTXt", Buffer.from(xmp)), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

const hasStamp = (file: string): boolean => readFileSync(file).includes("iTXt");
const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";
const POSTS = JSON.stringify([{ slug: "a" }, { slug: "b" }]);
const argsOf = (script: string): Record<string, unknown> => JSON.parse(/const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;

describe("batch --out-dir: XMP strip", () => {
  const origPath = process.env["PATH"];
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const batch = make(fakeConnect());
  let server: FakeServer;
  let root: string;
  let work: string;
  let desktop: string;
  let out: string;
  let log: string;

  /** PATH holding a fake exiftool that records its arguments; omit the exit code for a PATH without exiftool. */
  function pathWith(exit?: number): void {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    rmSync(join(bin, "exiftool"), { force: true });
    if (exit !== undefined) {
      const file = join(bin, "exiftool");
      writeFileSync(file, `#!/bin/sh\nif [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi\nprintf '%s\\n' "$@" >> "${log}"\necho "--" >> "${log}"\nexit ${exit}\n`);
      chmodSync(file, 0o755);
    }
    process.env["PATH"] = `${bin}:/usr/bin:/bin`;
  }

  /** The template run writes `<outDir>/<key>.png` (stamped), plus whatever `extra` adds. */
  function stubTemplate(extra?: (args: Record<string, unknown>) => void): void {
    let n = 0;
    server.onScript("TEMPLATE_MARK", (script) => {
      const args = argsOf(script);
      if (typeof args["outBase"] === "string") writeFileSync(`${args["outBase"]}.png`, stampedPng());
      extra?.(args);
      return JSON.stringify({ uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, key: args["key"] });
    });
  }

  const write = (name: string, body: string): string => {
    const p = join(work, name);
    writeFileSync(p, body);
    return p;
  };

  /** ./brand.json: the example kit plus a credit. */
  function writeKit(credit: { creator: string; copyright?: string }): void {
    const kit = JSON.parse(readFileSync(join(origCwd, "examples/_brand/brand.json"), "utf8")) as Record<string, unknown>;
    write("brand.json", JSON.stringify({ ...kit, credit }));
  }

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-batch-meta-"));
    work = join(root, "work");
    desktop = join(root, "Desktop");
    out = join(desktop, "out");
    log = join(root, "exiftool.log");
    mkdirSync(work);
    mkdirSync(desktop);
    process.chdir(work);
    pathWith(0);
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
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

  it("cleans the PNG each record wrote, keeps the ICC profile, and prints cleaned: <n> after the summary", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    for (const k of ["a", "b"]) {
      expect(hasStamp(join(out, `${k}.png`))).toBe(false);
      expect(readFileSync(join(out, `${k}.png`)).includes("iCCP")).toBe(true);
    }
    expect(r.stdout).toContain("cleaned: 2");
    expect(r.stdout.indexOf("summary:")).toBeLessThan(r.stdout.indexOf("cleaned: 2"));
    expect(existsSync(log)).toBe(false); // no credit: PNG strip is pure Node, exiftool never runs
  });

  it("leaves a pre-existing older PNG alone", async () => {
    mkdirSync(out, { recursive: true });
    const old = join(out, "old.png");
    writeFileSync(old, stampedPng());
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(old, past, past);
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(hasStamp(old)).toBe(true);
    expect(hasStamp(join(out, "a.png"))).toBe(false);
    expect(r.stdout).toContain("cleaned: 2");
  });

  it("scans only the top level and only raster extensions", async () => {
    stubTemplate((args) => {
      mkdirSync(join(String(args["outDir"]), "nested"), { recursive: true });
      writeFileSync(join(String(args["outDir"]), "nested", `${String(args["key"])}.png`), stampedPng());
      writeFileSync(join(String(args["outDir"]), `${String(args["key"])}.txt`), "iTXt not an image");
    });
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(hasStamp(join(out, "nested", "a.png"))).toBe(true);
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("iTXt not an image");
    expect(r.stdout).toContain("cleaned: 2");
  });

  it("without --out-dir there is no cleaned: line and nothing is scanned", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toContain("cleaned:");
    expect(r.stdout).not.toContain("metadata");
  });

  it("a record that writes no file counts zero", async () => {
    server.onScript("TEMPLATE_MARK", JSON.stringify({ uuid: "00000000-0000-4000-8000-000000000001" }));
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", JSON.stringify([{ slug: "a" }])), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain("cleaned: 0");
  });

  it("the kit credit is embedded into each cleaned file with one exiftool call per file", async () => {
    writeKit({ creator: "Studio X", copyright: "(c) 2026" });
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    const args = readFileSync(log, "utf8");
    expect(args.split("--\n").filter((c) => c.trim() !== "")).toHaveLength(2);
    expect(args).toContain("-XMP:all=");
    expect(args).toContain("-XMP-dc:Creator=Studio X");
    expect(args).toContain("-XMP-dc:Rights=(c) 2026");
    expect(args).toContain(join(out, "a.png"));
    expect(args).toContain(join(out, "b.png"));
    expect(r.stdout).toContain("metadata: creator and copyright embedded");
    expect(r.stdout).toContain("cleaned: 2");
  });

  it("a kit credit without exiftool still strips the PNG and says what was not written", async () => {
    pathWith();
    writeKit({ creator: "Studio X" });
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", JSON.stringify([{ slug: "a" }])), "--key", "slug", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(hasStamp(join(out, "a.png"))).toBe(false);
    expect(r.stdout).toContain("creator NOT embedded (exiftool not found)");
    expect(r.stdout).toContain("cleaned: 0");
  });
});
