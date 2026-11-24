// `run --save / --export / --close / --discard`: the finish steps after a script (plan F3, F8, F9).
// Fake MCP server; the "Desktop" is a temp folder returned by the app-info stub.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRun } from "../src/commands/run.js";
import { readManifest } from "../src/affinity/manifest.js";
import { readOwned } from "../src/affinity/owned.js";
import { imageSize } from "../src/affinity/export-area.js";
import { TransportError } from "../src/mcp/client.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_PRESETS } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

const OLD = { uuid: "11111111-2222-3333-4444-555555555555", title: "kept", dirty: true, units: "px", path: "" };
const N1 = { uuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", title: "Untitled", dirty: true, units: "px", path: "" };
const N2 = { uuid: "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE", title: "Untitled 2", dirty: true, units: "px", path: "" };
const LOADED = { uuid: "CCCCCCCC-BBBB-CCCC-DDDD-EEEEEEEEEEEE", title: "loaded", dirty: false, units: "px", path: "/home/x/loaded.af" };

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-runfinish-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  process.chdir(root);
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const count = (mark: string): number => scripts().filter((s) => s.includes(mark)).length;
const outPathOf = (s: string): string => JSON.parse(/const outPath = (".*");/.exec(s)![1]!) as string;
const exec = (args: string[]) => runCommand(makeRun(fakeConnect()), args);

function listings(before: unknown[], after: unknown[]): void {
  let n = 0;
  server.onScript("affinity-axi:list-documents", () => JSON.stringify({ current: null, documents: ++n === 1 ? before : after }));
}

function script(body: string): string {
  const p = join(root, "s.js");
  writeFileSync(p, body);
  return p;
}

/** A script whose (stubbed) output reports `uuid` on its last line; the fake server does not execute scripts. */
function reporting(uuid: string): string {
  const mark = `REPORT_${uuid.slice(0, 8)}`;
  server.onScript(mark, `working\n{"uuid":"${uuid}"}\n`);
  return script(`/* ${mark} */\n`);
}

/** A script that throws. */
function failing(): string {
  server.onScript("FAILING_SCRIPT", "TypeError: boom\n    at s.js:1\n");
  return script("/* FAILING_SCRIPT */\n");
}

function stubSave(): void {
  server.onScript("affinity-axi:doc-save", (s) => {
    writeFileSync(outPathOf(s), "af");
    return JSON.stringify({ status: "saved", uuid: "x", path: outPathOf(s), dirty: false });
  });
}

/** doc-close: `dirty` reports an unsaved document until a save happened; then closed. */
function stubClose(dirty: boolean): void {
  let saved = false;
  server.onScript("affinity-axi:doc-save", (s) => {
    saved = true;
    writeFileSync(outPathOf(s), "af");
    return JSON.stringify({ status: "saved", uuid: "x", path: outPathOf(s), dirty: false });
  });
  server.onScript("affinity-axi:doc-close", () => JSON.stringify({ status: dirty && !saved ? "dirty" : "closed", uuid: "x" }));
}

function pngBuf(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([1, 2, 3, 4])), chunk("IEND", Buffer.alloc(0))]);
}

function stubExport(): void {
  server.onScript("affinity-axi:export", (s) => {
    writeFileSync(outPathOf(s), pngBuf(100, 50));
    return JSON.stringify({ exported: "x" });
  });
  server.onScript("affinity-axi:area-export", (s) => {
    const size = JSON.parse(/const outSize = (.*);/.exec(s)![1]!) as { width: number; height: number };
    writeFileSync(outPathOf(s), pngBuf(size.width, size.height));
    return JSON.stringify({ exported: "x" });
  });
}

