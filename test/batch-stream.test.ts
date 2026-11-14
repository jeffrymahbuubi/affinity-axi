// `batch` streams its record table: the header and each row reach stdout as the
// record finishes, the bytes stay the same as the single-print form, and a
// `renamed` list names every key that differs from its data value.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/batch.js";
import { parseArgs } from "../src/cli/args.js";
import { parseToon } from "../src/output/toon.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-bstream-"));
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

const batch = make(fakeConnect());
const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const argsOf = (script: string): Record<string, unknown> => JSON.parse(/^const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;

function write(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

/** Every template script logs a fresh uuid; `onRecord` sees each call before it answers. */
function stubTemplate(onRecord?: (args: Record<string, unknown>) => void, fail?: (args: Record<string, unknown>) => boolean): void {
  let n = 0;
  server.onScript("TEMPLATE_MARK", (script) => {
    const args = argsOf(script);
    onRecord?.(args);
    if (fail?.(args)) return `building...\nError: boom ${String(args["key"])}\n    at main:3:1`;
    return JSON.stringify({ uuid: uuidFor(++n), key: args["key"] });
  });
}

const data = (slugs: string[]): string => JSON.stringify(slugs.map((slug) => ({ slug })));

describe("batch streams its table", () => {
  it("row 1 is on stdout before the script call of record 2", async () => {
    const seen: string[] = [];
    const chunks: string[] = [];
    stubTemplate((a) => {
      if (a["index"] === 1) seen.push(chunks.join(""));
    });
    const t = write("t.js", TEMPLATE);
    const d = write("d.json", data(["a", "b", "c"]));
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    let code: number;
    try {
      code = await batch.run(parseArgs([t, "--data", d, "--key", "slug"], batch.spec));
    } finally {
      process.stdout.write = orig;
    }
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^batch\[3\]\{key,status,doc,ms,note\}:\n {2}a,ok,[^\n]*\n$/);
    expect(chunks.join("")).toContain("summary: ok=3 failed=0 skipped=0");
  });

  it("the whole stdout equals the single-print form and parses as TOON", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", data(["a", "b", "c"])), "--key", "slug"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      /^batch\[3\]\{key,status,doc,ms,note\}:\n {2}a,ok,[^,\n]*,\d+,\n {2}b,ok,[^,\n]*,\d+,\n {2}c,ok,[^,\n]*,\d+,\nsummary: ok=3 failed=0 skipped=0 ms=\d+\n/,
    );
    expect(r.stdout).not.toContain("renamed[");
    expect(parseToon(r.stdout).ok).toBe(true);
  });

  it("a stopped run prints the skipped rows as part of the stream", async () => {
    stubTemplate(undefined, (a) => a["key"] === "b");
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", data(["a", "b", "c"])), "--key", "slug"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^batch\[3\]\{key,status,doc,ms,note\}:\n {2}a,ok,[^\n]*\n {2}b,failed,,\d+,[^\n]*\n {2}c,skipped,,0,[^\n]*\nsummary: ok=1 failed=1 skipped=1/);
    expect(parseToon(r.stdout).ok).toBe(true);
  });
});

describe("batch renamed list", () => {
  it("appears for a changed key, before the help block, and the file name follows the key", async () => {
    stubTemplate();
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", data(["Hello World", "a--b", "plain"])), "--key", "slug"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ {2}Hello-World,ok,/m);
    expect(r.stdout).toMatch(/^ {2}a--b,ok,/m);
    expect(r.stdout).toContain("renamed[1]{value,key}:\n  Hello World,Hello-World\n");
    expect(r.stdout.indexOf("renamed[1]")).toBeGreaterThan(r.stdout.indexOf("summary:"));
    expect(r.stdout.indexOf("renamed[1]")).toBeLessThan(r.stdout.indexOf("help["));
    expect(parseToon(r.stdout).ok).toBe(true);
  });

  it("is absent when no key changed and without --key", async () => {
    stubTemplate();
    const d = write("d.json", data(["a--b", "x.y_z"]));
    const t = write("t.js", TEMPLATE);
    expect((await runCommand(batch, [t, "--data", d, "--key", "slug"])).stdout).not.toContain("renamed[");
    expect((await runCommand(batch, [t, "--data", d])).stdout).not.toContain("renamed[");
  });

  it("lists at most 10 rows and names the total", async () => {
    stubTemplate();
    const slugs = Array.from({ length: 12 }, (_, i) => `Name ${i}`);
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", data(slugs)), "--key", "slug"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("renamed[10 of 12 total]{value,key}:");
    expect(r.stdout).toContain("  Name 9,Name-9\n");
    expect(r.stdout).not.toContain("Name 10,");
  });
});
