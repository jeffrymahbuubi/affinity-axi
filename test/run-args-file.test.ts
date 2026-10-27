// run --args-file <path.json>: the CLI reads the file and injects it exactly like --args.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRun } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-argsfile-"));
  mkdirSync(join(root, "work"));
  process.chdir(join(root, "work"));
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const SCRIPT = "console.log(JSON.stringify(ARGS).length);\nconsole.log('second');\n";
const scriptFile = (): string => {
  const p = join(root, "work", "s.js");
  writeFileSync(p, SCRIPT);
  return p;
};
const jsonFile = (name: string, text: string): string => {
  const p = join(root, "work", name);
  writeFileSync(p, text);
  return p;
};
const exec = (extra: string[]) => runCommand(makeRun(fakeConnect()), [scriptFile(), ...extra]);
const executed = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

describe("run --args-file", () => {
  it("injects a 10 KB file on line 1 and keeps user line numbers", async () => {
    const big = { text: "x".repeat(10240), plan: [1, 2, 3] };
    const f = jsonFile("big.json", JSON.stringify(big, null, 2));
    const r = await exec(["--args-file", f]);
    expect(r.code).toBe(0);
    const sent = executed().find((s) => s.includes("second"))!;
    const lines = sent.split("\n");
    expect(lines[0]).toBe(`const ARGS = ${JSON.stringify(big)}; console.log(JSON.stringify(ARGS).length);`);
    expect(lines[1]).toBe("console.log('second');");
  });

  it("matches --args with the same JSON", async () => {
    const value = { a: 1, b: ["x"] };
    await exec(["--args", JSON.stringify(value)]);
    await exec(["--args-file", jsonFile("a.json", JSON.stringify(value, null, 4))]);
    const sent = executed().filter((s) => s.includes("second"));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("both flags: usage error, exit 2, nothing sent", async () => {
    const r = await exec(["--args", "{}", "--args-file", jsonFile("a.json", "{}")]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("use one of --args or --args-file");
    expect(executed()).toEqual([]);
  });

  it("missing file: exit 2 naming the path", async () => {
    const missing = join(root, "work", "nope.json");
    const r = await exec(["--args-file", missing]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(missing);
    expect(executed()).toEqual([]);
  });

  it("invalid JSON: exit 2 naming the path", async () => {
    const f = jsonFile("bad.json", "{not json");
    const r = await exec(["--args-file", f]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(f);
    expect(executed()).toEqual([]);
  });
});
