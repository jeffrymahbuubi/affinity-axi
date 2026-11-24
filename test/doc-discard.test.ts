// doc new --scratch, doc close --discard / --mine, in-process against the fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/doc.js";
import { discardPath } from "../src/commands/finish.js";
import { markOwned, readOwned } from "../src/affinity/owned.js";
import type { DocInfo } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const U = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
const id8 = (n: number): string => U(n).slice(0, 8);
const doc = (n: number, dirty: boolean): DocInfo => ({ uuid: U(n), title: `<Untitled ${n}>`, dirty, units: "Pixel", path: "" });

let server: FakeServer;
let root: string;
let desktop: string;
const origUrl = process.env["AFFINITY_MCP_URL"];
const cmds = make(fakeConnect());
const scripts = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const marked = (m: string) => scripts().filter((s) => s.startsWith(`/* affinity-axi:${m} */`));

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-discard-"));
  desktop = join(root, "Desktop");
  mkdirSync(desktop);
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
});

afterEach(async () => {
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function stub(docs: DocInfo[]): void {
  server.onScript("affinity-axi:list-documents", JSON.stringify({ current: docs[0]?.uuid ?? null, documents: docs }));
}

/** doc-close reports the document's real state: dirty ones refuse until a throwaway save made them clean. */
function stubLive(dirty: Set<string>): void {
  const gone = new Set<string>();
  server.onScript("affinity-axi:doc-close", (s) => {
    const u = /targetUuid = "([^"]+)"/.exec(s)![1]!;
    if (dirty.has(u)) return JSON.stringify({ status: "dirty", uuid: u });
    gone.add(u);
    return JSON.stringify({ status: "closed", uuid: u });
  });
  server.onScript("affinity-axi:doc-save", (s) => {
    const u = /targetUuid = "([^"]+)"/.exec(s)![1]!;
    const p = /outPath = ("[^\n]+");/.exec(s)![1]!;
    const path = JSON.parse(p) as string;
    writeFileSync(path, "af");
    dirty.delete(u);
    return JSON.stringify({ status: "saved", uuid: u, path, dirty: false });
  });
}

