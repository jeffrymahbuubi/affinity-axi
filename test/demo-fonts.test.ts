// The demo fonts: every gallery file, the starter kit and the carousel default use fonts that
// ship with both Windows and macOS, and a failed `templates new` that leaves a document open
// says how to keep and close it. The old family name is built from two pieces so this file
// passes its own scan.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/templates.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { slash } from "./helpers/paths.js";

const OLD_FONT = "Helve" + "tica";
const toolDir = fileURLToPath(new URL("..", import.meta.url));
const bin = join(toolDir, "bin", "affinity-axi.js");
const BRAND_FILE = join(toolDir, "examples", "_brand", "brand.json");
const BINARY = new Set([".png", ".jpg", ".jpeg", ".webp", ".af", ".pdf"]);

function walk(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, skip));
    else out.push(p);
  }
  return out;
}

describe("the old font name is gone from the shipped text", () => {
  it("is in no gallery text file (the _help and _run folders are not checked)", () => {
    const files = walk(join(toolDir, "examples"), (n) => n === "_help" || n === "_run").filter((f) => !BINARY.has(extname(f).toLowerCase()));
    expect(files.length).toBeGreaterThan(50);
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(OLD_FONT));
    expect(hits).toEqual([]);
  });

  it("is in no source file", () => {
    const files = walk(join(toolDir, "src"), () => false).filter((f) => f.endsWith(".ts"));
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(OLD_FONT));
    expect(hits).toEqual([]);
  });
});

describe("brand init", () => {
  it("writes a kit with the fonts both systems ship", () => {
    const root = mkdtempSync(join(tmpdir(), "axi-fonts-"));
    try {
      const r = spawnSync("node", [bin, "brand", "init", "acme"], { cwd: root, encoding: "utf8", env: { ...process.env, AFFINITY_MCP_URL: "http://127.0.0.1:1" } });
      expect(r.status).toBe(0);
      const kit = JSON.parse(readFileSync(join(root, "brands", "acme.brand.json"), "utf8")) as { fonts: Record<string, string> };
      expect(kit.fonts).toEqual({ headline: "Arial-BoldMT", body: "ArialMT" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("templates new, a build that fails and leaves the document open", () => {
  let server: FakeServer;
  let root: string;
  let desktop: string;
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const UUID = "abcdef12-0000-4000-8000-0000000000a1";

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-fonts-tpl-"));
    desktop = join(root, "Desktop");
    mkdirSync(desktop);
  });

  afterEach(async () => {
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
    else process.env["AFFINITY_AXI_BRAND"] = origBrand;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("suggests the two commands that keep and close it, and sends neither", async () => {
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:template ", JSON.stringify({ uuid: UUID, error: "axiFont: no font X" }));
    const out = join(desktop, "x.af");
    const r = await runCommand(make(fakeConnect())["templates new"], ["ig-post", "--out", out, "--brand", BRAND_FILE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("axiFont: no font X");
    expect(r.stdout).toContain("is unsaved and left open)");
    expect(r.stdout).toContain(`doc save ABCDEF12 ${slash(join(desktop, "x-failed.af"))}`);
    expect(r.stdout).toContain("doc close ABCDEF12");
    expect(r.stdout).toContain("brand check");
    const sent = server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
    expect(sent.some((s) => /affinity-axi:doc-(save|close)/.test(s))).toBe(false);
  });
});
