// INSPECT script: static safety checks, option plumbing, and a round trip
// through the fake MCP server.

import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { INSPECT } from "../src/affinity/inspect-script.js";
import type { Inventory } from "../src/affinity/manifest-types.js";
import { fakeConnect } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const FIXTURE: Inventory = {
  at: "2026-10-24T00:00:00.000Z",
  doc: { uuid: FIXTURE_UUID, title: "t", path: "", units: "Pixel", width: 800, height: 600, dpi: 72 },
  artboards: [{ name: "ig-square", path: "0/0", box: [0, 0, 800, 600] }],
  nodes: [
    { path: "0/0", type: "Artboard", name: "ig-square", box: [0, 0, 800, 600], visible: true, fill: "#F4F1EA" },
    { path: "0/0/0", type: "ArtText", name: "headline", box: [80, 125, 354, 45], visible: true, artboard: "ig-square", text: "Light measured", font: "Helvetica-Bold 48", fill: "#1F2A44" },
  ],
  counts: { nodes: 2, named: 2, text: 1, images: 0 },
};

describe("INSPECT script text", () => {
  const variants = [
    INSPECT("current"),
    INSPECT(FIXTURE_UUID),
    INSPECT(FIXTURE_UUID, { named: true, artboard: "ig-square", depth: 2 }),
  ];

  it("is a marked script that parses", () => {
    for (const s of variants) {
      expect(s.startsWith("/* affinity-axi:inspect */")).toBe(true);
      expect(() => new vm.Script(`(function(){${s}\n})`)).not.toThrow();
    }
  });

  it("contains no close, dialog or generative call", () => {
    for (const s of variants) {
      expect(s).not.toContain("close(");
      expect(scanForBlocking(s)).toEqual([]);
      expect(scanForAi(s)).toEqual([]);
      expect(s).not.toContain("/dialog.js");
    }
  });

  it("never touches selection or the current spread", () => {
    for (const s of variants) {
      expect(s).not.toMatch(/\.selection\b|currentSpread|setCurrent|executeCommand/);
    }
  });

  it("logs exactly one JSON line", () => {
    for (const s of variants) expect(s.match(/console\.log\(/g)).toHaveLength(1);
  });

  it("injects the document, filters and depth as JSON literals", () => {
    const s = INSPECT('we"ird', { named: true, artboard: 'a"b', depth: 3.9 });
    expect(s).toContain('const targetUuid = "we\\"ird";');
    expect(s).toContain("const onlyNamed = true;");
    expect(s).toContain('const onlyArtboard = "a\\"b";');
    expect(s).toContain("const maxDepth = 3;");
    const d = INSPECT(FIXTURE_UUID);
    expect(d).toContain("const onlyNamed = false;");
    expect(d).toContain('const onlyArtboard = "";');
    expect(d).toContain("const maxDepth = 0;");
  });

  it("textChars sets the text cap (default 40) and ignores bad values", () => {
    expect(INSPECT(FIXTURE_UUID)).toContain("const textChars = 40;");
    expect(INSPECT(FIXTURE_UUID)).toContain(".slice(0, textChars)");
    expect(INSPECT(FIXTURE_UUID, { textChars: 160 })).toContain("const textChars = 160;");
    expect(INSPECT(FIXTURE_UUID, { textChars: 99.9 })).toContain("const textChars = 99;");
    expect(INSPECT(FIXTURE_UUID, { textChars: 0 })).toContain("const textChars = 40;");
    expect(INSPECT(FIXTURE_UUID, { textChars: Number.NaN })).toContain("const textChars = 40;");
    expect(() => new vm.Script(`(function(){${INSPECT(FIXTURE_UUID, { textChars: 160 })}\n})`)).not.toThrow();
  });
});

describe("INSPECT through the fake server", () => {
  let server: FakeServer;
  const origUrl = process.env["AFFINITY_MCP_URL"];
  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
  });
  afterEach(async () => {
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
  });

  it("sends the script and the stubbed Inventory parses", async () => {
    server.onScript("affinity-axi:inspect", JSON.stringify(FIXTURE));
    const client = await fakeConnect()();
    const res = await client.callTool("execute_script", { script: INSPECT(FIXTURE_UUID) });
    client.close();
    const text = (res.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    const jsonLine = text.split("\n").find((l) => l.startsWith("{")) ?? text;
    const inv = JSON.parse(jsonLine) as Inventory;
    expect(inv.counts.nodes).toBe(2);
    expect(inv.nodes[1]).toMatchObject({ name: "headline", font: "Helvetica-Bold 48", fill: "#1F2A44" });
    expect(String(server.calls.at(-1)?.args["script"])).toContain(JSON.stringify(FIXTURE_UUID));
  });
});
