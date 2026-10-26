// `webassets`: the relative --href warning for social card URLs, run against
// the fake Affinity server.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/webassets.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const PRESETS = ["PNG", "SVG (for export)", "WebP (High Quality)", "JPEG (High quality)"];
const BOARDS = [
  { index: 0, name: "mark", w: 512, h: 512 },
  { index: 1, name: "og", w: 1200, h: 630 },
];

let server: FakeServer;
let root: string;
let desktop: string;
let out: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const cmd = make(fakeConnect());
const WARNING = "warning: --href is not an absolute URL";

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-wh-"));
  desktop = join(root, "Desktop");
  out = join(desktop, "site");
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

function pngBuf(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const field = (script: string, name: string): any => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

function stub(names: string[]): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify(PRESETS));
  server.onScript("affinity-axi:app-info", JSON.stringify({ version: "3.3.1", desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "site.af", dirty: false, units: "Pixel", path: "" }] }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: names.map((name, index) => ({ index, name })) }));
  server.onScript("affinity-axi:area-export", (script) => {
    const area = field(script, "area") as { index: number };
    const size = field(script, "outSize") as { width: number; height: number } | null;
    const b = BOARDS[area.index]!;
    const dim = size ?? { width: b.w, height: b.h };
    writeFileSync(field(script, "outPath") as string, pngBuf(dim.width, dim.height));
    return "{}";
  });
}

describe("webassets relative --href warning", () => {
  it("warns on the default href when an og card was written", async () => {
    stub(["mark", "og"]);
    const r = await runCommand(cmd, ["current", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(WARNING);
    expect(r.stdout).toContain("pass --href https://your-site/");
  });

  it("warns on a path-only href too", async () => {
    stub(["mark", "og"]);
    const r = await runCommand(cmd, ["current", "--out-dir", out, "--href", "/static"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(WARNING);
  });

  it("is silent with an absolute https href", async () => {
    stub(["mark", "og"]);
    const r = await runCommand(cmd, ["current", "--out-dir", out, "--href", "https://example.com/"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toContain("warning:");
  });

  it("is silent with an absolute http href", async () => {
    stub(["mark", "og"]);
    const r = await runCommand(cmd, ["current", "--out-dir", out, "--href", "http://example.com/"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toContain("warning:");
  });

  it("is silent on the default href when only a mark artboard exists (no card)", async () => {
    stub(["mark"]);
    const r = await runCommand(cmd, ["current", "--out-dir", out]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).not.toContain("warning:");
  });
});
