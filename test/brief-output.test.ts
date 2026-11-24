// --brief / --quiet on export, doc save and doc close (issue #7), against the fake MCP server.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32 } from "node:zlib";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefLine, digest16 } from "../src/commands/brief.js";
import { make as makeDoc } from "../src/commands/doc.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { readManifest, writeManifest } from "../src/affinity/manifest.js";
import { appendProvenance } from "../src/affinity/provenance.js";
import { dispatch } from "../src/cli/router.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, FIXTURE_UUID_2 } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const { export: exportCmd } = makeExportModule(fakeConnect());
const doc = makeDoc(fakeConnect());

const BOARDS = [
  { index: 0, name: "ig-square", w: 1080, h: 1080 },
  { index: 1, name: "og", w: 1200, h: 630 },
];

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A well-formed PNG (so the metadata pass has nothing to report), padded to at least `bytes` with trailing zeros. */
function pngBuf(width: number, height: number, bytes = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(Math.max(4, bytes - 57))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png;
}

const field = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-brief-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
  state.docPath = "";
  state.fileBytes = 1842;
  state.raw = "";
  stubExport();
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const state = { docPath: "", fileBytes: 1842, raw: "" };

function stubExport(): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify([...FIXTURE_PRESETS, "JPEG (Medium quality)", "JPEG (Low quality)"]));
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    () => JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS.map((d, i) => (i === 0 ? { ...d, dirty: false, path: state.docPath } : d)) }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: BOARDS.map((b) => ({ index: b.index, name: b.name })) }));
  server.onScript("affinity-axi:export", (s) => (writeFileSync(field(s, "outPath") as string, state.raw !== "" ? state.raw : pngBuf(800, 600, state.fileBytes)), "{}"));
  server.onScript("affinity-axi:area-export", (s) => {
    const area = field(s, "area") as { index?: number } | null;
    const b = BOARDS[area?.index ?? 0]!;
    writeFileSync(field(s, "outPath") as string, pngBuf(b.w, b.h, state.fileBytes === 1842 ? 0 : state.fileBytes));
    return "{}";
  });
}

const sha16 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);

