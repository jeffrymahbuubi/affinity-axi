// A run that fails can leave documents open that its output never names:
// `run` lists documents before and after the call and reports the new ones.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const OLD = { uuid: "11111111-2222-3333-4444-555555555555", title: "kept", dirty: false, units: "px", path: "/home/x/kept.af" };
const NEW = { uuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", title: "Untitled", dirty: true, units: "px", path: "" };
const SAVED = { uuid: "99999999-8888-7777-6666-555555555555", title: "made", dirty: false, units: "px", path: "/home/x/made.af" };

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-leftopen-"));
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

/** list-documents answers: call 1 (before the run) and later calls (after it). */
function listings(before: unknown[], after: unknown[]): void {
  let n = 0;
  server.onScript("affinity-axi:list-documents", () => {
    n++;
    return JSON.stringify({ current: null, documents: n === 1 ? before : after });
  });
}

function script(body: string): string {
  const p = join(root, "s.js");
  writeFileSync(p, body);
  return p;
}

const exec = (p: string) => runCommand(makeRun(fakeConnect()), [p]);

describe("run leftOpen", () => {
  it("a throwing script that created a document: leftOpen names it, with a save help line", async () => {
    listings([OLD], [OLD, NEW]);
    server.onScript("boom()", "TypeError: boom is not a function\n    at s.js:2\n");
    const r = await exec(script("const d = axiDoc();\nboom();\n"));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: exception");
    expect(r.stdout).toContain("leftOpen[1]{uuid,title,dirty}:");
    expect(r.stdout).toContain("  AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE,Untitled,true");
    expect(r.stdout).not.toContain(OLD.uuid);
    const save = "affinity-axi doc save AAAAAAAA <path-under-Desktop>.af   # keep the half-built document";
    const close = "affinity-axi doc close AAAAAAAA   # then close it, or close it in Affinity with Don't Save";
    expect(r.stdout).toContain(save);
    expect(r.stdout).toContain(close);
    expect(r.stdout.indexOf(save)).toBeLessThan(r.stdout.indexOf(close));
  });

  it("a clean document that was left open is listed with a close line and no save help", async () => {
    listings([OLD], [OLD, SAVED]);
    server.onScript("boom()", "TypeError: nope\n    at s.js:1\n");
    const r = await exec(script("boom();\n"));
    expect(r.stdout).toContain("leftOpen[1]{uuid,title,dirty}:");
    expect(r.stdout).toContain(",made,false");
    expect(r.stdout).not.toContain("doc save");
    expect(r.stdout).toContain("affinity-axi doc close 99999999   # left open by the failed run; it has no unsaved changes");
  });

  it("a failed run that opened four documents gets lines for the first three", async () => {
    const mk = (c: string) => ({ ...NEW, uuid: `${c.repeat(8)}-BBBB-CCCC-DDDD-EEEEEEEEEEEE` });
    listings([OLD], [OLD, mk("A"), mk("B"), mk("C"), mk("D")]);
    server.onScript("boom()", "TypeError: nope\n    at s.js:1\n");
    const r = await exec(script("boom();\n"));
    expect(r.stdout).toContain("leftOpen[4]{uuid,title,dirty}:");
    for (const id of ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC"]) expect(r.stdout).toContain(`doc close ${id}`);
    expect(r.stdout).not.toContain("doc close DDDDDDDD");
    expect(r.stdout).not.toContain("doc save DDDDDDDD");
  });

  it("an ok run prints no leftOpen even when it opened a document", async () => {
    listings([OLD], [OLD, NEW]);
    const r = await exec(script("console.log('fine');\n"));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("leftOpen");
  });

  it("an ok run with no uuid in the output that opened one dirty document points at it", async () => {
    listings([OLD], [OLD, NEW]);
    const r = await exec(script("console.log('fine');\n"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity-axi render AAAAAAAA");
    expect(r.stdout).toContain("affinity-axi export AAAAAAAA PNG <path-under-Desktop>");
    expect(r.stdout).toContain("affinity-axi doc save AAAAAAAA <path-under-Desktop>.af   # this run left the document open and unsaved");
    expect(r.stdout).not.toContain("leftOpen[");
  });

  it("an ok run that opened one clean document gets render and export but no save line", async () => {
    listings([OLD], [OLD, SAVED]);
    const r = await exec(script("console.log('fine');\n"));
    expect(r.stdout).toContain("affinity-axi render 99999999");
    expect(r.stdout).not.toContain("doc save");
  });

  it("an ok run with two new documents and no uuid names both ids on the <doc> line", async () => {
    listings([OLD], [OLD, NEW, SAVED]);
    const r = await exec(script("console.log('fine');\n"));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity-axi render <doc>   # this run opened 2 documents: AAAAAAAA 99999999");
    expect(r.stdout).toContain("affinity-axi export <doc> PNG <path-under-Desktop>");
    expect(r.stdout).not.toContain("doc save");
    expect(r.stdout).not.toContain("leftOpen[");
  });

  it("an ok run that prints a uuid uses it even when one document was opened", async () => {
    listings([OLD], [OLD, SAVED]);
    server.onScript("PRINTID", NEW.uuid);
    const r = await exec(script("// PRINTID\nconsole.log('x');\n"));
    expect(r.stdout).toContain("affinity-axi render AAAAAAAA");
    expect(r.stdout).not.toContain("render 99999999");
  });

  it("a failed run that opened nothing prints no leftOpen", async () => {
    listings([OLD], [OLD]);
    server.onScript("boom()", "TypeError: nope\n    at s.js:1\n");
    const r = await exec(script("boom();\n"));
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("leftOpen");
  });

  it("lists once before and once after the call", async () => {
    listings([], []);
    await exec(script("console.log('x');\n"));
    const scripts = server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
    expect(scripts.filter((s) => s.includes("affinity-axi:list-documents"))).toHaveLength(2);
    expect(scripts[0]).toContain("affinity-axi:list-documents");
    expect(scripts[1]).toContain("console.log('x')");
  });

  it("an unreadable before-listing skips the report instead of failing the run", async () => {
    server.onScript("boom()", "TypeError: nope\n    at s.js:1\n");
    const r = await exec(script("boom();\n"));
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("leftOpen");
  });
});
