// run --allow-generative stores the saved path of each touched document in the
// provenance record, so a reopened document (new session uuid) is still found.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAiGenerated, readProvenance } from "../src/affinity/provenance.js";
import { make as makeRun } from "../src/commands/run.js";
import { GENERATIVE_CALLED } from "../src/commands/run-parts.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-paths-"));
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

const SAVED = "/home/x/proj/photo.af";
const REOPENED = "AAAAAAAA-0000-4000-8000-000000000001";
const listing = (path: string): string =>
  JSON.stringify({ current: FIXTURE_UUID, documents: [{ uuid: FIXTURE_UUID, title: "photo", dirty: false, units: "Pixel", path }] });

const exec = () => {
  const p = join(root, "work", "gen.js");
  writeFileSync(p, "console.log(String(Document.current.sessionUuid));\ndoc.generateImage('a plain wall');\n");
  return runCommand(makeRun(fakeConnect()), [p, "--allow-generative"]);
};

describe("run provenance paths", () => {
  it("a saved document writes its listing path", async () => {
    server.onScript("affinity-axi:list-documents", listing(SAVED));
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\n`);
    const r = await exec();
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    const [rec] = readProvenance();
    expect(rec).toMatchObject({ documents: [FIXTURE_UUID], paths: [SAVED] });
    // a reopened document: new uuid, same saved path
    expect(isAiGenerated(REOPENED, process.cwd(), { docPath: SAVED })).toBe(true);
    expect(isAiGenerated(REOPENED, process.cwd(), { docPath: "/home/x/proj/other.af" })).toBe(false);
  });

  it("an unsaved document writes paths: []", async () => {
    server.onScript("affinity-axi:list-documents", listing(""));
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\n`);
    const r = await exec();
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    const [rec] = readProvenance();
    expect(rec).toMatchObject({ documents: [FIXTURE_UUID], paths: [] });
  });
});