describe("export --brief", () => {
  it("prints exactly one line and nothing else", async () => {
    const target = join(desktop, "logo.png");
    const r = await runCommand(exportCmd, ["current", "PNG", target, "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^export: bytes=\d+ size=\d+x\d+ sha256=[0-9a-f]{16} path=.+\n$/);
    expect(r.stdout).toContain("size=800x600");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toContain(`sha256=${sha16(target)}`);
    for (const s of ["doc:", "alt:", "help["]) expect(r.stdout).not.toContain(s);
  });

  it("--quiet prints the same line as --brief", async () => {
    const a = await runCommand(exportCmd, ["current", "PNG", join(desktop, "q.png"), "--quiet"]);
    const b = await runCommand(exportCmd, ["current", "PNG", join(desktop, "q.png"), "--brief"]);
    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("omits size for a non-image file", async () => {
    state.raw = "<svg/>";
    const r = await runCommand(exportCmd, ["current", "SVG (digital - high quality)", join(desktop, "x.svg"), "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^export: bytes=6 sha256=[0-9a-f]{16} path=.+\n$/);
    expect(r.stdout).not.toContain(" size=");
  });

  it("--all-artboards prints one list with a row per file", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "{name}.png"), "--all-artboards", "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exports[2]{path,bytes,size,sha256}:");
    expect(r.stdout.trim().split("\n")).toHaveLength(3);
    expect(r.stdout).toContain(`,61,1080x1080,${sha16(join(desktop, "ig-square.png"))}`);
    expect(r.stdout).not.toContain("help[");
  });

  it("an AI-touched document still prints the provenance line after the brief line", async () => {
    appendProvenance({
      time: "2026-10-24T10:00:00.000Z",
      script: "SYNTHETIC",
      sha256: "0",
      identifiers: [{ identifier: "generateImage", line: 1 }],
      args: { synthetic: true },
      outcome: "ok",
      documents: [FIXTURE_UUID],
    });
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "ai.png"), "--brief"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/^export: bytes=/);
    expect(lines.some((l) => l.startsWith("provenance:"))).toBe(true);
  });

  it("records the same manifest entry with and without the flag", async () => {
    const af = join(work, "ad.af");
    writeFileSync(af, "af");
    writeManifest(af, { exports: [], history: [], notes: [] } as never);
    state.docPath = af;
    await runCommand(exportCmd, ["current", "PNG", join(desktop, "m.png")]);
    const plain = readManifest(af)!.exports[0]!;
    writeManifest(af, { exports: [], history: [], notes: [] } as never);
    await runCommand(exportCmd, ["current", "PNG", join(desktop, "m.png"), "--brief"]);
    const brief = readManifest(af)!.exports[0]!;
    expect(brief).toEqual({ ...plain, time: brief.time });
    expect(brief.bytes).toBe(1842);
  });

  it("a --max-kb miss prints the brief line, then the unchanged error, exit 1", async () => {
    state.fileBytes = 90_000;
    const r = await runCommand(exportCmd, ["current", "JPEG (High quality)", join(desktop, "big.jpg"), "--artboard", "og", "--max-kb", "1", "--brief"]);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith("export: bytes=")).toBe(true);
    expect(r.stdout).toContain("cannot fit");
    expect(r.stdout).not.toContain("attempts[");
  });

  it("a misspelt flag is still exit 2 and the valid list names --brief and --quiet", async () => {
    const r = await runCommand(exportCmd, ["current", "PNG", join(desktop, "x.png"), "--breif"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--brief");
    expect(r.stdout).toContain("--quiet");
  });
});

describe("doc save and close --brief", () => {
  const af = () => join(desktop, "proj", "test.af");

  function stubSave(): void {
    server.onScript("affinity-axi:doc-save", (script) => {
      const p = JSON.parse(/const outPath = ("(?:[^"\\]|\\.)*");/.exec(script)![1]!) as string;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "AFFINITY-BYTES");
      return JSON.stringify({ status: "saved", uuid: FIXTURE_UUID, path: p, dirty: false });
    });
  }

  it("doc save prints one saved: line and still writes the manifest", async () => {
    stubSave();
    const r = await runCommand(doc["doc save"], ["current", af(), "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^saved: bytes=14 sha256=[0-9a-f]{16} dirty=false path=.+test\.af\n$/);
    expect(r.stdout).toContain(`sha256=${sha16(af())}`);
    expect(r.stdout).not.toContain("help[");
    expect(existsSync(`${af()}.axi.json`)).toBe(true);
  });

  it("doc close --brief and --quiet print what it prints without the flag", async () => {
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: FIXTURE_UUID_2 }));
    const plain = await runCommand(doc["doc close"], ["01E35352"]);
    const brief = await runCommand(doc["doc close"], ["01E35352", "--brief"]);
    const quiet = await runCommand(doc["doc close"], ["01E35352", "--quiet"]);
    expect(plain.code).toBe(0);
    expect(brief.stdout).toBe(plain.stdout);
    expect(quiet.stdout).toBe(plain.stdout);
  });
});

describe("brief helpers", () => {
  it("briefLine keeps a space in the path and appends extras before it", () => {
    const p = join(work, "a b.txt");
    writeFileSync(p, "hi");
    const line = briefLine("saved", { path: p, bytes: 2 }, [["dirty", false]]);
    expect(line).toMatch(/^saved: bytes=2 sha256=[0-9a-f]{16} dirty=false path=.+a b\.txt$/);
  });

  it("digest16 of a missing file is empty", () => {
    expect(digest16(join(work, "nope"))).toBe("");
  });

  it("export and doc close list --brief and --quiet in their specs", () => {
    for (const spec of [exportCmd.spec, doc["doc close"].spec, doc["doc save"].spec]) {
      const names = spec.flags!.map((f) => f.name);
      expect(names).toEqual(expect.arrayContaining(["brief", "quiet"]));
    }
    void dispatch;
  });
});
