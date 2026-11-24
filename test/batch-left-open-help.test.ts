// `batch` help lines for left-open documents: ids, save before close, clean strays, the 3-document cap. Fake MCP server.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/batch.js";
import { type DocListing } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";
import { installFakeExiftool, removeFakeExiftool, shimPath } from "./helpers/exiftool-shim.js";

const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd"].map((p, i) => `${p}-0000-4000-8000-00000000000${i + 1}`);
const doc = (uuid: string, dirty: boolean, path = ""): DocListing["documents"][number] => ({ uuid, path, dirty });
const listing = (...documents: DocListing["documents"]): DocListing => ({ current: documents[0]?.uuid ?? null, documents });

describe("batch left-open help lines", () => {
  let server: FakeServer;
  let root: string;
  let work: string;
  let desktop: string;
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const origPath = process.env["PATH"];
  const origBrand = process.env["AFFINITY_AXI_BRAND"];
  const batch = make(fakeConnect());

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    delete process.env["AFFINITY_AXI_BRAND"];
    root = mkdtempSync(join(tmpdir(), "axi-batch-find-"));
    work = join(root, "work");
    desktop = join(root, "Desktop");
    mkdirSync(work);
    mkdirSync(desktop);
    process.chdir(work);
  });

  afterEach(async () => {
    process.chdir(origCwd);
    process.env["PATH"] = origPath;
    removeFakeExiftool();
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    if (origBrand === undefined) delete process.env["AFFINITY_AXI_BRAND"];
    else process.env["AFFINITY_AXI_BRAND"] = origBrand;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, body: string): string => {
    const p = join(work, name);
    writeFileSync(p, body);
    return p;
  };
  const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
  const argsOf = (script: string): Record<string, unknown> => JSON.parse(/const ARGS = (.*?); /.exec(script)![1]!) as Record<string, unknown>;
  const TEMPLATE = "/* TEMPLATE_MARK */\nconst d = axiDoc(10, 10);\nconsole.log(JSON.stringify({uuid: String(d.sessionUuid)}));\n";
  const POSTS = JSON.stringify([{ slug: "a" }, { slug: "b" }]);
  const run = (extra: string[] = []): ReturnType<typeof runCommand> => runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", ...extra]);

  /** Every record throws; the output may name a document first (`logUuid`). */
  function stubThrowing(logUuid?: (n: number) => string): void {
    let n = 0;
    server.onScript("TEMPLATE_MARK", () => {
      n++;
      return `${logUuid ? JSON.stringify({ uuid: logUuid(n) }) + "\n" : ""}building...\nError: boom\n    at main:3:1`;
    });
  }

  /** list-documents replies: call 1 is the start listing, call k the (k-1)th read after a record. */
  function stubListing(byCall: (call: number) => DocListing["documents"]): void {
    let n = 0;
    server.onScript("affinity-axi:list-documents", () => {
      const documents = byCall(++n);
      return JSON.stringify({ current: documents[0]?.uuid ?? null, documents });
    });
  }

  function stubOk(): void {
    let n = 0;
    server.onScript("TEMPLATE_MARK", (script) => JSON.stringify({ uuid: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, key: argsOf(script)["key"] }));
  }

  const grow = (n: number, dirty: (i: number) => boolean) => (call: number) => ids.slice(0, call - 1).slice(0, n).map((u, i) => doc(u, dirty(i), dirty(i) ? "" : "/d/x.af"));
  const helpLines = (out: string): string[] => out.split("\n").filter((l) => !l.includes("--mine") && (l.includes("doc save ") || l.includes("doc close ") || l.includes("home view")));

  it("two failed records give a save then a close line for each id", async () => {
    stubThrowing();
    stubListing(grow(2, () => true));
    const r = await run(["--continue-on-error"]);
    const lines = helpLines(r.stdout);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("doc save AAAAAAAA <path-under-Desktop>.af");
    expect(lines[1]).toContain("doc close AAAAAAAA");
    expect(lines[2]).toContain("doc save BBBBBBBB <path-under-Desktop>.af");
    expect(lines[3]).toContain("doc close BBBBBBBB");
    expect(r.stdout).not.toContain("<doc>");
  });

  it("a clean stray gets only its close line", async () => {
    stubThrowing();
    stubListing(grow(1, () => false));
    const r = await run();
    const lines = helpLines(r.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("doc close AAAAAAAA   # left open by a failed record; it has no unsaved changes");
    expect(r.stdout).not.toContain("doc save AAAAAAAA");
  });

  it("four left-open documents give lines for three and a home-view line", async () => {
    stubThrowing();
    const data = JSON.stringify([{ slug: "a" }, { slug: "b" }, { slug: "c" }, { slug: "d" }]);
    stubListing(grow(4, () => true));
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d4.json", data), "--key", "slug", "--continue-on-error"]);
    const out = r.stdout;
    expect(out).toContain("doc close CCCCCCCC");
    expect(out).not.toContain("DDDDDDDD <path");
    expect(out).not.toContain("doc close DDDDDDDD");
    expect(out).toContain("lists the other 1 left-open documents");
    expect(out).not.toContain("<doc>");
  });

  it("a run without a left-open document has no doc close help line", async () => {
    stubOk();
    stubListing(() => []);
    const r = await run();
    expect(r.stdout).not.toContain("doc close");
  });
});
