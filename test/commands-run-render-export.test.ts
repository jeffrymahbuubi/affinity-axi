// run, render, export, presets. In-process against the fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type CommandModule, type Registry } from "../src/cli/router.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { refusalSuggestion } from "../src/affinity/guard.js";
import { make as makeRun } from "../src/commands/run.js";
import { make as makeRender } from "../src/commands/render.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, FIXTURE_UUID_2, TINY_JPEG_B64, TINY_JPEG_SIZE } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-u3-"));
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

const run = makeRun(fakeConnect());
const render = makeRender(fakeConnect());
const { export: exportCmd, presets } = makeExportModule(fakeConnect());

function writeScript(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

function stubDocs(current: string | null = FIXTURE_UUID): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current, documents: FIXTURE_DOCS }));
}

function stubApp(desktopPath: string = desktop): void {
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop: desktopPath }));
}

function stubPresets(names: string[] = FIXTURE_PRESETS): void {
  server.onScript("affinity-axi:list-presets", JSON.stringify(names));
}

// `run` lists documents before and after the user's script; only the script itself is of interest here.
const scriptCalls = () =>
  server.calls
    .filter((c) => c.name === "execute_script")
    .map((c) => String(c.args["script"]))
    .filter((s) => !s.startsWith("/* affinity-axi:list-documents */"));

async function captureDispatch(reg: Registry, argv: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
  try {
    return { code: await dispatch(reg, argv), stdout: chunks.join("") };
  } finally {
    process.stdout.write = write;
  }
}

