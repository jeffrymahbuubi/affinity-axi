// SDK helper library: source hygiene, run --with-helpers ordering, helpers command.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS, withHelpers } from "../src/affinity/helpers.js";
import { make as makeHelpers } from "../src/commands/helpers.js";
import { make as makeRun } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

describe("HELPERS_SOURCE", () => {
  it("passes the blocking and AI guards", () => {
    expect(scanForBlocking(HELPERS_SOURCE)).toEqual([]);
    expect(scanForAi(HELPERS_SOURCE)).toEqual([]);
  });

  it("is syntactically valid JS", () => {
    expect(() => new Function(HELPERS_SOURCE)).not.toThrow();
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = HELPERS_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const line of top) expect(line).toMatch(/^function axi[A-Z]\w*\(/);
  });

  it("keeps every require() inside a function", () => {
    for (const line of HELPERS_SOURCE.split("\n")) {
      if (line.includes("require(")) expect(line).toMatch(/^\s+/);
    }
  });

  it("declares exactly the indexed helpers plus the internal ones", () => {
    const declared = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
    for (const h of HELPER_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !HELPER_INDEX.some((h) => h.name === n)).sort()).toEqual([...INTERNAL_HELPERS].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("indexes every helper once, with no internal helper in the index", () => {
    const names = HELPER_INDEX.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of INTERNAL_HELPERS) expect(names).not.toContain(n);
  });

  it("has no backtick or template placeholder that would break the String.raw blocks", () => {
    expect(HELPERS_SOURCE).not.toContain("${");
    expect(HELPERS_SOURCE).not.toContain("`");
  });
});

describe("withHelpers", () => {
  it("appends after the user source and keeps its lines in place", () => {
    const user = "const a = 1;\nconsole.log(axiHex('#fff'));\n";
    const out = withHelpers(user);
    expect(out.startsWith(user)).toBe(true);
    expect(out.endsWith(HELPERS_SOURCE)).toBe(true);
    expect(out.split("\n").slice(0, 3)).toEqual(user.split("\n"));
  });

  it("starts a fresh line when the source lacks a trailing newline or ends in a comment", () => {
    const out = withHelpers("x(); // note");
    expect(out.startsWith("x(); // note\n")).toBe(true);
    expect(out.slice("x(); // note\n".length)).toBe(HELPERS_SOURCE);
  });
});

describe("run --with-helpers", () => {
  let server: FakeServer;
  let work: string;
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const run = makeRun(fakeConnect());
  const sent = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    work = mkdtempSync(join(tmpdir(), "axi-helpers-"));
  });

  afterEach(async () => {
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
    rmSync(work, { recursive: true, force: true });
  });

  function script(body: string): string {
    const p = join(work, "s.js");
    writeFileSync(p, body);
    return p;
  }

  it("keeps the user line count, with args still on line 1 and helpers last", async () => {
    const user = "console.log(ARGS.n);\nconsole.log(axiHex('#abc'));\nconsole.log(3);\n";
    const r = await runCommand(run, [script(user), "--args", '{"n":7}', "--with-helpers"]);
    expect(r.code).toBe(0);
    const s = sent()[0]!;
    const lines = s.split("\n");
    expect(lines[0]).toBe('const ARGS = {"n":7}; console.log(ARGS.n);');
    expect(lines.slice(1, 4)).toEqual(user.split("\n").slice(1));
    expect(s.endsWith(HELPERS_SOURCE)).toBe(true);
    // the user part (everything before the appended block) has the original line count
    const userPart = s.slice(0, s.length - HELPERS_SOURCE.length);
    expect(userPart.split("\n").length).toBe(user.split("\n").length);
  });

  it("sends the script untouched without the flag", async () => {
    const user = "console.log(1);\n";
    await runCommand(run, [script(user)]);
    expect(sent()[0]).toBe(user);
  });

  it("guard-scans only the user source, not the helpers", async () => {
    const r = await runCommand(run, [script("console.log(axiHex('#000'));\n"), "--with-helpers"]);
    expect(r.code).toBe(0);
    const bad = await runCommand(run, [script("doc.close();\n"), "--with-helpers"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("close() at line 1");
    expect(sent().filter((s) => !s.includes("affinity-axi:list-documents"))).toHaveLength(1);
  });
});

describe("helpers command", () => {
  const mod = makeHelpers(async () => {
    throw new Error("helpers must not connect");
  });

  it("prints the index and the run hint without connecting", async () => {
    const r = await runCommand(mod, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`helpers[${HELPER_INDEX.length}]{name,signature,summary}:`);
    expect(r.stdout).toContain("axiRect");
    expect(r.stdout).toContain("affinity-axi run <file> --with-helpers");
  });

  it("--grep filters the index and reports the total", async () => {
    const r = await runCommand(mod, ["--grep", "artboard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("axiArtboards");
    expect(r.stdout).not.toContain("axiHex");
    expect(r.stdout).toMatch(/helpers\[\d+ of \d+ total\]/);
  });

  it("--grep with no match says so and exits 0; a bad regex is a usage error", async () => {
    const none = await runCommand(mod, ["--grep", "zzzznothing"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("helpers: 0 matching");
    const bad = await runCommand(mod, ["--grep", "("]);
    expect(bad.code).toBe(2);
  });

  it("--source prints the full helper source", async () => {
    const r = await runCommand(mod, ["--source"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(HELPERS_SOURCE.trim());
  });
});
