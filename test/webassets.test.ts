// `webassets`: pure planning (ICO, head.html, jobs) and the command against
// the fake Affinity server. The area-export stub writes a PNG header whose
// IHDR matches the requested size, so file sizes can be asserted.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type CommandModule, type Registry } from "../src/cli/router.js";
import { imageSize } from "../src/affinity/export-area.js";
import type { Manifest } from "../src/affinity/manifest-types.js";
import {
  checkHref, checkResponsive, headHtml, icoFromPngs, normaliseTheme, parseIco,
  planJobs, selectBoards, webManifestJson, type WebFlags,
} from "../src/affinity/webassets.js";
import { make } from "../src/commands/webassets.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const PRESETS = ["PNG", "SVG (for export)", "WebP (High Quality)", "JPEG (High quality)"];
const BOARDS = [
  { index: 0, name: "mark", w: 512, h: 512 },
  { index: 1, name: "og", w: 1200, h: 630 },
  { index: 2, name: "x-card", w: 1200, h: 600 },
  { index: 3, name: "hero", w: 1920, h: 1080 },
  { index: 4, name: "scratch", w: 800, h: 800 },
];

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
  root = mkdtempSync(join(tmpdir(), "axi-wa-"));
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

const scriptCalls = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const areaCalls = (): string[] => scriptCalls().filter((s) => s.includes("affinity-axi:area-export"));
const field = (script: string, name: string): any => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);

interface Stub {
  names?: string[];
  docPath?: string;
  /** Overrides the export reply for one file name. */
  exportReply?: (script: string) => string | undefined;
  presets?: string[];
}

function stub(o: Stub = {}): void {
  const names = o.names ?? BOARDS.map((b) => b.name);
  server.onScript("affinity-axi:list-presets", JSON.stringify(o.presets ?? PRESETS));
  server.onScript("affinity-axi:app-info", JSON.stringify({ version: "3.3.1", desktop }));
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "site.af", dirty: false, units: "Pixel", path: o.docPath ?? "" }] }),
  );
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: names.map((name, index) => ({ index, name })) }));
  server.onScript("affinity-axi:area-export", (script) => {
    const custom = o.exportReply?.(script);
    if (custom !== undefined) return custom;
    const area = field(script, "area") as { index: number };
    const size = field(script, "outSize") as { width: number; height: number } | null;
    const b = BOARDS[area.index]!;
    const dim = size ?? { width: b.w, height: b.h };
    writeFileSync(field(script, "outPath") as string, pngBuf(dim.width, dim.height));
    return "{}";
  });
}

const ARGS = (extra: string[] = []): string[] => ["current", "--out-dir", out, ...extra];
const dims = (file: string): string => {
  const d = imageSize(readFileSync(join(out, file)))!;
  return `${d.width}x${d.height}`;
};

const flags = (over: Partial<WebFlags> = {}): WebFlags => ({
  mark: "mark",
  og: "og",
  x: "x-card",
  explicit: { mark: false, og: false, x: false },
  responsive: [],
  noFavicons: false,
  spread: 0,
  ...over,
});