describe("doc new --scratch", () => {
  const reply = { uuid: U(1), title: "<Untitled>", dirty: false, units: "Pixel", width: 800, height: 600, dpi: 72, transparent: false };

  it("prints scratch: true and the discard help line, and records scratch in the ledger", async () => {
    server.onScript("affinity-axi:doc-new", JSON.stringify(reply));
    const r = await runCommand(cmds["doc new"], ["--width", "800", "--height", "600", "--scratch"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scratch: true");
    expect(r.stdout.indexOf("scratch: true")).toBeGreaterThan(r.stdout.indexOf("transparent:"));
    expect(r.stdout.trimEnd().split("\n").pop()).toContain(`doc close ${id8(1)} --discard   # scratch: drop it without saving`);
    expect(readOwned().get(U(1))).toMatchObject({ by: "doc new", scratch: true });
  });

  it("a plain doc new prints no scratch line and records scratch: false", async () => {
    server.onScript("affinity-axi:doc-new", JSON.stringify(reply));
    const r = await runCommand(cmds["doc new"], ["--width", "800", "--height", "600"]);
    expect(r.stdout).not.toContain("scratch");
    expect(r.stdout).not.toContain("--discard");
    expect(readOwned().get(U(1))).toMatchObject({ by: "doc new", scratch: false });
  });
});

describe("doc close <doc> --discard", () => {
  it("a dirty owned document without --discard keeps the old error and adds the discard tail", async () => {
    stub([doc(1, true)]);
    markOwned([U(1)], "doc new");
    const r = await runCommand(cmds["doc close"], [id8(1)]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("unsaved changes");
    expect(r.stdout).toContain(`or 'affinity-axi doc close ${id8(1)} --discard' to drop it (affinity-axi created it)`);
    expect(marked("doc-close")).toHaveLength(0);
  });

  it("a dirty document not in the ledger gets no discard tail", async () => {
    stub([doc(1, true)]);
    const r = await runCommand(cmds["doc close"], [id8(1)]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("--discard");
  });

  it("--discard on a dirty foreign document is refused and sends no save or close script", async () => {
    stub([doc(1, true)]);
    const r = await runCommand(cmds["doc close"], [id8(1), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("was not created by affinity-axi, so --discard will not drop it");
    expect(marked("doc-save")).toHaveLength(0);
    expect(marked("doc-close")).toHaveLength(0);
  });

  it("--discard on a dirty owned document saves a throwaway, closes, deletes it", async () => {
    stub([doc(1, true)]);
    markOwned([U(1)], "run");
    stubLive(new Set([U(1)]));
    const r = await runCommand(cmds["doc close"], [id8(1), "--discard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`closed: ${U(1)}`);
    expect(r.stdout).toContain("discarded: true");
    expect(marked("doc-save")).toHaveLength(1);
    expect(marked("doc-save")[0]).toContain(JSON.stringify(discardPath(desktop, U(1))));
    expect(existsSync(discardPath(desktop, U(1)))).toBe(false);
  });

  it("a failed discard is an error with the dialog suggestion", async () => {
    stub([doc(1, true)]);
    markOwned([U(1)], "run");
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: U(1) }));
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "saved", uuid: U(1), path: "x", dirty: true }));
    const r = await runCommand(cmds["doc close"], [id8(1), "--discard"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("check Affinity for an open dialog");
  });

  it("--discard on a clean document is a plain close", async () => {
    stub([doc(1, false)]);
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: U(1) }));
    const r = await runCommand(cmds["doc close"], [id8(1), "--discard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`closed: ${U(1)}\n`);
    expect(marked("doc-save")).toHaveLength(0);
  });

  it("--brief is still accepted", async () => {
    stub([doc(1, false)]);
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: U(1) }));
    const r = await runCommand(cmds["doc close"], [id8(1), "--brief"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`closed: ${U(1)}\n`);
  });

  it("neither <doc> nor --mine, and both, are usage errors that open no session", async () => {
    const a = await runCommand(cmds["doc close"], []);
    expect(a.code).toBe(2);
    expect(a.stdout).toContain("give a document or --mine");
    const b = await runCommand(cmds["doc close"], [id8(1), "--mine"]);
    expect(b.code).toBe(2);
    expect(b.stdout).toContain("<doc> and --mine cannot be combined");
    expect(server.sessionsOpened()).toBe(0);
  });
});

describe("doc close --mine", () => {
  // 1 clean owned, 2 scratch dirty, 3 non-scratch dirty, 4 foreign dirty, 5 owned from another folder
  function setup(): Set<string> {
    stub([doc(1, false), doc(2, true), doc(3, true), doc(4, true), doc(5, true)]);
    markOwned([U(1)], "doc new");
    markOwned([U(2)], "doc new", { scratch: true });
    markOwned([U(3)], "run");
    markOwned([U(5)], "run", { cwd: root });
    const dirty = new Set([U(2), U(3), U(4), U(5)]);
    stubLive(dirty);
    return dirty;
  }
  const addressed = (): string[] => [...marked("doc-close"), ...marked("doc-save")];

  it("closes the clean and scratch ones, keeps the other unsaved, counts others, never touches the foreign one", async () => {
    setup();
    const r = await runCommand(cmds["doc close"], ["--mine"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("closed[2]{doc,how}:");
    expect(r.stdout).toContain(`${id8(1)},closed`);
    expect(r.stdout).toContain(`${id8(2)},discarded`);
    expect(r.stdout).toContain("kept[1]{doc,why}:");
    expect(r.stdout).toContain(`${id8(3)},"unsaved`);
    expect(r.stdout).toContain("others: 1");
    expect(r.stdout).toContain("doc close --mine --discard");
    for (const n of [4, 5]) expect(addressed().some((s) => s.includes(U(n)))).toBe(false);
    expect(existsSync(discardPath(desktop, U(2)))).toBe(false);
  });

  it("prunes the ledger of closed documents", async () => {
    setup();
    await runCommand(cmds["doc close"], ["--mine"]);
    const left = [...readOwned().keys()].sort();
    expect(left).toEqual([U(3), U(5)]);
  });

  it("--mine --discard drops the non-scratch unsaved one too (three closed), no help line", async () => {
    setup();
    const r = await runCommand(cmds["doc close"], ["--mine", "--discard"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("closed[3]{doc,how}:");
    expect(r.stdout).not.toContain("kept[");
    expect(r.stdout).not.toContain("--mine --discard");
    expect(r.stdout).toContain("others: 1");
    expect(addressed().some((s) => s.includes(U(4)))).toBe(false);
  });

  it("with nothing owned prints the note", async () => {
    stub([doc(4, true)]);
    const r = await runCommand(cmds["doc close"], ["--mine"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("note: no open document was created by affinity-axi from this folder");
    expect(marked("doc-close")).toHaveLength(0);
  });

  it("a failed discard is kept with its message and the exit code is 1", async () => {
    stub([doc(2, true)]);
    markOwned([U(2)], "doc new", { scratch: true });
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "dirty", uuid: U(2) }));
    server.onScript("affinity-axi:doc-save", JSON.stringify({ status: "saved", uuid: U(2), path: "x", dirty: true }));
    const r = await runCommand(cmds["doc close"], ["--mine"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("kept[1]{doc,why}:");
    expect(r.stdout).toContain("could not save a throwaway copy");
  });
});
