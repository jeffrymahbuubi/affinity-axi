// A patched document saved under a new name (doc save to another path) keeps its
// AI label: recordSave also looks up the path it was opened from.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readManifest, recordSave } from "../src/affinity/manifest.js";
import { isAiGenerated } from "../src/affinity/provenance.js";
import { make } from "../src/commands/doc.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const U1 = "AAAAAAAA-1111-4222-8333-444455556666";
const U2 = FIXTURE_UUID;
const U3 = "CCCCCCCC-1111-4222-8333-444455556666";

let root: string;
const origCwd = process.cwd();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-saveas-"));
  process.chdir(root);
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

const afFile = (name: string): string => {
  const p = join(root, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "af-bytes");
  return p;
};

function logRecord(over: Record<string, unknown> = {}): void {
  mkdirSync(join(root, ".affinity-axi"), { recursive: true });
  const rec = { time: "t", script: "s", sha256: "x", identifiers: [], args: null, outcome: "ok", called: true, ...over };
  writeFileSync(join(root, ".affinity-axi", "provenance.jsonl"), JSON.stringify(rec) + "\n", { flag: "a" });
}

describe("recordSave with fromPath", () => {
  it("carries the source path's records and uuids into the new manifest", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1], paths: [p] });
    const q = afFile("q.af");
    const m = recordSave(q, U2, null, root, { fromPath: p });
    expect(m.ai).toEqual({ generated: true, records: 1, uuids: [U2, U1] });
    // q reopened as a new session: found through the manifest beside it
    expect(isAiGenerated(U3, root, { docPath: q })).toBe(true);
  });

  it("without fromPath the same save finds nothing", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1], paths: [p] });
    const q = afFile("q.af");
    expect(recordSave(q, U2, null, root).ai).toEqual({ generated: false, records: 0, uuids: [] });
    expect(isAiGenerated(U3, root, { docPath: q })).toBe(false);
  });

  it("follows a second rename through the source manifest's ai.uuids", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1], paths: [p] });
    const q = afFile("q.af");
    recordSave(q, U2, null, root, { fromPath: p });
    const r = afFile("r.af");
    const m = recordSave(r, U3, null, root, { fromPath: q });
    expect(m.ai.generated).toBe(true);
    expect(m.ai.uuids).toEqual(expect.arrayContaining([U1, U3]));
    expect(isAiGenerated("DDDDDDDD-1111-4222-8333-444455556666", root, { docPath: r })).toBe(true);
  });

  it("a never-patched document stays unlabelled", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1], paths: [afFile("other.af")] });
    const m = recordSave(afFile("q.af"), U2, null, root, { fromPath: p });
    expect(m.ai).toEqual({ generated: false, records: 0, uuids: [] });
  });

  it("ignores a record whose call never ran, and an empty or identical fromPath", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1], paths: [p], called: false });
    const q = afFile("q.af");
    expect(recordSave(q, U2, null, root, { fromPath: p }).ai.generated).toBe(false);
    expect(recordSave(q, U2, null, root, { fromPath: "" }).ai.generated).toBe(false);
    expect(recordSave(q, U2, null, root, { fromPath: q }).ai.generated).toBe(false);
  });

  it("a record that touched several documents keeps all of them when none is known as this one", () => {
    const p = afFile("p.af");
    logRecord({ documents: [U1, U3], paths: [p] });
    const q = afFile("q.af");
    expect(recordSave(q, U2, null, root, { fromPath: p }).ai.uuids).toEqual(expect.arrayContaining([U1, U2, U3]));
  });
});

describe("doc save to a new path", () => {
  let server: FakeServer;
  const origUrl = process.env["AFFINITY_MCP_URL"];
  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop: root }));
    server.onScript("affinity-axi:doc-save", (script) => {
      const p = JSON.parse(/const outPath = ("(?:[^"\\]|\\.)*");/.exec(script)![1]!) as string;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "AFFINITY-BYTES");
      return JSON.stringify({ status: "saved", uuid: U2, path: p, dirty: false });
    });
  });
  afterEach(async () => {
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
  });

  const listing = (path: string): void =>
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: U2, documents: [{ uuid: U2, title: "p", dirty: false, units: "Pixel", path }] }));

  it("labels the new file when the document was opened from a patched one", async () => {
    const p = join(root, "p.af");
    logRecord({ documents: [U1], paths: [p] });
    listing(p);
    const q = join(root, "q.af");
    const r = await runCommand(make(fakeConnect())["doc save"], ["current", q]);
    expect(r.code).toBe(0);
    expect(readManifest(q)?.ai).toEqual({ generated: true, records: 1, uuids: [U2, U1] });
  });

  it("leaves a never-patched document unlabelled", async () => {
    listing(join(root, "p.af"));
    const q = join(root, "q.af");
    const r = await runCommand(make(fakeConnect())["doc save"], ["current", q]);
    expect(r.code).toBe(0);
    expect(readManifest(q)?.ai).toEqual({ generated: false, records: 0, uuids: [] });
  });
});
