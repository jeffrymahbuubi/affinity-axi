// `webassets`: the apple-touch-icon is exported again opaque when its first export
// carries alpha (a transparent document), against the fake Affinity server; the
// generated script is also run against a stand-in SDK to check the order of the
// transparency switches.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXPORT_AREA } from "../src/affinity/export-area.js";
import { TOUCH_OPAQUE_EXPORT, make, pngHasAlpha } from "../src/commands/webassets.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const PRESETS = ["PNG", "SVG (for export)", "WebP (High Quality)", "JPEG (High quality)"];
const BOARDS = [
  { index: 0, name: "mark", w: 512, h: 512 },
  { index: 1, name: "og", w: 1200, h: 630 },
];
const OPAQUE_NOTE = "apple-touch-icon is exported opaque (iOS shows transparency as black); its ground is the mark artboard fill, else the document background";
const OLD_NOTE = "apple-touch-icon uses the artboard fill as its ground; give the mark artboard a fill";

let server: FakeServer;
let root: string;
let desktop: string;
let out: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const cmd = make(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-wt-"));
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

/** A PNG header: IHDR with the given colour type, then optional extra chunks, IDAT and IEND. */
function pngBuf(width: number, height: number, colourType = 2, extra: string[] = []): Buffer {
  const chunk = (type: string, len: number): Buffer => {
    const b = Buffer.alloc(12 + len);
    b.writeUInt32BE(len, 0);
    b.write(type, 4, "latin1");
    return b;
  };
  const ihdr = chunk("IHDR", 13);
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ihdr,
    ...extra.map((t) => chunk(t, 2)),
    chunk("IDAT", 0),
    chunk("IEND", 0),
  ]);
}

const field = (script: string, name: string): any => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

/**
 * Stubs the server. `touchAlpha`: the apple-touch export carries alpha (colour type 6)
 * unless it ran through the opaque wrapper; `stubborn` keeps alpha even then.
 */
function stub(touchAlpha: boolean, stubborn = false): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify(PRESETS));
  server.onScript("affinity-axi:app-info", JSON.stringify({ version: "3.3.1", desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "site.af", dirty: false, units: "Pixel", path: "" }] }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: BOARDS.map(({ index, name }) => ({ index, name })) }));
  server.onScript("affinity-axi:area-export", (script) => {
    const area = field(script, "area") as { index: number };
    const size = field(script, "outSize") as { width: number; height: number } | null;
    const path = field(script, "outPath") as string;
    const b = BOARDS[area.index]!;
    const dim = size ?? { width: b.w, height: b.h };
    const isTouch = path.endsWith("apple-touch-icon.png");
    const alpha = touchAlpha && isTouch && (stubborn || !script.includes("affinity-axi:touch-opaque"));
    writeFileSync(path, pngBuf(dim.width, dim.height, alpha ? 6 : 2));
    return "{}";
  });
}

function exportScripts(): string[] {
  return server.calls
    .map((c) => String((c.args as { script?: string }).script ?? ""))
    .filter((s) => s.includes("affinity-axi:area-export") && !s.includes("probe-"));
}

const touchScripts = (): string[] => exportScripts().filter((s) => s.includes("apple-touch-icon.png"));
const argv = (): string[] => ["current", "--out-dir", out, "--href", "https://x.test/"];

