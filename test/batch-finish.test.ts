// `batch --export / --width / --discard / --on-exists` (workflow plan F4, F8, F9). Fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/batch.js";
import { readManifest } from "../src/affinity/manifest.js";
import { readOwned } from "../src/affinity/owned.js";
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
function png(w: number, h: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";
const POSTS = JSON.stringify([{ slug: "a" }, { slug: "b" }, { slug: "c" }]);
const batch = make(fakeConnect());

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-batch-fin-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
});
afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, body: string): string => {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
};
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const argsOf = (script: string): Record<string, unknown> => JSON.parse(/^const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;
const kind = (s: string): string =>
  s.includes("TEMPLATE_MARK") ? "T" : s.includes("doc-save") ? "S" : s.includes("area-export") ? "W" : s.includes("affinity-axi:export") ? "E" : s.includes("doc-close") ? "C" : "";
const order = (): string => scripts().map(kind).join("");
const batchArgs = (extra: string[], data = POSTS): string[] => [write("t.js", TEMPLATE), "--data", write("d.json", data), "--key", "slug", ...extra];
const out = (): string => join(desktop, "out");
const af = (): string => join(desktop, "af");

interface Opts { exportFails?: boolean; fail?: (key: string) => boolean; closeStatus?: (script: string) => string; natural?: [number, number] }

/** Template, app info, presets, doc-save/close, export (a PNG of the natural size, or of the requested width). */
function stub(o: Opts = {}): void {
  let n = 0;
  const [nw, nh] = o.natural ?? [100, 50];
  server.onScript("TEMPLATE_MARK", (script) => {
    const key = String(argsOf(script)["key"]);
    if (o.fail?.(key)) return `building...\nError: boom ${key}\n    at main:3:1`;
    return JSON.stringify({ uuid: uuidFor(++n), key });
  });
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG", "JPEG (High quality)", "PDF"]));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, "af");
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", (script) => JSON.stringify({ status: o.closeStatus?.(script) ?? "closed", uuid: "x" }));
  server.onScript("affinity-axi:export", (script) => {
    if (o.exportFails) return "exporting...\nError: no such preset\n    at main:1:1";
    const path = quoted(script, "outPath");
    writeFileSync(path, png(nw, nh));
    return JSON.stringify({ exported: path });
  });
  server.onScript("affinity-axi:area-export", (script) => {
    const path = quoted(script, "outPath");
    const size = JSON.parse(/const outSize = (.*);/.exec(script)![1]!) as { width: number; height: number } | null;
    writeFileSync(path, size ? png(size.width, size.height) : png(nw, nh));
    return JSON.stringify({ exported: path });
  });
}

describe("batch --export", () => {
  it("per record: script, save, export, close; PNG and .af per record; exported: n; manifests list the export", async () => {
    stub();
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--save-dir", af()]));
    expect(r.code).toBe(0);
    expect(order()).toBe("TSEC".repeat(3));
    expect(readdirSync(out()).sort()).toEqual(["a.png", "b.png", "c.png"]);
    expect(readdirSync(af()).filter((f) => f.endsWith(".af")).sort()).toEqual(["a.af", "b.af", "c.af"]);
    expect(r.stdout).toContain("exported: 3");
    expect(r.stdout).toContain("cleaned: 0");
    expect(r.stdout).toMatch(/saved .*a\.af, closed; exported a\.png/);
    const m = readManifest(join(af(), "a.af"));
    expect(m?.exports?.map((e) => e.path)).toEqual([join(out(), "a.png")]);
    expect(m?.exports?.[0]?.preset).toBe("PNG");
    expect(m?.exports?.[0]?.size).toBe("100x50");
  });

  it("--width re-exports at that width", async () => {
    stub();
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--width", "40"]));
    expect(r.code).toBe(0);
    expect(order()).toBe("TEWTEWTEW");
    expect(r.stdout).toContain("exported a.png (40x20)");
    expect(existsSync(join(out(), "c.png"))).toBe(true);
    // without --save-dir the documents stay open and are in the ledger
    expect(readOwned().has(uuidFor(1).toUpperCase())).toBe(true);
  });

  it("an export failure fails the row, leaves the document open and names it", async () => {
    stub({ exportFails: true });
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--save-dir", af()]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("export failed");
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1)}`);
    expect(order()).toBe("TSE");
    expect(readOwned().has(uuidFor(1).toUpperCase())).toBe(true);
  });
});

describe("batch --discard", () => {
  it("with --export: no .af, discarded: 3, no throwaway left, documents closed", async () => {
    stub({ closeStatus: () => "closed" });
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--discard"]));
    expect(r.code).toBe(0);
    expect(order()).toBe("TECTECTEC");
    expect(r.stdout).toContain("exported: 3");
    expect(r.stdout).toContain("discarded: 3");
    expect(r.stdout).toMatch(/\bok\b.*discarded/);
    expect(readdirSync(desktop).filter((f) => f.endsWith(".af"))).toEqual([]);
    expect(readOwned().size).toBe(0);
    // nothing stays open, so no render/doc save help for a discarded document
    expect(r.stdout).not.toContain("documents stay open");
    expect(r.stdout).not.toMatch(/affinity-axi render /);
    expect(r.stdout).toContain("home view: confirm no documents are left open");
  });

  it("a dirty document is saved to a throwaway copy, closed and the copy deleted", async () => {
    let closes = 0;
    stub({ closeStatus: () => (++closes % 2 === 1 ? "dirty" : "closed") });
    const r = await runCommand(batch, batchArgs(["--discard", "--limit", "1"]));
    expect(r.code).toBe(0);
    expect(order()).toBe("TCSC");
    expect(r.stdout).toContain("discarded: 1");
    expect(readdirSync(desktop).filter((f) => f.includes("discard"))).toEqual([]);
  });

  it("refuses a record whose document was open before the batch started", async () => {
    stub();
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: uuidFor(1), documents: [{ uuid: uuidFor(1), path: "", dirty: true }] }));
    const r = await runCommand(batch, batchArgs(["--discard", "--continue-on-error"], JSON.stringify([{ slug: "a" }])));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("the record's document was open before the batch started; not discarded");
    expect(order()).toBe("T");
  });

  it("without the new flags a successful run leaves the documents open and prints neither counter", async () => {
    stub();
    const r = await runCommand(batch, batchArgs([]));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("exported:");
    expect(r.stdout).not.toContain("discarded:");
  });
});

describe("batch --on-exists", () => {
  it("skip: a record whose .af and export exist is not run; the others are; no continue-on-error help", async () => {
    stub();
    mkdirSync(af(), { recursive: true });
    mkdirSync(out(), { recursive: true });
    writeFileSync(join(af(), "b.af"), "old");
    writeFileSync(join(out(), "b.png"), png(1, 1));
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--save-dir", af(), "--on-exists", "skip"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exists: kept (--on-exists skip)");
    expect(scripts().filter((s) => s.includes("TEMPLATE_MARK")).map((s) => argsOf(s)["key"])).toEqual(["a", "c"]);
    expect(r.stdout).not.toContain("--continue-on-error");
    expect(readFileSync(join(af(), "b.af"), "utf8")).toBe("old");
  });

  it("skip with only one of the files present runs the record", async () => {
    stub();
    mkdirSync(af(), { recursive: true });
    writeFileSync(join(af(), "a.af"), "old");
    const r = await runCommand(batch, batchArgs(["--export", "PNG", "--out-dir", out(), "--save-dir", af(), "--on-exists", "skip", "--limit", "1"]));
    expect(scripts().some((s) => s.includes("TEMPLATE_MARK"))).toBe(true);
    expect(r.stdout).toContain("--force");
  });

  it("overwrite behaves like --force", async () => {
    stub();
    mkdirSync(af(), { recursive: true });
    writeFileSync(join(af(), "a.af"), "someone else's file");
    const one = JSON.stringify([{ slug: "a" }]);
    const refused = await runCommand(batch, batchArgs(["--save-dir", af()], one));
    expect(refused.code).toBe(1);
    const r = await runCommand(batch, batchArgs(["--save-dir", af(), "--on-exists", "overwrite"], one));
    expect(r.code).toBe(0);
    expect(readFileSync(join(af(), "a.af"), "utf8")).toBe("af");
  });
});

describe("batch --discard after a failed record (F9)", () => {
  /** list-documents: call 1 is the start listing, call k the (k-1)th read after a record. */
  function stubListing(byCall: (call: number) => Array<{ uuid: string; path: string; dirty: boolean }>): void {
    let n = 0;
    server.onScript("affinity-axi:list-documents", () => {
      const documents = byCall(++n);
      return JSON.stringify({ current: documents[0]?.uuid ?? null, documents });
    });
  }
  const HALF = "bbbbbbbb-0000-4000-8000-000000000001";
  const fail = (key: string): boolean => key === "b";

  it("drops the unsaved document the failed record created and goes on", async () => {
    stub({ fail });
    stubListing((call) => (call === 2 ? [{ uuid: HALF, path: "", dirty: true }] : []));
    const r = await runCommand(batch, batchArgs(["--discard", "--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("discarded after failure: BBBBBBBB");
    expect(r.stdout).toContain("discarded: 3");
    expect(r.stdout).not.toContain("leftOpen:");
    expect(r.stdout).toMatch(/\n\s*b,failed,/);
    expect(scripts().filter((s) => s.includes("TEMPLATE_MARK"))).toHaveLength(3);
    expect(readOwned().has(HALF.toUpperCase())).toBe(false);
  });

  it("never drops a document of the start listing, or one that has a path", async () => {
    stub({ fail });
    const pre = "cccccccc-0000-4000-8000-000000000001";
    stubListing((call) => (call === 1 ? [{ uuid: pre, path: "", dirty: true }] : [{ uuid: pre, path: "", dirty: true }, { uuid: HALF, path: "/d/x.af", dirty: true }]));
    const r = await runCommand(batch, batchArgs(["--discard"], JSON.stringify([{ slug: "b" }])));
    expect(r.code).toBe(1);
    expect(scripts().some((s) => s.includes("doc-close"))).toBe(false);
    expect(r.stdout).toContain("left open: BBBBBBBB (unsaved changes in x.af)");
    expect(r.stdout).toContain("doc close --mine --discard");
  });

  it("a failed discard keeps the left-open note and the F8 line", async () => {
    stub({ fail, closeStatus: () => "still-open" });
    stubListing((call) => (call === 1 ? [] : [{ uuid: HALF, path: "", dirty: false }]));
    const r = await runCommand(batch, batchArgs(["--discard"], JSON.stringify([{ slug: "b" }])));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("left open: BBBBBBBB (unsaved)");
    expect(r.stdout).toContain("discard failed:");
    expect(r.stdout).toContain(`leftOpen: ${HALF}`);
    expect(r.stdout).toContain("doc close --mine --discard   # or drop every unsaved document");
    expect(readOwned().has(HALF.toUpperCase())).toBe(true);
  });

  it("without --discard the failed record's document stays open as before", async () => {
    stub({ fail });
    stubListing((call) => (call === 1 ? [] : [{ uuid: HALF, path: "", dirty: true }]));
    const r = await runCommand(batch, batchArgs([], JSON.stringify([{ slug: "b" }])));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("left open: BBBBBBBB (unsaved)");
    expect(r.stdout).toContain(`leftOpen: ${HALF}`);
    expect(scripts().some((s) => s.includes("doc-close"))).toBe(false);
  });

  it("a fatal record discards nothing", async () => {
    stub();
    stubListing((call) => (call === 1 ? [] : [{ uuid: HALF, path: "", dirty: true }]));
    // a call that throws (timeout, transport) leaves the state unknown
    const flaky = make(async (o) => {
      const c = await fakeConnect()(o);
      return { ...c, callTool: async (n, a, opts) => (String(a["script"]).includes("TEMPLATE_MARK") ? Promise.reject(new Error("socket hang up")) : c.callTool(n, a, opts)) };
    });
    const r = await runCommand(flaky, batchArgs(["--discard"], JSON.stringify([{ slug: "b" }])));
    expect(r.code).toBe(1);
    expect(scripts().some((s) => s.includes("doc-close"))).toBe(false);
  });
});

describe("batch finish flags: usage errors open no session", () => {
  const cases: Array<[string[], string]> = [
    [["--export", "PNG"], "--export needs --out-dir"],
    [["--width", "10"], "--width needs --export <preset>"],
    [["--discard", "--save-dir", "x"], "--discard and --save-dir cannot be combined"],
    [["--on-exists", "skip"], "--on-exists needs --save-dir or --export"],
    [["--save-dir", "x", "--on-exists", "skip", "--force"], "--force means --on-exists overwrite"],
    [["--export", "PNG", "--out-dir", "x", "--allow-generative"], "--export cannot label AI-generated files"],
    [["--on-exists", "maybe", "--save-dir", "x"], "valid values"],
  ];
  for (const [flags, text] of cases) {
    it(flags.join(" "), async () => {
      const r = await runCommand(batch, batchArgs(flags));
      expect(r.code).toBe(2);
      expect(r.stdout).toContain(text);
      expect(server.calls).toHaveLength(0);
    });
  }

  it("an export path whose type the preset cannot write, and a wrong --width, are refused offline", async () => {
    const r = await runCommand(batch, batchArgs(["--export", "PDF", "--out-dir", join(desktop, "o"), "--width", "10"]));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--width needs a PNG, JPEG or WebP export");
    expect(server.calls).toHaveLength(0);
  });

  it("an unknown preset is refused after connecting, before any script", async () => {
    stub();
    const r = await runCommand(batch, batchArgs(["--export", "PNG Nope", "--out-dir", out()]));
    expect(r.code).toBe(2);
    expect(scripts().some((s) => s.includes("TEMPLATE_MARK"))).toBe(false);
  });
});
