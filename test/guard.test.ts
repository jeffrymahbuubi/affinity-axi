// Guard: the safe generative patch helper counts as a generative identifier.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_IDENTIFIERS, scanForAi } from "../src/affinity/guard.js";
import { PATCH_SOURCE } from "../src/affinity/helpers-patch.js";
import { readProvenance } from "../src/affinity/provenance.js";
import { make as makeRun } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

describe("guard: axiGenerativePatch", () => {
  it("is a generative identifier", () => {
    expect(AI_IDENTIFIERS).toContain("axiGenerativePatch");
  });

  it("hits a call with its 1-based line", () => {
    const src = "const a = 1;\naxiGenerativePatch(doc, n, { x: 1, y: 1, w: 9, h: 9 }, 'a fern');\n";
    expect(scanForAi(src)).toEqual([{ identifier: "axiGenerativePatch", line: 2 }]);
  });

  it("hits a mention in a string or comment, like every other identifier", () => {
    expect(scanForAi("// axiGenerativePatch\n")).toEqual([{ identifier: "axiGenerativePatch", line: 1 }]);
    expect(scanForAi("const s = 'axiGenerativePatch';\n")).toEqual([{ identifier: "axiGenerativePatch", line: 1 }]);
  });

  it("does not hit a function declaration or a longer identifier", () => {
    expect(scanForAi("function axiGenerativePatch(doc) {}\n")).toEqual([]);
    expect(scanForAi("axiGenerativePatchX(); myaxiGenerativePatch(); axiGenerativePatch_2();")).toEqual([]);
  });

  it("keeps the helper block itself free of hits", () => {
    expect(scanForAi(PATCH_SOURCE)).toEqual([]);
  });
});

describe("run: axiGenerativePatch", () => {
  let server: FakeServer;
  let root: string;
  let work: string;
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const script = "const doc = Document.current;\naxiGenerativePatch(doc, null, { x: 1, y: 1, w: 9, h: 9 }, 'a fern');\n";

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    root = mkdtempSync(join(tmpdir(), "axi-guard-"));
    work = join(root, "work");
    mkdirSync(work);
    process.chdir(work);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const run = () => makeRun(fakeConnect());

  it("is refused without --allow-generative, before any connection", async () => {
    const file = join(work, "patch.js");
    writeFileSync(file, script);
    const r = await runCommand(run(), [file, "--with-helpers"]);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith("error: script references SDK AI API axiGenerativePatch at line 2")).toBe(true);
    expect(r.stdout).toContain(`run ${file} --allow-generative`);
    expect(server.sessionsOpened()).toBe(0);
    expect(existsSync(join(work, ".affinity-axi", "provenance.jsonl"))).toBe(false);
  });

  it("runs with --allow-generative and logs the identifier as provenance", async () => {
    server.onScript("axiGenerativePatch", `${FIXTURE_UUID}\n`);
    const file = join(work, "patch.js");
    writeFileSync(file, script);
    const r = await runCommand(run(), [file, "--with-helpers", "--allow-generative"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: ok");
    expect(readProvenance()[0]).toMatchObject({
      identifiers: [{ identifier: "axiGenerativePatch", line: 2 }],
      outcome: "ok",
    });
  });
});