describe("run", () => {
  it("refuses a script with an SDK AI API before any connection", async () => {
    const file = writeScript("bad.js", 'doc.generateImage("a cat");\n');
    const r = await run_(file);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith("error: script references SDK AI API generateImage at line 1")).toBe(true);
    expect(r.stdout).toContain("suggestion:");
    expect(r.stdout).toContain(`run ${file} --allow-generative`);
    expect(r.stdout).not.toContain("no-generative-AI rule");
    expect(existsSync(join(work, ".affinity-axi", "provenance.jsonl"))).toBe(false);
    expect(server.sessionsOpened()).toBe(0);
    expect(server.calls).toHaveLength(0);
  });

  it("reports the line of the first AI hit", async () => {
    const file = writeScript("bad2.js", "const a = 1;\n// ok\nx.createGenerativeEditImage(1);\n");
    const r = await run_(file);
    expect(r.stdout).toContain("createGenerativeEditImage at line 3");
  });

  it("refuses close()/closeAsync()/dialog.js before any connection", async () => {
    for (const [name, body, id] of [
      ["c1.js", "const d = Document.current;\nd.close();\n", "close() at line 2"],
      ["c2.js", "doc.closeAsync(() => {});\n", "closeAsync() at line 1"],
      ["c3.js", "const { Dialog } = require('/dialog.js');\n", "/dialog.js at line 1"],
    ]) {
      const r = await run_(writeScript(name!, body!));
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`script calls ${id}`);
      expect(r.stdout).toContain("--allow-blocking");
    }
    expect(server.sessionsOpened()).toBe(0);
  });

  it("runs a blocking call when --allow-blocking is passed", async () => {
    server.onScript("closeAsync", "closed");
    const r = await run_(writeScript("ok.js", "doc.closeAsync(() => {});\n"), "--allow-blocking");
    expect(r.code).toBe(0);
  });

  it("ignores close-like names that are not calls", async () => {
    server.onScript("isClosed", "fine");
    const r = await run_(writeScript("n.js", "const isClosed = doc.closed;\nconsole.log('isClosed');\n"));
    expect(r.code).toBe(0);
  });

  it("allows ML-assisted APIs", async () => {
    server.onScript("removeBackground", "done");
    const file = writeScript("ml.js", "doc.removeBackground();\n");
    const r = await run_(file);
    expect(r.code).toBe(0);
  });

  it("without a UUID in the output the help lines use <doc>, never current", async () => {
    server.onScript("NOUUID", "done");
    const r = await run_(writeScript("nouuid.js", "// NOUUID\nconsole.log('done');\n"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity-axi render <doc>   # print doc.sessionUuid in the script to get the id");
    expect(r.stdout).toContain("affinity-axi export <doc> PNG <path-under-Desktop>");
    expect(r.stdout).not.toContain("render current");
    expect(r.stdout).not.toContain("export current");
  });

  it("the guard refusal suggestion names all four ML calls as flag-free", () => {
    const s = refusalSuggestion("affinity-axi run x.js --allow-generative");
    for (const name of ["removeBackground", "selectSubject", "detectDepth", "colourise"]) expect(s).toContain(name);
  });

  it("prints status ok and an output block", async () => {
    server.onScript(
      "SMOKE",
      `session ${FIXTURE_UUID}\nPNG ok\nSVG (digital - high quality) ok\nPDF (digital - high quality) ok\n`,
    );
    const file = writeScript("smoke-test.js", "// SMOKE\nconsole.log('x');\n");
    const r = await run_(file);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`script: ${file}`);
    expect(r.stdout).toContain("status: ok");
    expect(r.stdout).toMatch(/^ms: \d+$/m);
    expect(r.stdout).toContain("output[4]:");
    expect(r.stdout).toContain(`\n  session ${FIXTURE_UUID}\n`);
    expect(r.stdout).toContain("help[2]:");
    expect(r.stdout).toContain("affinity-axi render 70E876CB");
    expect(r.stdout).toContain("affinity-axi export 70E876CB PNG <path-under-Desktop>");
    expect(r.stdout).not.toContain("truncated");
    // the script body went to the server verbatim, after the preamble read
    // with one document listing before the call (left-open report) and one after it (saved paths)
    expect(server.calls.map((c) => c.name)).toEqual(["read_sdk_documentation_topic", "execute_script", "execute_script", "execute_script"]);
    expect(scriptCalls()[0]).toBe("// SMOKE\nconsole.log('x');\n");
  });

  it("classifies a thrown exception from text and exits 1", async () => {
    server.onScript("BOOM", "Error: boom\n    at main:1:7\n");
    const file = writeScript("boom.js", "throw new Error('boom'); // BOOM\n");
    const r = await run_(file);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: exception");
    expect(r.stdout).toContain("error: Error: boom");
    expect(r.stdout).toContain("at: main:1:7");
  });

  it("keeps the script's console output on an exception", async () => {
    server.onScript("LOGBOOM", "step 1\nstep 2\nTypeError: boom\n    at main:3:1");
    const r = await run_(writeScript("logboom.js", "// LOGBOOM\n"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: exception");
    expect(r.stdout).toContain("error: TypeError: boom");
    expect(r.stdout).toContain("at: main:3:1");
    expect(r.stdout).toContain("output[4]:");
    expect(r.stdout).toContain("\n  step 1\n  step 2\n");
    expect(r.stdout.indexOf("at: main:3:1")).toBeLessThan(r.stdout.indexOf("output[4]:"));
  });

  it("truncates a long output before the exception and prints the --full replay line", async () => {
    server.onScript("LONGBOOM", `${"x".repeat(1600)}\nTypeError: boom\n    at main:3:1`);
    const r = await run_(writeScript("longboom.js", "// LONGBOOM\n"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: exception");
    expect(r.stdout).toContain("error: TypeError: boom");
    expect(r.stdout).toMatch(/\.\.\. \(truncated, \d+ chars total\)/);
    expect(r.stdout).toMatch(/help\[1\]:\n  .*--full/);
  });

  it("classifies not-allowed and sdk-error and exits 1", async () => {
    server.onScript("NOPE", "NOT_ALLOWED: filesystem access is disabled\n");
    server.onScript("BADPRESET", "ERROR: bad preset\n");
    const a = await run_(writeScript("a.js", "// NOPE\n"));
    expect(a.code).toBe(1);
    expect(a.stdout).toContain("status: not-allowed");
    expect(a.stdout).toContain("NOT_ALLOWED: filesystem access is disabled");
    const b = await run_(writeScript("b.js", "// BADPRESET\n"));
    expect(b.code).toBe(1);
    expect(b.stdout).toContain("status: sdk-error");
  });

  it("injects --args on line 1 without adding a newline", async () => {
    const source = "console.log(ARGS.a);\nconsole.log(2);\n";
    const file = writeScript("args.js", source);
    const r = await run_(file, "--args", '{ "a": 1,\n "b": [2] }');
    expect(r.code).toBe(0);
    const sent = scriptCalls()[0]!;
    expect(sent).toContain('const ARGS = {"a":1,"b":[2]};');
    expect(sent.split("\n").length).toBe(source.split("\n").length);
    expect(sent.endsWith(source)).toBe(true);
  });

  it("rejects invalid --args JSON with exit 2 and no connection", async () => {
    const file = writeScript("args2.js", "console.log(1);\n");
    const r = await run_(file, "--args", "{nope");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("error:");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("treats a missing file as a usage error", async () => {
    const r = await run_(join(work, "missing.js"));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("cannot read script file");
    expect(server.sessionsOpened()).toBe(0);
  });

  it("forwards --timeout (default 60000) to callTool", async () => {
    const seen: Array<number | undefined> = [];
    const spy: ConnectFn = async (o) => {
      const c = await fakeConnect()(o);
      const orig = c.callTool.bind(c);
      c.callTool = (n, a, opts) => (n === "execute_script" && seen.push(opts?.timeoutMs), orig(n, a, opts));
      return c;
    };
    const file = writeScript("t.js", "console.log(1);\n");
    await runCommand(makeRun(spy), [file, "--timeout", "12345"]);
    await runCommand(makeRun(spy), [file]);
    expect(seen.filter((t) => t !== undefined)).toEqual([12345, 60000]);
  });

  it("rejects a non-numeric --timeout with exit 2", async () => {
    const r = await run_(writeScript("t2.js", "1\n"), "--timeout", "soon");
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("truncates output over 1500 chars and names the exact --full command", async () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, "0")} ${"x".repeat(20)}`).join("\n") + "\n";
    server.onScript("BIG", big);
    const file = writeScript("big.js", "// BIG\n");
    const r = await run_(file, "--args", "{}", "--timeout", "90000");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`... (truncated, ${big.length} chars total)`);
    expect(r.stdout).toContain(`affinity-axi run ${file} --args '{}' --timeout 90000 --full`);
    expect(r.stdout).not.toContain("line 099");
    const full = await run_(file, "--full");
    expect(full.stdout).toContain("line 099");
    expect(full.stdout).toContain("output[100]:");
    expect(full.stdout).not.toContain("truncated");
  });

  it("does not truncate output of exactly 1500 chars", async () => {
    server.onScript("EXACT", "y".repeat(1499) + "\n");
    const r = await run_(writeScript("e.js", "// EXACT\n"));
    expect(r.stdout).not.toContain("truncated");
  });

  it("unknown flag exits 2 listing valid flags", async () => {
    const r = await run_(writeScript("u.js", "1\n"), "--nope");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--args");
    expect(r.stdout).toContain("--timeout");
  });

  async function run_(...argv: string[]) {
    return runCommand(run, argv);
  }
});

describe("render", () => {
  it("writes a stable JPEG path and prints no base64", async () => {
    stubDocs();
    const r = await runCommand(render, ["current"]);
    expect(r.code).toBe(0);
    const rel = `.affinity-axi/renders/70E876CB-s0.jpg`;
    expect(r.stdout).toContain(`render: ${rel}`);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID}`);
    expect(r.stdout).toContain("spread: 0");
    expect(r.stdout).toContain(`size: ${TINY_JPEG_SIZE.width}x${TINY_JPEG_SIZE.height}`);
    expect(r.stdout).toContain("note: preview capped at 1024px; use export for full resolution");
    expect(r.stdout).toContain("help[2]:");
    expect(r.stdout).not.toContain(TINY_JPEG_B64.slice(0, 40));
    const buf = readFileSync(join(work, rel));
    expect(buf.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(buf.subarray(6, 10).toString("latin1")).toBe("JFIF");
    expect(r.stdout).toContain(`bytes: ${buf.length}`);
    const call = server.calls.find((c) => c.name === "render_spread")!;
    expect(call.args).toEqual({ document_session_uuid: FIXTURE_UUID, spread_index: 0 });
  });

  it("overwrites the same path on repeated calls", async () => {
    stubDocs();
    await runCommand(render, ["current"]);
    const p = join(work, ".affinity-axi/renders/70E876CB-s0.jpg");
    writeFileSync(p, "stale");
    await runCommand(render, ["current"]);
    expect(statSync(p).size).toBeGreaterThan(100);
  });

  it("renders another spread of a doc given by UUID prefix", async () => {
    stubDocs();
    const r = await runCommand(render, [FIXTURE_UUID_2.slice(0, 8).toLowerCase(), "--spread", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`doc: ${FIXTURE_UUID_2}`);
    expect(existsSync(join(work, ".affinity-axi/renders/01E35352-s1.jpg"))).toBe(true);
    expect(server.calls.find((c) => c.name === "render_spread")!.args["spread_index"]).toBe(1);
  });

  it("--selection calls render_selection and names the file -selection.jpg", async () => {
    stubDocs();
    const r = await runCommand(render, ["current", "--selection"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("render: .affinity-axi/renders/70E876CB-selection.jpg");
    expect(server.calls.some((c) => c.name === "render_selection")).toBe(true);
    expect(server.calls.some((c) => c.name === "render_spread")).toBe(false);
    expect(existsSync(join(work, ".affinity-axi/renders/70E876CB-selection.jpg"))).toBe(true);
  });

  it("--out writes to the given path, creating folders", async () => {
    stubDocs();
    const out = join(work, "deep", "er", "x.jpg");
    const r = await runCommand(render, ["current", "--out", out]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`render: ${out}`);
    expect(existsSync(out)).toBe(true);
  });

  it("'current' with no current document is a usage error listing both docs", async () => {
    stubDocs(null);
    const r = await runCommand(render, ["current"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(FIXTURE_UUID);
    expect(r.stdout).toContain(FIXTURE_UUID_2);
    expect(r.stdout).toContain("<Untitled>");
    expect(r.stdout).toContain("logo.af");
    expect(server.calls.some((c) => c.name.startsWith("render_"))).toBe(false);
    expect(existsSync(join(work, ".affinity-axi"))).toBe(false);
  });

  it("an unmatched reference is a usage error", async () => {
    stubDocs();
    const r = await runCommand(render, ["FFFFFFFF"]);
    expect(r.code).toBe(2);
    expect(server.calls.some((c) => c.name.startsWith("render_"))).toBe(false);
  });

  it("an out-of-range spread exits 1 with the server message and writes nothing", async () => {
    stubDocs();
    const r = await runCommand(render, ["current", "--spread", "5"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Spread index out of bounds.");
    expect(existsSync(join(work, ".affinity-axi"))).toBe(false);
  });

  it("rejects a malformed --spread with exit 2 and no connection", async () => {
    const r = await runCommand(render, ["current", "--spread", "-1"]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});


describe("--help and flags", () => {
  const mods = (): Record<string, CommandModule> => ({ run, render, export: exportCmd, presets });
  const registry = (): Registry => ({
    tool: "affinity-axi",
    root: run,
    rootHelp: () => "root help",
    commands: mods(),
    aliases: {},
  });

  for (const name of ["run", "render", "export", "presets"]) {
    it(`${name} --help exits 0 with flags and examples, without connecting`, async () => {
      const r = await captureDispatch(registry(), [name, "--help"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("flags[");
      expect(r.stdout).toMatch(/examples\[[234]\]:/);
      expect(r.stdout).toContain("--url");
      expect(server.sessionsOpened()).toBe(0);
      expect(server.calls).toHaveLength(0);
    });

    it(`${name} rejects an unknown flag with exit 2 naming valid flags`, async () => {
      const r = await captureDispatch(registry(), [name, "a", "b", "c", "--bogus"]);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("unknown flag --bogus");
      expect(r.stdout).toContain("valid flags");
      expect(server.sessionsOpened()).toBe(0);
    });
  }
});
