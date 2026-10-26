// F-b: fonts that are not installed. INSPECT lists them in `missingFonts`, `inspect`
// prints a warning line, `lint` gives one `font-missing` warning per font.

import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INSPECT } from "../src/affinity/inspect-script.js";
import { lintInventory, type LintOptions } from "../src/affinity/lint.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";
import { make as makeInspect } from "../src/commands/inspect.js";
import { make as makeLint } from "../src/commands/lint.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

type Box = [number, number, number, number];

const text = (path: string, font: string, extra: Partial<InventoryNode> = {}): InventoryNode => ({
  path, type: "ArtText", name: "", box: [100, 100 + Number(path.split("/").pop()) * 100, 400, 60], visible: true,
  artboard: "ig-square", text: "Hello", font, fill: "#111111", ...extra,
});

function inv(missing?: Inventory["missingFonts"]): Inventory {
  const board: Box = [0, 0, 1080, 1080];
  return {
    at: "2026-11-10T00:00:00.000Z",
    doc: { uuid: FIXTURE_UUID, title: "<Untitled>", path: "", units: "Pixel", width: 1080, height: 1080, dpi: 72 },
    artboards: [{ name: "ig-square", path: "0/0", box: board }],
    nodes: [
      { path: "0/0", type: "Artboard", name: "ig-square", box: board, visible: true, fill: "#FFFFFF" },
      text("0/0/0", "Fraunces-SemiBold 104"),
      text("0/0/1", "Fraunces-SemiBold 64"),
      text("0/0/2", "Helvetica 40"),
      text("0/0/3", "Lora-Regular 40"),
    ],
    counts: { nodes: 5, named: 1, text: 4, images: 0 },
    ...(missing ? { missingFonts: missing } : {}),
  };
}

const MISSING = [
  { font: "Fraunces-SemiBold", nodes: ["0/0/0", "0/0/1"] },
  { font: "Lora-Regular", nodes: ["0/0/3"] },
];

describe("INSPECT script: installed fonts and every glyph run", () => {
  const s = INSPECT("current");

  it("requires /fonts.js inside safe and walks every glyph run", () => {
    expect(s).toContain("require('/fonts.js')");
    expect(s).toContain("FontFamily.all");
    expect(s).toContain("getGlyphAttRunsFrom(0)");
    expect(s).toMatch(/installedSet = safe\(\(\) => \{[^]*require\('\/fonts\.js'\)/);
    expect(s).toContain("safe(() => runFonts(n), [])");
    expect(() => new vm.Script(`(function(){${s}\n})`)).not.toThrow();
  });

  function ps(name: string, size = 20): unknown {
    return { glyphAtts: { font: { postscriptName: name }, height: size, brushFill: null } };
  }
  function textNode(runs: unknown[]): Record<string, unknown> {
    return {
      [Symbol.toStringTag]: "ArtTextNode", children: [], userDescription: "", isVisible: true, text: "Hi",
      getSpreadVisibleBox: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      getExactSpreadVisibleBox: () => ({ x: 0, y: 0, width: 10, height: 10 }),
      story: { getGlyphAttRunsFrom: () => runs },
    };
  }
  function run(nodes: unknown[], fonts: "ok" | "throws" | "empty", installed = ["Helvetica"]): Inventory {
    const doc = { sessionUuid: "u", title: "t", path: "", units: "Pixel", widthPixels: 1080, heightPixels: 1080, dpi: 72, spreads: [{ children: nodes }] };
    let line = "";
    const famList = fonts === "empty" ? [] : [{ name: "Fam", fonts: installed.map((p) => ({ postscriptName: p })) }];
    const sandbox = {
      require: (id: string) => {
        if (id === "/fonts.js") {
          if (fonts === "throws") throw new Error("no fonts module");
          return { FontFamily: { all: famList } };
        }
        return { Document: { current: doc, all: [doc] } };
      },
      console: { log: (x: string) => { line = x; } },
    };
    vm.runInNewContext(`(function(){${s}\n})()`, sandbox);
    return JSON.parse(line) as Inventory;
  }

  it("lists a font that only a later run uses, with the paths", () => {
    const out = run([textNode([ps("Helvetica"), ps("Fraunces-SemiBold")]), textNode([ps("Fraunces-SemiBold")]), textNode([ps("Helvetica")])], "ok");
    expect(out.missingFonts).toEqual([{ font: "Fraunces-SemiBold", nodes: ["0/0", "0/1"] }]);
  });

  it("adds no field when every font is installed", () => {
    const out = run([textNode([ps("Helvetica")])], "ok");
    expect(out).not.toHaveProperty("missingFonts");
  });

  it("adds no field when the font listing fails or is empty", () => {
    expect(run([textNode([ps("Nope")])], "throws")).not.toHaveProperty("missingFonts");
    expect(run([textNode([ps("Nope")])], "empty")).not.toHaveProperty("missingFonts");
  });
});

describe("lintInventory font-missing", () => {
  const OPTS: LintOptions = { minFont: 20, strict: false };

  it("gives one warning per missing font, on the first node", () => {
    const f = lintInventory(inv(MISSING), OPTS).findings.filter((x) => x.check === "font-missing");
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ severity: "warning", path: "0/0/0" });
    expect(f[0]!.detail).toContain("Fraunces-SemiBold not installed; Affinity substitutes it in renders and exports (2 text nodes)");
    expect(f[1]).toMatchObject({ severity: "warning", path: "0/0/3" });
    expect(f[1]!.detail).toContain("(1 text node)");
  });

  it("is an error under --strict", () => {
    const f = lintInventory(inv(MISSING), { ...OPTS, strict: true }).findings.filter((x) => x.check === "font-missing");
    expect(f.map((x) => x.severity)).toEqual(["error", "error"]);
  });

  it("gives no finding without the field", () => {
    expect(lintInventory(inv(), OPTS).findings.filter((x) => x.check === "font-missing")).toEqual([]);
  });
});

describe("commands", () => {
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
  function stub(i: Inventory): void {
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    server.onScript("affinity-axi:inspect", JSON.stringify(i));
  }

  it("inspect prints one warning line per font after the node list", async () => {
    stub(inv(MISSING));
    const r = await runCommand(makeInspect(fakeConnect()), ["current"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("warning: font Fraunces-SemiBold is not installed; Affinity substitutes it (2 nodes: 0/0/0, 0/0/1)");
    expect(r.stdout).toContain("warning: font Lora-Regular is not installed; Affinity substitutes it (1 node: 0/0/3)");
    expect(r.stdout.indexOf("warning: font")).toBeGreaterThan(r.stdout.indexOf("nodes["));
    expect(r.stdout.indexOf("warning: font")).toBeLessThan(r.stdout.indexOf("note:"));
  });

  it("inspect prints no warning without the field", async () => {
    stub(inv());
    const r = await runCommand(makeInspect(fakeConnect()), ["current"]);
    expect(r.stdout).not.toContain("warning: font");
  });

  it("lint lists font-missing as warnings, exit 0; --strict makes them errors, exit 1", async () => {
    stub(inv(MISSING));
    const r = await runCommand(makeLint(fakeConnect()), ["current"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("font-missing");
    expect(r.stdout).toContain("0 errors, 2 warnings");
    const s = await runCommand(makeLint(fakeConnect()), ["current", "--strict"]);
    expect(s.code).toBe(1);
    expect(s.stdout).toContain("2 errors, 0 warnings");
  });

  it("lint without the field has no font-missing", async () => {
    stub(inv());
    const r = await runCommand(makeLint(fakeConnect()), ["current"]);
    expect(r.stdout).not.toContain("font-missing");
  });
});