describe("webassets pure helpers", () => {
  it("icoFromPngs writes an ICONDIR whose entries point at the PNG bytes", () => {
    const pngs = [16, 32, 48].map((n) => pngBuf(n, n));
    const ico = icoFromPngs([16, 32, 48].map((size, i) => ({ size, png: pngs[i]! })));
    const entries = parseIco(ico);
    expect(entries.map((e) => e.edge)).toEqual([16, 32, 48]);
    entries.forEach((e, i) => {
      expect(e.bytes).toBe(33);
      expect(ico.subarray(e.offset, e.offset + e.bytes).equals(pngs[i]!)).toBe(true);
      expect(ico.readUInt16LE(6 + 16 * i + 4)).toBe(1);
      expect(ico.readUInt16LE(6 + 16 * i + 6)).toBe(32);
    });
    expect(entries[0]!.offset).toBe(6 + 16 * 3);
  });

  it("icoFromPngs writes 0 for edges of 256 and refuses an empty list", () => {
    const ico = icoFromPngs([{ size: 256, png: pngBuf(256, 256) }]);
    expect(ico.readUInt8(6)).toBe(0);
    expect(parseIco(ico)[0]!.edge).toBe(256);
    expect(() => icoFromPngs([])).toThrow();
    expect(() => parseIco(Buffer.from("nope"))).toThrow();
  });

  it("headHtml lists only the tags for files that exist, with the href prefix", () => {
    const w = (file: string, size = "") => ({ role: "x", file, size, bytes: 1 });
    const full = headHtml(
      [w("icon.svg"), w("favicon-32.png"), w("favicon-16.png"), w("apple-touch-icon.png"), w("site.webmanifest"), w("og.png", "1200x630"), w("x-card.png", "1200x600")],
      "https://example.com/static/",
    );
    expect(full.trimEnd().split("\n")).toHaveLength(10);
    expect(full).toContain('<link rel="icon" type="image/svg+xml" href="https://example.com/static/icon.svg">');
    expect(full).toContain('sizes="32x32"');
    expect(full).toContain('<meta property="og:image:width" content="1200">');
    expect(full).toContain('<meta property="og:image:height" content="630">');
    expect(full).toContain('<meta name="twitter:image" content="https://example.com/static/x-card.png">');
    const og = headHtml([w("og.png", "1200x630")], "/");
    expect(og).toContain('content="/og.png"');
    expect(og).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(og).not.toContain("rel=");
    expect(headHtml([], "/")).toBe("\n");
  });

  it("webManifestJson lists the 192 and 512 icons and the theme", () => {
    const w = (file: string) => ({ role: "icon", file, size: "", bytes: 1 });
    const m = JSON.parse(webManifestJson([w("icon-192.png"), w("icon-512.png")], "/s/", "#1f2a44", "Lumen"));
    expect(m.icons).toEqual([
      { src: "/s/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/s/icon-512.png", sizes: "512x512", type: "image/png" },
    ]);
    expect(m.theme_color).toBe("#1f2a44");
    expect(m.name).toBe("Lumen");
  });

  it("selectBoards matches case-sensitively first, then case-insensitively", () => {
    const boards = [{ index: 0, name: "Mark" }, { index: 1, name: "mark" }, { index: 2, name: "OG" }];
    expect(selectBoards(boards, flags({ noFavicons: false })).picks.find((p) => p.kind === "mark")!.board.index).toBe(1);
    expect(selectBoards(boards, flags({ mark: "og", og: "OG", x: "z" })).picks.map((p) => p.kind)).toEqual(["mark", "og"]);
    expect(() => selectBoards([{ index: 0, name: "Mark" }, { index: 1, name: "MARK" }], flags())).toThrow(/ambiguous/);
  });

  it("selectBoards skips a missing default role, errors on a missing explicit one and on a missing mark", () => {
    const boards = [{ index: 0, name: "mark" }];
    const r = selectBoards(boards, flags());
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0]).toContain("og");
    expect(() => selectBoards(boards, flags({ explicit: { mark: false, og: true, x: false }, og: "social" }))).toThrow(/social/);
    expect(() => selectBoards([{ index: 0, name: "og" }], flags())).toThrow(/favicon set/);
    expect(selectBoards([{ index: 0, name: "og" }], flags({ noFavicons: true })).picks).toHaveLength(1);
    expect(() => selectBoards(boards, flags({ responsive: ["hero"] }))).toThrow(/--responsive/);
  });

  it("planJobs gives each responsive artboard four jobs with @2x at twice the natural size", () => {
    const boards = [{ index: 0, name: "mark" }, { index: 3, name: "hero" }];
    const nat = new Map([[0, { width: 512, height: 512 }], [3, { width: 1920, height: 1080 }]]);
    const { jobs } = planJobs(boards, flags({ responsive: ["hero"] }), nat);
    expect(jobs.filter((j) => j.role === "icon" || j.role === "favicon" || j.role === "apple-touch-icon")).toHaveLength(7);
    const hero = jobs.filter((j) => j.role === "responsive");
    expect(hero.map((j) => j.file)).toEqual(["hero.png", "hero@2x.png", "hero.webp", "hero@2x.webp"]);
    expect(hero.map((j) => j.size)).toEqual([null, { width: 3840, height: 2160 }, null, { width: 3840, height: 2160 }]);
    expect(hero[2]!.preset).toBe("WebP (High Quality)");
    expect(jobs.find((j) => j.file === "icon.svg")!.preset).toBe("SVG (for export)");
  });

  it("offline checks reject bad responsive names, hrefs and themes", () => {
    expect(() => checkResponsive(["a", ""], [])).toThrow(/empty/);
    expect(() => checkResponsive(["a", "A"], [])).toThrow(/twice/);
    expect(() => checkResponsive(["og"], ["x"])).toThrow(/fixed output/);
    expect(() => checkResponsive(["hero"], ["Hero"])).toThrow(/role artboard/);
    expect(() => checkResponsive(["hero", "banner"], ["mark"])).not.toThrow();
    expect(() => checkHref('/a"b')).toThrow(/invalid --href/);
    expect(checkHref("/static")).toBe("/static/");
    expect(normaliseTheme("#ABC")).toBe("#aabbcc");
    expect(normaliseTheme("blue")).toBeNull();
  });
});

