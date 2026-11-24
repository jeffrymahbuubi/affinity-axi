// run without --args: ARGS defaults to {} (line 1, line count unchanged); tildeHint for PERMISSION_DENIED.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRun } from "../src/commands/run.js";
import { tildeHint } from "../src/commands/run-parts.js";
import { declaresArgs, withRunArgs } from "../src/affinity/scripts.js";
import { readRuns } from "../src/affinity/runlog.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

describe("declaresArgs / withRunArgs", () => {
  it("is false for ARGS.x, a comment mention and MY_ARGS, true for an indented let", () => {
    expect(declaresArgs("console.log(ARGS.x);")).toBe(false);
    expect(declaresArgs("x(); // const ARGS = 1")).toBe(false);
    expect(declaresArgs("const MY_ARGS = {};")).toBe(false);
    expect(declaresArgs("  let ARGS;")).toBe(true);
    expect(declaresArgs("a();\nvar ARGS = 1;")).toBe(true);
  });
  it("defaults, injects, or leaves the source alone", () => {
    expect(withRunArgs("x()", undefined)).toBe("const ARGS = {}; x()");
    expect(withRunArgs("x()", '{"a":1}')).toBe('const ARGS = {"a":1}; x()');
    expect(withRunArgs("a();\nconst ARGS = { a: 1 };", undefined)).toBe("a();\nconst ARGS = { a: 1 };");
  });
});

describe("tildeHint", () => {
  const denied = "ERROR: PERMISSION_DENIED reading file";
  const line = /^use an absolute path: /;
  it("needs PERMISSION_DENIED and a ~/ or %USERPROFILE% path", () => {
    expect(tildeHint("fine", "x('~/Desktop/a.png')")).toBeUndefined();
    expect(tildeHint(denied, "x('/abs/a.png')")).toBeUndefined();
    expect(tildeHint(denied, "x('~/Desktop/a.png')")).toMatch(line);
    expect(tildeHint(denied, 'x("%USERPROFILE%\\\\Desktop\\\\a.png")')).toMatch(line);
    expect(tildeHint(denied, "x(ARGS.p)", JSON.stringify({ p: "~/Desktop/a.png" }))).toMatch(line);
  });
});

describe("run without --args", () => {
  let server: FakeServer;
  let root: string;
  let work: string;
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const run = makeRun(fakeConnect());
  const executed = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    root = mkdtempSync(join(tmpdir(), "axi-argsdef-"));
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
  const script = (text: string): string => {
    const p = join(work, "s.js");
    writeFileSync(p, text);
    return p;
  };
  const sent = (marker: string) => executed().find((s) => s.includes(marker))!;

  it("puts const ARGS = {}; on line 1 and keeps the line count", async () => {
    const r = await runCommand(run, [script("// MARK-A\nconsole.log('x');\n")]);
    expect(r.code).toBe(0);
    const s = sent("MARK-A");
    expect(s.split("\n")[0]).toBe("const ARGS = {}; // MARK-A");
    expect(s.split("\n").length).toBe(3);
  });

  it("injects --args as before", async () => {
    await runCommand(run, [script("// MARK-B\n"), "--args", '{"a":1}']);
    expect(sent("MARK-B").split("\n")[0]).toBe('const ARGS = {"a":1}; // MARK-B');
  });

  it("leaves a script that declares ARGS unchanged", async () => {
    await runCommand(run, [script("// MARK-C\nconst ARGS = { a: 1 };\n")]);
    expect(sent("MARK-C").startsWith("// MARK-C\nconst ARGS = { a: 1 };")).toBe(true);
  });

  it("with --brand, the brand prefix comes before const ARGS = {}", async () => {
    const brand = join(work, "brand.json");
    writeFileSync(brand, JSON.stringify({
      schema: "affinity-axi/brand/1",
      name: "Test Brand",
      colours: { ink: "#000000", mist: "#FFFFFF" },
      fonts: { headline: "Helvetica-Bold", body: "Helvetica" },
      type: { h1: { font: "headline", size: 64 } },
      space: [4, 8, 16],
      radius: { sm: 8 },
      pairs: [["ink", "mist"]],
    }));
    const r = await runCommand(run, [script("// MARK-D\n"), "--brand", brand]);
    expect(r.code).toBe(0);
    expect(sent("MARK-D").split("\n")[0]).toMatch(/^const AXI_BRAND = .*; const ARGS = \{\}; \/\/ MARK-D$/);
  });

  it("the run log keeps args: null", async () => {
    await runCommand(run, [script("// MARK-E\n")]);
    const runs = readRuns(work); // the run log lives in the user-level state folder
    expect(runs[runs.length - 1]!.args).toBeNull();
  });

  it("adds the tilde help line on PERMISSION_DENIED", async () => {
    server.onScript("MARK-F", "ERROR: PERMISSION_DENIED cannot read file");
    const r = await runCommand(run, [script("// MARK-F\nloadFromFile('~/Desktop/a.png')\n")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("use an absolute path: Affinity does not expand ~/");
  });
});
