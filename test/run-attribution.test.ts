// C5: a run is attributed to the UUIDs in its output plus those in --args; the
// current document is only the fallback when neither names one.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRun, runDocuments, type DocListing } from "../src/commands/run.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const A = "AAAAAAAA-0000-4000-8000-000000000001";
const B = "BBBBBBBB-0000-4000-8000-000000000002";
const listing: DocListing = {
  current: B,
  documents: [
    { uuid: A, path: "/tmp/a.af" },
    { uuid: B, path: "" },
  ],
};

describe("runDocuments", () => {
  it("attributes to the UUID named in --args, not the current document", () => {
    expect(runDocuments("done\n", listing, JSON.stringify({ uuid: A }))).toEqual([{ uuid: A, path: "/tmp/a.af" }]);
  });

  it("unions output and args UUIDs, output first", () => {
    expect(runDocuments(`wrote ${A}\n`, listing, JSON.stringify({ other: B })).map((d) => d.uuid)).toEqual([A, B]);
  });

  it("does not repeat a UUID named in both, and upper-cases args UUIDs", () => {
    const docs = runDocuments(`wrote ${A}\n`, listing, JSON.stringify({ uuid: A.toLowerCase() }));
    expect(docs.map((d) => d.uuid)).toEqual([A]);
  });

  it("falls back to the current document when neither output nor args name one", () => {
    expect(runDocuments("done\n", listing, JSON.stringify({ size: 512 }))).toEqual([{ uuid: B, path: "" }]);
    expect(runDocuments("done\n", listing)).toEqual([{ uuid: B, path: "" }]);
  });

  it("two-argument calls (batch) keep their behaviour: output UUIDs only, else current", () => {
    expect(runDocuments(`wrote ${A}\n`, listing).map((d) => d.uuid)).toEqual([A]);
    expect(runDocuments("", null)).toEqual([]);
  });
});

describe("run log attribution through the command", () => {
  let server: FakeServer;
  let root: string;
  let work: string;
  const origCwd = process.cwd();
  const origUrl = process.env["AFFINITY_MCP_URL"];
  const run = makeRun(fakeConnect());

  beforeEach(async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    root = mkdtempSync(join(tmpdir(), "axi-attr-"));
    work = join(root, "work");
    mkdirSync(work);
    process.chdir(work);
    server.onScript(
      "affinity-axi:list-documents",
      JSON.stringify({ current: B, documents: [{ uuid: A, path: "/tmp/a.af" }, { uuid: B, path: "" }] }),
    );
    server.onScript("EDIT-A", "edited\n");
  });

  afterEach(async () => {
    process.chdir(origCwd);
    if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
    else process.env["AFFINITY_MCP_URL"] = origUrl;
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  const lastRecord = (): { documents: Array<{ uuid: string; path: string }> } => {
    const f = join(work, ".affinity-axi", "runs.jsonl");
    expect(existsSync(f)).toBe(true);
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]!);
  };

  it("logs the document named only in --args, not the one in front", async () => {
    const file = join(work, "edit.js");
    writeFileSync(file, "// EDIT-A\nconsole.log('edited')\n");
    const r = await runCommand(run, [file, "--args", JSON.stringify({ uuid: A })]);
    expect(r.code).toBe(0);
    expect(lastRecord().documents).toEqual([{ uuid: A, path: "/tmp/a.af" }]);
  });

  it("logs the current document when the script names none", async () => {
    const file = join(work, "edit.js");
    writeFileSync(file, "// EDIT-A\nconsole.log('edited')\n");
    const r = await runCommand(run, [file]);
    expect(r.code).toBe(0);
    expect(lastRecord().documents).toEqual([{ uuid: B, path: "" }]);
  });
});