describe("webassets command", () => {
  it("writes the 17 files for mark, og, x-card and a responsive hero", async () => {
    stub();
    const r = await runCommand(cmd, ARGS(["--responsive", "hero", "--href", "https://example.com/", "--theme", "#1F2A44"]));
    expect(r.code, r.stdout).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toEqual(
      [
        "apple-touch-icon.png", "favicon-16.png", "favicon-32.png", "favicon-48.png", "favicon.ico", "head.html",
        "hero.png", "hero.webp", "hero@2x.png", "hero@2x.webp", "icon-192.png", "icon-512.png", "icon.svg",
        "og.png", "site.webmanifest", "webassets.json", "x-card.png",
      ].sort(),
    );
    expect(files).toHaveLength(17);
    expect(r.stdout).toContain("files[17]{role,file,size,bytes}:");
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain(`manifest: ${join(out, "webassets.json")}`);
    expect(r.stdout).toContain(`head: ${join(out, "head.html")}`);
    expect(r.stdout).toContain("  favicon,favicon-16.png,16x16,33");
    expect(r.stdout).toContain("  responsive,hero@2x.png,3840x2160,33");
    expect(r.stdout).toContain("note: apple-touch-icon uses the artboard fill");
    expect(r.stdout).toContain("help[");
    expect(r.stdout).not.toContain("skipped[");

    for (const [f, d] of [["favicon-16.png", "16x16"], ["favicon-32.png", "32x32"], ["favicon-48.png", "48x48"], ["apple-touch-icon.png", "180x180"], ["icon-192.png", "192x192"], ["icon-512.png", "512x512"], ["og.png", "1200x630"], ["x-card.png", "1200x600"], ["hero.png", "1920x1080"], ["hero@2x.png", "3840x2160"], ["hero@2x.webp", "3840x2160"]] as const) {
      expect(dims(f), f).toBe(d);
    }
    const jobs = areaCalls();
    expect(jobs.some((s) => field(s, "outPath").endsWith("icon.svg") && field(s, "presetName") === "SVG (for export)" && field(s, "outSize") === null)).toBe(true);
    expect(jobs.some((s) => field(s, "outPath").endsWith("hero.webp") && field(s, "presetName") === "WebP (High Quality)")).toBe(true);

    const ico = readFileSync(join(out, "favicon.ico"));
    const entries = parseIco(ico);
    expect(entries).toHaveLength(3);
    for (const e of entries) {
      expect(ico.subarray(e.offset, e.offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
      expect(imageSize(ico.subarray(e.offset, e.offset + e.bytes))).toEqual({ width: e.edge, height: e.edge });
    }

    const head = readFileSync(join(out, "head.html"), "utf8");
    expect(head.trimEnd().split("\n")).toHaveLength(10);
    expect(head).toContain('href="https://example.com/favicon-32.png"');
    expect(head).toContain('<link rel="manifest" href="https://example.com/site.webmanifest">');
    expect(head).toContain('<meta property="og:image" content="https://example.com/og.png">');
    expect(head).toContain('<meta name="twitter:image" content="https://example.com/x-card.png">');

    const wm = JSON.parse(readFileSync(join(out, "site.webmanifest"), "utf8"));
    expect(wm.theme_color).toBe("#1f2a44");
    expect(wm.icons[1].src).toBe("https://example.com/icon-512.png");
    expect(wm.name).toBe("site");

    const rec = JSON.parse(readFileSync(join(out, "webassets.json"), "utf8"));
    expect(rec.schema).toBe("affinity-axi/webassets/1");
    expect(rec.doc).toBe(FIXTURE_UUID);
    expect(rec.files).toHaveLength(16);
    expect(rec.files.find((f: { file: string }) => f.file === "og.png")).toMatchObject({ role: "og", size: "1200x630", bytes: 33, artboard: "og" });
    expect(rec.files.map((f: { role: string }) => f.role)).toContain("favicon");
  });

  it("removes its probe files and probes each artboard once", async () => {
    stub();
    await runCommand(cmd, ARGS(["--responsive", "hero"]));
    expect(readdirSync(out).some((f) => f.startsWith("probe-"))).toBe(false);
    const probes = areaCalls().filter((s) => /probe-\d+\.png/.test(field(s, "outPath")));
    expect(probes).toHaveLength(4);
  });

  it("a non-square mark is a usage error after the probe and writes nothing else", async () => {
    stub({ exportReply: (s) => (field(s, "area").index === 0 && field(s, "outSize") === null ? (writeFileSync(field(s, "outPath"), pngBuf(512, 500)), "{}") : undefined) });
    const r = await runCommand(cmd, ARGS());
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("not square");
    expect(readdirSync(out)).toEqual([]);
    expect(areaCalls().every((s) => /probe-\d+\.png/.test(field(s, "outPath")))).toBe(true);
  });

  it("a missing og lands in skipped; the rest is written and head.html has no og tags", async () => {
    stub({ names: ["mark", "x-card", "hero", "scratch"] });
    const r = await runCommand(cmd, ARGS(["--no-favicons"]));
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain("skipped[1]: og (no artboard named 'og')");
    expect(existsSync(join(out, "og.png"))).toBe(false);
    expect(existsSync(join(out, "x-card.png"))).toBe(true);
    expect(readFileSync(join(out, "head.html"), "utf8")).not.toContain("og:image");
    expect(JSON.parse(readFileSync(join(out, "webassets.json"), "utf8")).skipped).toHaveLength(1);
  });

  it("a missing mark without --no-favicons is a usage error before any export", async () => {
    stub({ names: ["og", "x-card"] });
    const r = await runCommand(cmd, ARGS());
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("favicon set");
    expect(r.stdout).toContain("--no-favicons");
    expect(areaCalls()).toHaveLength(0);
    expect(existsSync(out)).toBe(false);
  });

  it("--no-favicons with only an og artboard works", async () => {
    stub({ names: ["og"] });
    const r = await runCommand(cmd, ARGS(["--no-favicons"]));
    expect(r.code, r.stdout).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["head.html", "og.png", "webassets.json"]);
    expect(r.stdout).toContain("files[3]{role,file,size,bytes}:");
    expect(r.stdout).toContain("skipped[1]:");
  });

  it("notes an og artboard that is not 1200x630", async () => {
    stub({ exportReply: (s) => (field(s, "area").index === 1 ? (writeFileSync(field(s, "outPath"), pngBuf(1000, 500)), "{}") : undefined) });
    const r = await runCommand(cmd, ARGS());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("note: og artboard 'og' is 1000x500; Open Graph cards are 1200x630");
  });

  it("an --out-dir outside the Desktop fails after app-info with zero exports", async () => {
    stub();
    const r = await runCommand(cmd, ["current", "--out-dir", join(root, "elsewhere")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("outside the Desktop folder");
    expect(areaCalls()).toHaveLength(0);
    expect(existsSync(join(root, "elsewhere"))).toBe(false);
    expect(scriptCalls().some((s) => s.includes("affinity-axi:app-info"))).toBe(true);
  });

  it("an --out-dir in a hidden folder exits 2 before connecting", async () => {
    const r = await runCommand(cmd, ["current", "--out-dir", join(desktop, ".site")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--out-dir is inside a hidden folder or file ('.site')");
    expect(server.sessionsOpened()).toBe(0);
    expect(existsSync(join(desktop, ".site"))).toBe(false);
  });

  it("a missing preset is an error naming it, before any export", async () => {
    stub({ presets: ["PNG", "SVG (for export)"] });
    const r = await runCommand(cmd, ARGS(["--responsive", "hero"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("'WebP (High Quality)'");
    expect(areaCalls()).toHaveLength(0);
  });

  it("a failed export names the file and artboard", async () => {
    stub({ exportReply: (s) => (field(s, "outPath").endsWith("og.png") ? "ERROR: disk full\n" : undefined) });
    const r = await runCommand(cmd, ARGS());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export of og.png (artboard 'og') failed: ERROR: disk full");
  });

  it("an export that ignores the size argument fails instead of writing a wrong favicon", async () => {
    stub({ exportReply: (s) => (field(s, "outSize") !== null ? (writeFileSync(field(s, "outPath"), pngBuf(512, 512)), "{}") : undefined) });
    const r = await runCommand(cmd, ARGS());
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("favicon-16.png came out 512x512, expected 16x16");
  });

  it("usage errors and --help make zero connections", async () => {
    const cases: string[][] = [
      ["current"],
      ["current", "--out-dir", out, "--theme", "blue"],
      ["current", "--out-dir", out, "--responsive", "a,,b"],
      ["current", "--out-dir", out, "--responsive", "hero,Hero"],
      ["current", "--out-dir", out, "--responsive", "og"],
      ["current", "--out-dir", out, "--href", "a b"],
      ["current", "--out-dir", out, "--mark", "a", "--og", "A"],
      ["current", "--out-dir", out, "--spread", "x"],
    ];
    for (const argv of cases) {
      const r = await runCommand(cmd, argv);
      expect(r.code, argv.join(" ")).toBe(2);
    }
    expect(server.sessionsOpened()).toBe(0);

    const reg: Registry = { tool: "affinity-axi", root: cmd, rootHelp: () => "", commands: { webassets: cmd }, aliases: {} };
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = await dispatch(reg, ["webassets", "--help"]);
    } finally {
      process.stdout.write = write;
    }
    expect(code).toBe(0);
    const help = chunks.join("");
    expect(help).toContain("--out-dir");
    expect(help).toContain("--responsive");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("a saved document with a manifest gets exports entries", async () => {
    const af = join(desktop, "site.af");
    writeFileSync(af, "AF");
    const m: Manifest = {
      schema: "affinity-axi/manifest/1",
      file: "site.af",
      af: { sha256: "x", bytes: 2, savedAt: "t", tool: "affinity-axi" },
      madeBy: null,
      history: [],
      exports: [],
      ai: { generated: false, records: 0 },
      inventory: null,
      notes: [],
    } as unknown as Manifest;
    writeFileSync(af + ".axi.json", JSON.stringify(m));
    stub({ docPath: af });
    const r = await runCommand(cmd, ARGS(["--responsive", "hero"]));
    expect(r.code, r.stdout).toBe(0);
    const after = JSON.parse(readFileSync(af + ".axi.json", "utf8")) as Manifest;
    expect(after.exports).toHaveLength(13);
    expect(after.exports.find((e) => e.path === join(out, "og.png"))).toMatchObject({ preset: "PNG", area: "artboard:og", size: "1200x630", bytes: 33, aiGenerated: false });
    expect(after.exports.find((e) => e.path.endsWith("icon.svg"))!.preset).toBe("SVG (for export)");
  });

  it("an unsaved document leaves no manifest behind", async () => {
    stub();
    await runCommand(cmd, ARGS());
    expect(readdirSync(desktop)).toEqual(["site"]);
  });
});

describe("webassets alt text", () => {
  const node = (path: string, artboard: string, y: number, text: string) => ({ path, type: "ArtText", name: "", box: [0, y, 100, 40], visible: true, artboard, text });
  const INV = {
    at: "t",
    doc: { uuid: FIXTURE_UUID, title: "site.af", path: "", units: "Pixel", width: 4000, height: 1200, dpi: 72 },
    artboards: [],
    nodes: [node("0/1/0", "og", 440, 'light for "small" studios'), node("0/1/1", "og", 340, "lumen"), node("0/2/0", "x-card", 100, "Share <this>"), node("0/3/0", "hero", 100, "Hero banner")],
    counts: { nodes: 4, named: 0, text: 4, images: 0 },
  };
  const inspects = (): string[] => scriptCalls().filter((s) => s.includes("affinity-axi:inspect"));
  const recFiles = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(join(out, "webassets.json"), "utf8")).files;
  const head = (): string => readFileSync(join(out, "head.html"), "utf8");

  it("headHtml adds og:image:alt and twitter:image:alt, escaped, only when alt is set", () => {
    const w = (file: string, size: string, alt?: string) => ({ role: "x", file, size, bytes: 1, ...(alt !== undefined ? { alt } : {}) });
    const both = headHtml([w("og.png", "1200x630", 'a "b" <c> & d'), w("x-card.png", "1200x600", "card alt")], "/");
    expect(both).toContain('<meta property="og:image:alt" content="a &quot;b&quot; &lt;c> &amp; d">');
    expect(both).toContain('<meta name="twitter:image:alt" content="card alt">');
    expect(headHtml([w("og.png", "1200x630", "only og")], "/")).toContain('<meta name="twitter:image:alt" content="only og">');
    expect(headHtml([w("og.png", "1200x630", ""), w("x-card.png", "1200x600")], "/")).not.toContain(":alt");
  });

  it("asks for 160 text characters once and writes alt on raster files, webassets.json and head.html", async () => {
    stub();
    server.onScript("affinity-axi:inspect", JSON.stringify(INV));
    const r = await runCommand(cmd, ARGS(["--responsive", "hero"]));
    expect(r.code, r.stdout).toBe(0);
    expect(inspects()).toHaveLength(1);
    expect(inspects()[0]).toContain("const textChars = 160;");
    const by = (f: string) => recFiles().find((x) => x["file"] === f)!;
    expect(by("og.png")["alt"]).toBe('lumen. light for "small" studios');
    expect(by("x-card.png")["alt"]).toBe("Share <this>");
    for (const f of ["hero.png", "hero@2x.png", "hero.webp", "hero@2x.webp"]) expect(by(f)["alt"], f).toBe("Hero banner");
    expect(by("favicon-32.png")["alt"]).toBe("");
    expect(by("icon.svg")).not.toHaveProperty("alt");
    expect(by("favicon.ico")).not.toHaveProperty("alt");
    expect(head()).toContain('<meta property="og:image:alt" content="lumen. light for &quot;small&quot; studios">');
    expect(head()).toContain('<meta name="twitter:image:alt" content="Share &lt;this>">');
    expect(r.stdout).toContain("edit the alt text");
  });

  it("--no-alt makes no inspect call and writes no alt keys or meta lines", async () => {
    stub();
    server.onScript("affinity-axi:inspect", JSON.stringify(INV));
    const r = await runCommand(cmd, ARGS(["--no-alt", "--responsive", "hero"]));
    expect(r.code, r.stdout).toBe(0);
    expect(inspects()).toHaveLength(0);
    expect(recFiles().some((f) => "alt" in f)).toBe(false);
    expect(head()).not.toContain(":alt");
    expect(r.stdout).not.toContain("edit the alt text");
  });

  it("an artboard without text gets alt '' and no meta line", async () => {
    stub();
    server.onScript("affinity-axi:inspect", JSON.stringify({ ...INV, nodes: [node("0/3/0", "hero", 100, "Hero banner")] }));
    const r = await runCommand(cmd, ARGS());
    expect(r.code, r.stdout).toBe(0);
    expect(recFiles().find((f) => f["file"] === "og.png")).toMatchObject({ alt: "" });
    expect(head()).not.toContain(":alt");
  });

  it("an unreadable inventory is a note, not a failure", async () => {
    stub();
    server.onScript("affinity-axi:inspect", "ERROR: boom\n");
    const r = await runCommand(cmd, ARGS());
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain("note: alt text skipped");
    expect(recFiles().some((f) => "alt" in f)).toBe(false);
  });
});