describe("webassets apple-touch ground", () => {
  it("exports the apple-touch-icon again with transparency off when the first export has alpha", async () => {
    stub(true);
    const r = await runCommand(cmd, argv());
    expect(r.code, r.stdout).toBe(0);
    const touch = touchScripts();
    expect(touch).toHaveLength(2);
    expect(touch[0]).not.toContain("documentproperties");
    expect(touch[1]).toContain("/documentproperties.js");
    expect(touch[1]).toContain("setTransparent(false)");
    expect(touch[1]).toContain("} finally {");
    for (const s of exportScripts().filter((x) => !x.includes("apple-touch-icon.png"))) expect(s).not.toContain("documentproperties");
    expect(pngHasAlpha(readFileSync(join(out, "apple-touch-icon.png")))).toBe(false);
    expect(r.stdout).toContain(`note: ${OPAQUE_NOTE}`);
    expect(r.stdout).not.toContain(OLD_NOTE);
  });

  it("exports once and keeps the old note when the first export has no alpha", async () => {
    stub(false);
    const r = await runCommand(cmd, argv());
    expect(r.code, r.stdout).toBe(0);
    expect(touchScripts()).toHaveLength(1);
    for (const s of exportScripts()) expect(s).not.toContain("documentproperties");
    expect(r.stdout).toContain(`note: ${OLD_NOTE}`);
    expect(r.stdout).not.toContain(OPAQUE_NOTE);
  });

  it("keeps the old note when the opaque re-export still has alpha", async () => {
    stub(true, true);
    const r = await runCommand(cmd, argv());
    expect(r.code, r.stdout).toBe(0);
    expect(touchScripts()).toHaveLength(2);
    expect(r.stdout).toContain(`note: ${OLD_NOTE}`);
  });

  it("does no apple-touch export or re-export with --no-favicons", async () => {
    stub(true);
    const r = await runCommand(cmd, ["current", "--out-dir", out, "--no-favicons", "--href", "https://x.test/"]);
    expect(r.code, r.stdout).toBe(0);
    expect(touchScripts()).toHaveLength(0);
    for (const s of exportScripts()) expect(s).not.toContain("documentproperties");
  });
});

describe("pngHasAlpha", () => {
  it("reads the IHDR colour type and tRNS chunks", () => {
    expect(pngHasAlpha(pngBuf(4, 4, 6))).toBe(true);
    expect(pngHasAlpha(pngBuf(4, 4, 4))).toBe(true);
    expect(pngHasAlpha(pngBuf(4, 4, 2))).toBe(false);
    expect(pngHasAlpha(pngBuf(4, 4, 3))).toBe(false);
    expect(pngHasAlpha(pngBuf(4, 4, 3, ["PLTE", "tRNS"]))).toBe(true);
    expect(pngHasAlpha(Buffer.from("not a png at all, just text........"))).toBe(false);
    expect(pngHasAlpha(Buffer.alloc(3))).toBe(false);
  });
});

/** Runs a generated script against a stand-in SDK and returns the ordered event log. */
function runScript(script: string, exportFails: boolean): { events: string[]; error: string | null } {
  const events: string[] = [];
  const doc = {
    sessionUuid: FIXTURE_UUID,
    spreads: [{ artboards: [{}] }],
    selection: [],
    export: () => {
      events.push("export");
      if (exportFails) throw new Error("export failed");
    },
    setDocumentProperties: (p: { isTransparent: boolean }) => events.push(`transparent=${p.isTransparent}`),
  };
  const modules: Record<string, unknown> = {
    "/document.js": {
      Document: { all: [doc] },
      FileExportOptions: { createWithPresetName: () => ({}) },
      FileExportArea: { createForArtboard: () => ({}) },
    },
    "/documentproperties.js": { DocumentProperties: { create: () => ({ isTransparent: true }) } },
  };
  const req = (name: string): unknown => modules[name];
  try {
    new Function("require", "console", script)(req, { log: () => undefined });
    return { events, error: null };
  } catch (e) {
    return { events, error: (e as Error).message };
  }
}

describe("TOUCH_OPAQUE_EXPORT", () => {
  const base = EXPORT_AREA(FIXTURE_UUID, "PNG", "/home/x/apple-touch-icon.png", { kind: "artboard", spread: 0, index: 0 }, { width: 180, height: 180 });

  it("switches transparency off before the export and on after it", () => {
    const r = runScript(TOUCH_OPAQUE_EXPORT(base), false);
    expect(r.error).toBeNull();
    expect(r.events).toEqual(["transparent=false", "export", "transparent=true"]);
  });

  it("switches transparency back on when the export fails", () => {
    const r = runScript(TOUCH_OPAQUE_EXPORT(base), true);
    expect(r.error).toBe("export failed");
    expect(r.events).toEqual(["transparent=false", "export", "transparent=true"]);
  });

  it("leaves the plain export script without any toggle", () => {
    expect(runScript(base, false).events).toEqual(["export"]);
  });

  it("keeps the fields the fake server and the output check read", () => {
    const s = TOUCH_OPAQUE_EXPORT(base);
    expect(field(s, "outPath")).toBe("/home/x/apple-touch-icon.png");
    expect(field(s, "outSize")).toEqual({ width: 180, height: 180 });
    expect(s).toContain("affinity-axi:area-export");
  });
});
