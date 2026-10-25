// `inspect`, in-process against the fake MCP server.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/inspect.js";
import { dispatch, type Registry } from "../src/cli/router.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let dir: string;
const origUrl = process.env["AFFINITY_MCP_URL"];
const inspect = make(fakeConnect());

const NODES: InventoryNode[] = [
  { path: "0/0", type: "Artboard", name: "ig-square", box: [0, 0, 1080, 1080], visible: true },
  { path: "0/0/1", type: "ArtText", name: "headline", box: [80, 120, 920, 96], visible: true, artboard: "ig-square", text: "Light measured", font: "Helvetica-Bold 72", fill: "#1F2A44" },
  { path: "0/0/2", type: "Rectangle", name: "cta", box: [80, 980, 320, 72], visible: true, artboard: "ig-square", fill: "#4C8DFF" },
  { path: "0/0/3", type: "Curve", name: "", box: [10, 10, 5, 5], visible: true, artboard: "ig-square" },
];

function inventory(nodes: InventoryNode[], total = nodes.length): Inventory {
  return {
    at: "2026-10-24T00:00:00.000Z",
    doc: { uuid: FIXTURE_UUID, title: "<Untitled>", path: "", units: "Pixel", width: 1080, height: 1350, dpi: 72 },
    artboards: [{ name: "ig-square", path: "0/0", box: [0, 0, 1080, 1080] }],
    nodes,
    counts: { nodes: total, named: 3, text: 1, images: 0 },
  };
}

function stub(inv: Inventory): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
  server.onScript("affinity-axi:inspect", JSON.stringify(inv));
}

const inspectScripts = () =>
  server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"])).filter((s) => s.startsWith("/* affinity-axi:inspect */"));

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  dir = mkdtempSync(join(tmpdir(), "axi-inspect-"));
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("inspect table", () => {
  it("prints doc, path, size, the nodes table, a note and help", async () => {
    stub(inventory(NODES));
    const r = await runCommand(inspect, ["current"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("path: (unsaved)");
    expect(r.stdout).toContain("size: 1080x1350 px @ 72 dpi");
    expect(r.stdout).toContain("nodes[4]{path,type,name,box,text,font,fill}:");
    expect(r.stdout).toContain("  0/0,Artboard,ig-square,0 0 1080 1080,,,");
    expect(r.stdout).toContain("  0/0/1,ArtText,headline,80 120 920 96,Light measured,Helvetica-Bold 72,#1F2A44");
    expect(r.stdout).toContain("  0/0/2,Rectangle,cta,80 980 320 72,,,#4C8DFF");
    expect(r.stdout).toContain("note: 4 of 4 nodes");
    expect(r.stdout).toMatch(/help\[2\]:/);
    expect(r.stdout).toContain(`inspect ${FIXTURE_UUID.slice(0, 8)} --out <json>`);
  });

  it("resolves the doc reference and sends INSPECT with the session uuid", async () => {
    stub(inventory(NODES));
    await runCommand(inspect, [FIXTURE_UUID.slice(0, 8)]);
    expect(inspectScripts()).toHaveLength(1);
    expect(inspectScripts()[0]).toContain(JSON.stringify(FIXTURE_UUID));
  });

  it("passes --named, --artboard and --depth into the script", async () => {
    stub(inventory(NODES.slice(0, 3)));
    await runCommand(inspect, ["current", "--named", "--artboard", "ig-square", "--depth", "2"]);
    const s = inspectScripts()[0]!;
    expect(s).toContain("const onlyNamed = true;");
    expect(s).toContain('const onlyArtboard = "ig-square";');
    expect(s).toContain("const maxDepth = 2;");
  });

  it("--named reports N of M nodes using counts.nodes", async () => {
    stub(inventory(NODES.slice(0, 3), 12));
    const r = await runCommand(inspect, ["current", "--named"]);
    expect(r.stdout).toContain("nodes[3]{");
    expect(r.stdout).toContain("note: 3 of 12 nodes (named only)");
  });

  it("caps rows at 60 and names the exact --full command", async () => {
    const many: InventoryNode[] = Array.from({ length: 75 }, (_, i) => ({
      path: `0/${i}`, type: "Rectangle", name: "", box: [0, 0, 1, 1] as [number, number, number, number], visible: true,
    }));
    stub(inventory(many));
    const r = await runCommand(inspect, ["current"]);
    expect(r.stdout).toContain("nodes[60]{");
    expect(r.stdout).toContain("note: 60 of 75 nodes (first 60); affinity-axi inspect 70E876CB --full");
    const all = await runCommand(inspect, ["current", "--full"]);
    expect(all.stdout).toContain("nodes[75]{");
    expect(all.stdout).toContain("note: 75 of 75 nodes");
  });

  it("quotes text that contains commas", async () => {
    const n: InventoryNode = { path: "0/0", type: "ArtText", name: "", box: [0, 0, 1, 1], visible: true, text: "a, b", font: "Helvetica 12" };
    stub(inventory([n]));
    const r = await runCommand(inspect, ["current"]);
    expect(r.stdout).toContain('"a, b"');
  });

  it("an unknown artboard exits 2 and lists the artboards", async () => {
    stub(inventory([]));
    const r = await runCommand(inspect, ["current", "--artboard", "nope"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("no artboard named 'nope'");
    expect(r.stdout).toContain("ig-square");
  });

  it("a bad --depth exits 2 before connecting", async () => {
    const r = await runCommand(inspect, ["current", "--depth", "0"]);
    expect(r.code).toBe(2);
    expect(server.calls).toHaveLength(0);
  });
});

describe("inspect --out", () => {
  it("writes the JSON, prints the path and counts, and no rows", async () => {
    stub(inventory(NODES));
    const out = join(dir, "sub", "inv.json");
    const r = await runCommand(inspect, ["current", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`inspect: ${out}`);
    expect(r.stdout).toContain("nodes: 4");
    expect(r.stdout).toContain("named: 3");
    expect(r.stdout).not.toContain("nodes[");
    expect(existsSync(out)).toBe(true);
    const saved = JSON.parse(readFileSync(out, "utf8")) as Inventory;
    expect(saved.nodes).toHaveLength(4);
    expect(saved.counts.text).toBe(1);
  });
});

describe("inspect refs and help", () => {
  it("an ambiguous doc prefix exits 2", async () => {
    const a = FIXTURE_UUID.slice(0, 8);
    const docs = [
      ...FIXTURE_DOCS,
      { uuid: a + "-AAAA-4000-8000-000000000001", title: "x", dirty: false, units: "Pixel", path: "" },
    ];
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: docs }));
    const r = await runCommand(inspect, [a]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("ambiguous");
    expect(inspectScripts()).toHaveLength(0);
  });

  it("an unknown doc exits 2", async () => {
    stub(inventory(NODES));
    const r = await runCommand(inspect, ["FFFFFFFF"]);
    expect(r.code).toBe(2);
  });

  it("--help makes zero fake calls", async () => {
    const registry: Registry = {
      tool: "affinity-axi",
      root: inspect,
      rootHelp: () => "",
      commands: { inspect },
      aliases: {},
    };
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = await dispatch(registry, ["inspect", "--help"]);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    expect(chunks.join("")).toContain("--named");
    expect(server.calls).toHaveLength(0);
  });
});