describe("run finish: ok runs", () => {
  it("save, export at a width, close: both files, manifest with the run and the export, order save-close", async () => {
    listings([], [N1]);
    stubSave();
    stubExport();
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: N1.uuid }));
    const af = join(desktop, "x.af");
    const png = join(desktop, "x.png");
    const r = await exec([reporting(N1.uuid), "--save", af, "--export", "PNG", "--out", png, "--width", "50", "--close"]);
    expect(r.code).toBe(0);
    expect(existsSync(af) && existsSync(png)).toBe(true);
    expect(imageSize(readFileSync(png))).toEqual({ width: 50, height: 25 });
    expect(r.stdout).toContain(`doc: ${N1.uuid}`);
    expect(r.stdout).toContain("manifest: x.af.axi.json");
    expect(r.stdout).toContain("size: 50x25");
    expect(r.stdout).toContain("closed: true");
    expect(r.stdout).toContain(`affinity-axi doc open`);
    const order = ["affinity-axi:doc-save", "affinity-axi:export", "affinity-axi:doc-close"].map((m) => scripts().findIndex((s) => s.includes(m)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const m = readManifest(af)!;
    expect(m.history?.some((h) => h.kind === "run")).toBe(true);
    expect(m.exports?.map((e) => e.preset)).toEqual(["PNG"]);
    expect(readOwned().has(N1.uuid)).toBe(false);
  });

  it("save without close prints the close and export help", async () => {
    listings([], [N1]);
    stubSave();
    const r = await exec([reporting(N1.uuid), "--save", join(desktop, "k.af")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity-axi doc close AAAAAAAA");
    expect(r.stdout).toContain("affinity-axi export AAAAAAAA PNG <path-under-Desktop>");
    expect(readOwned().has(N1.uuid)).toBe(true);
  });

  it("close of a clean document works", async () => {
    listings([], [{ ...N1, dirty: false }]);
    stubClose(false);
    expect((await exec([reporting(N1.uuid), "--close"])).stdout).toContain("closed: true");
  });

  it("close of a dirty document fails at close with exit 1", async () => {
    listings([], [N1]);
    stubClose(true);
    const r = await exec([reporting(N1.uuid), "--close"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`finish: failed at close: document ${N1.uuid} has unsaved changes; add --save <path>.af, or use --discard`);
  });

  it("export alone keeps the document open and uses the default help", async () => {
    listings([], [N1]);
    stubExport();
    const png = join(desktop, "e.png");
    const r = await exec([reporting(N1.uuid), "--export", "PNG", "--out", png]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`exported: ${png.replace(/\\/g, "/")}`);
    expect(r.stdout).toContain("bytes:");
    expect(count("affinity-axi:area-export")).toBe(0);
    expect(r.stdout).toContain("affinity-axi render AAAAAAAA");
  });

  it("discard drops the document the run opened and leaves no throwaway file", async () => {
    listings([], [N1]);
    stubClose(true);
    const r = await exec([reporting(N1.uuid), "--discard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("discarded: true");
    expect(readdirSync(desktop)).toEqual([]);
    expect(readOwned().has(N1.uuid)).toBe(false);
  });

  it("discard refuses a document that was open before the run, and sends no save or close", async () => {
    listings([OLD], [OLD]);
    stubClose(true);
    const r = await exec([reporting(OLD.uuid), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("finish: failed at discard: document 11111111 was open before this run; --discard only drops documents the run created");
    expect(count("affinity-axi:doc-save")).toBe(0);
    expect(count("affinity-axi:doc-close")).toBe(0);
  });

  it("the target comes from the single opened document when the output names none", async () => {
    listings([], [N1]);
    stubSave();
    const r = await exec([script("console.log('hi');\n"), "--save", join(desktop, "one.af")]);
    expect(r.stdout).toContain(`doc: ${N1.uuid}`);
  });

  it("two opened documents and none named: the step fails", async () => {
    listings([], [N1, N2]);
    stubSave();
    const r2 = await exec([script("console.log('hi');\n"), "--save", join(desktop, "two.af")]);
    expect(r2.code).toBe(1);
    expect(r2.stdout).toContain("finish: failed at save: cannot tell which document to finish: the output names no uuid and the run opened 2 documents");
  });

  it("an unmanaged existing .af refuses before the script; --force replaces it", async () => {
    const af = join(desktop, "old.af");
    writeFileSync(af, "hand made");
    listings([], [N1]);
    stubSave();
    await expect(exec([reporting(N1.uuid), "--save", af])).resolves.toMatchObject({ code: 1 });
    expect(count("REPORT_")).toBe(0);
    listings([], [N1]);
    const r = await exec([reporting(N1.uuid), "--save", af, "--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(forced)");
    expect(readFileSync(af, "utf8")).toBe("af");
  });

  it("a path outside the Desktop refuses before the script runs", async () => {
    const r = await exec([reporting(N1.uuid), "--save", join(root, "elsewhere.af")]);
    expect(r.code).toBe(2);
    expect(count("REPORT_")).toBe(0);
    expect(count("doc-save")).toBe(0);
  });

  it("an export failure stops the sequence: no close, exit 1", async () => {
    listings([], [N1]);
    stubSave();
    server.onScript("affinity-axi:export", "ERROR: could not write file\n");
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
    const r = await exec([reporting(N1.uuid), "--save", join(desktop, "s.af"), "--export", "PNG", "--out", join(desktop, "s.png"), "--close"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("saved:");
    expect(r.stdout).toContain("finish: failed at export:");
    expect(count("affinity-axi:doc-close")).toBe(0);
  });
});

describe("run finish: failed scripts", () => {
  it("without --discard: finish skipped, no save, export or close, the old help lines plus the discard line", async () => {
    listings([], [N1]);
    stubSave();
    const r = await exec([failing(), "--save", join(desktop, "f.af")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("finish: skipped (the run did not succeed)");
    expect(count("affinity-axi:doc-save") + count("affinity-axi:doc-close") + count("affinity-axi:export")).toBe(0);
    expect(r.stdout).toContain("leftOpen[1]{uuid,title,dirty}:");
    expect(r.stdout).toContain("affinity-axi doc close AAAAAAAA --discard   # or drop the half-built document without saving");
  });

  it("the several-documents discard line", async () => {
    listings([], [N1, N2]);
    const r = await exec([failing()]);
    expect(r.stdout).toContain("affinity-axi doc close --mine --discard   # or drop every unsaved document affinity-axi created from this folder");
    expect(r.stdout).not.toContain("finish:");
  });

  it("with --discard: the created unsaved documents are dropped and named; others never addressed", async () => {
    listings([OLD], [OLD, N1, N2, LOADED]);
    stubClose(true);
    const r = await exec([failing(), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("finish: skipped (the run did not succeed)");
    expect(r.stdout).toContain("discarded: AAAAAAAA BBBBBBBB   # created by the failed run");
    const sent = scripts().filter((s) => s.includes("affinity-axi:doc-"));
    expect(sent.some((s) => s.includes(OLD.uuid) || s.includes(LOADED.uuid))).toBe(false);
    expect(r.stdout).toContain("leftOpen[1]{uuid,title,dirty}:");
    expect(r.stdout).toContain("CCCCCCCC-BBBB-CCCC-DDDD-EEEEEEEEEEEE,loaded,false");
    expect(r.stdout).not.toContain("AAAAAAAA-BBBB");
    expect(r.stdout).not.toContain("--mine --discard");
    expect(readOwned().size).toBe(0);
    expect(readdirSync(desktop)).toEqual([]);
  });

  it("with --discard and nothing created: discarded none", async () => {
    listings([OLD], [OLD]);
    const r = await exec([failing(), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("discarded: none");
  });

  it("a discard that fails is named and the document stays in leftOpen and the help", async () => {
    listings([], [N1]);
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: N1.uuid }));
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "saved", uuid: N1.uuid, path: "x", dirty: true }));
    const r = await exec([failing(), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("finish: failed at discard: AAAAAAAA: could not save a throwaway copy");
    expect(r.stdout).toContain("leftOpen[1]{uuid,title,dirty}:");
    expect(r.stdout).toContain("affinity-axi doc close AAAAAAAA --discard");
    expect(readOwned().has(N1.uuid)).toBe(true);
  });

  it("a timed-out call with --discard sends no save or close script", async () => {
    listings([], [N1]);
    const timingOut: ConnectFn = async (o) => {
      const c = await fakeConnect()(o);
      const orig = c.callTool.bind(c);
      c.callTool = (n, a, opts) => (String(a["script"] ?? "").includes("SLOW_SCRIPT") ? Promise.reject(new TransportError("request timed out")) : orig(n, a, opts));
      return c;
    };
    const r = await runCommand(makeRun(timingOut), [script("/* SLOW_SCRIPT */\n"), "--discard"]);
    expect(r.code).toBe(1);
    expect(count("affinity-axi:doc-save") + count("affinity-axi:doc-close")).toBe(0);
  });
});

describe("run finish: usage and ledger", () => {
  const cases: Array<[string[], RegExp]> = [
    [["--save", "x.txt"], /save path must end in \.af/],
    [["--close", "--discard"], /--close and --discard cannot be combined/],
    [["--save", "x.af", "--discard"], /--save and --discard cannot be combined/],
    [["--export", "PNG"], /--export needs --out <file>/],
    [["--out", "x.png"], /--out needs --export <preset>/],
    [["--width", "10"], /--width needs --export <preset>/],
    [["--force"], /--force needs --save/],
    [["--export", "PNG", "--out", "x.jpg"], /--out must end in \.png/],
    [["--export", "PNG", "--out", "x.png", "--width", "0"], /invalid --width/],
  ];
  it.each(cases)("%j is a usage error and opens no session", async (flags, re) => {
    const r = await exec([reporting(N1.uuid), ...flags]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toMatch(re);
    expect(server.calls).toHaveLength(0);
  });

  it("--export with --allow-generative is refused offline", async () => {
    const p = script("const x = Document.prototype.generateImage;\n");
    const r = await exec([p, "--allow-generative", "--export", "PNG", "--out", join(desktop, "g.png")]);
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain("--export cannot label AI-generated files");
    expect(server.calls).toHaveLength(0);
  });

  it("an unknown preset fails before the script runs", async () => {
    const r = await exec([reporting(N1.uuid), "--export", "Nope", "--out", join(desktop, "n.png")]);
    expect(r.code).toBe(2);
    expect(count("REPORT_")).toBe(0);
  });

  it("without finish flags an ok run marks the unsaved opened document in the ledger", async () => {
    listings([], [N1, LOADED]);
    const r = await exec([reporting(N1.uuid)]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("finish:");
    expect([...readOwned().keys()]).toEqual([N1.uuid.toUpperCase()]);
  });
});
