// `fill --export` and Affinity's XMP stamp: PNGs come out stripped, the brand kit's
// credit is embedded (one exiftool call per file), and a missing exiftool is a note, not a failure.
// Fake MCP server plus a fake exiftool first on PATH (pattern of export-metadata.test.ts).

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyReply } from "../src/affinity/fill-script.js";
import { make } from "../src/commands/fill.js";
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

const origPath = process.env["PATH"];
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const origBrand = process.env["AFFINITY_AXI_BRAND"];
let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
let log: string;
const fill = make(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  delete process.env["AFFINITY_AXI_BRAND"];
  root = mkdtempSync(join(tmpdir(), "axi-fill-meta-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
  log = join(root, "exiftool.log");
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
const calls = (): string[][] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("--\n")
        .filter((c) => c !== "")
        .map((c) => c.trimEnd().split("\n"))
    : [];

const OK_REPLY: ApplyReply = { applied: ["headline"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline"] };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;

function stub(): void {
  let opens = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG", "JPEG (High quality)"]));
  server.onScript("affinity-axi:fill-open", () => JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) }));
  server.onScript("affinity-axi:fill-apply", JSON.stringify(OK_REPLY));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: [{ index: 0, name: "ig" }, { index: 1, name: "story" }] }));
  const exporter = (script: string): string => {
    const path = quoted(script, "outPath");
    writeFileSync(path, stampedPng());
    return JSON.stringify({ exported: path });
  };
  server.onScript("affinity-axi:export", exporter);
  server.onScript("affinity-axi:area-export", exporter);
}

function setup(credit?: unknown): { args: string[]; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  writeFileSync(join(work, "posts.json"), JSON.stringify([{ slug: "mar", headline: "Spring" }, { slug: "apr", headline: "April" }]));
  const kit = { schema: "affinity-axi/brand/1", name: "Kit", colours: { ink: "#111111" }, fonts: { headline: "Arial-BoldMT", body: "ArialMT" }, ...(credit ? { credit } : {}) };
  writeFileSync(join(work, "brand.json"), JSON.stringify(kit));
  const out = join(desktop, "out");
  return { args: [template, "--data", join(work, "posts.json"), "--key", "slug", "--out-dir", out, "--export", "PNG"], out };
}
const png = (out: string, name: string): Buffer => readFileSync(join(out, name));

describe("fill --export metadata", () => {
  it("strips the stamp from every exported PNG, keeps ICC, spawns no exiftool, adds no metadata note", async () => {
    pathWith(0);
    stub();
    const { args, out } = setup();
    const r = await runCommand(fill, args);
    expect(r.code).toBe(0);
    for (const name of ["mar.png", "apr.png"]) {
      const b = png(out, name);
      expect(b.includes("iTXt")).toBe(false);
      expect(b.includes("account-handle")).toBe(false);
      expect(b.includes("iCCP")).toBe(true);
    }
    expect(calls()).toEqual([]);
    expect(r.stdout).toContain("exported mar.png");
    expect(r.stdout).not.toContain("metadata:");
  });

  it("embeds the kit credit once per file and says so in the record note", async () => {
    pathWith(0);
    stub();
    const { args, out } = setup({ creator: "Studio X", copyright: "(c) 2026 Studio X" });
    const r = await runCommand(fill, args);
    expect(r.code).toBe(0);
    const c = calls();
    expect(c).toHaveLength(2);
    expect(c.map((a) => a[a.length - 1])).toEqual([join(out, "mar.png"), join(out, "apr.png")]);
    for (const a of c) {
      expect(a).toContain("-XMP:all=");
      expect(a.filter((x) => x === "-XMP-dc:Creator=Studio X")).toHaveLength(1);
      expect(a).toContain("-XMP-dc:Rights=(c) 2026 Studio X");
      expect(a).toContain("-XMP-xmpRights:Marked=true");
    }
    expect(r.stdout).toContain("metadata: creator and copyright embedded");
    expect(png(out, "mar.png").includes("iTXt")).toBe(false);
  });

  it("--all-artboards finalizes every artboard file", async () => {
    pathWith(0);
    stub();
    const { args, out } = setup({ creator: "Studio X" });
    const r = await runCommand(fill, [...args, "--all-artboards", "--limit", "1"]);
    expect(r.code).toBe(0);
    const c = calls();
    expect(c.map((a) => a[a.length - 1])).toEqual([join(out, "mar-ig.png"), join(out, "mar-story.png")]);
    for (const a of c) expect(a.filter((x) => x === "-XMP-dc:Creator=Studio X")).toHaveLength(1);
    expect(r.stdout).toContain("exported 2 files");
    expect(r.stdout).toContain("metadata: creator embedded");
    for (const name of ["mar-ig.png", "mar-story.png"]) expect(png(out, name).includes("iTXt")).toBe(false);
  });

  it("without exiftool the PNG is still stripped, the record stays ok and the note says creator NOT embedded", async () => {
    pathWith();
    stub();
    const { args, out } = setup({ creator: "Studio X" });
    const r = await runCommand(fill, args);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("creator NOT embedded (exiftool not found)");
    expect(r.stdout).toMatch(/mar,ok,/);
    expect(r.stdout).toMatch(/apr,ok,/);
    expect(png(out, "mar.png").includes("iTXt")).toBe(false);
  });

  it("an exiftool failure is a note too, not a failed record", async () => {
    pathWith(1);
    stub();
    const { args } = setup({ creator: "Studio X" });
    const r = await runCommand(fill, [...args, "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("creator NOT embedded");
    expect(r.stdout).toMatch(/mar,ok,/);
  });

  it("the --export flag description mentions the stripped stamp and the kit credit", () => {
    const flag = fill.spec.flags.find((f) => f.name === "export")!;
    expect(flag.description).toContain("credit");
    expect(flag.description).toContain("stripped");
  });
});
