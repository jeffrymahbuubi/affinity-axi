// run --allow-generative confirms the generative call really ran: the shim's
// marker sets `called` in the provenance record, and the label follows it.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAiGenerated, readProvenance, recordsFor, appendProvenance, type ProvenanceRecord } from "../src/affinity/provenance.js";
import { TransportError } from "../src/mcp/client.js";
import { make as makeRun } from "../src/commands/run.js";
import { GENERATIVE_CALLED, GENERATIVE_SHIM_UNAVAILABLE, scanMarkers, withGenerativeShim } from "../src/commands/run-parts.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-called-"));
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

const SCRIPT = "console.log(String(Document.current.sessionUuid));\ndoc.generateImage('a plain wall');\n";
const file = (): string => {
  const p = join(root, "work", "gen.js");
  writeFileSync(p, SCRIPT);
  return p;
};
const exec = (extra: string[] = []) => runCommand(makeRun(fakeConnect()), [file(), "--allow-generative", ...extra]);
const executed = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

describe("generative call confirmation", () => {
  it("marker present: called true, ai-generated label, marker stripped from the output", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\ndone\n`);
    const r = await exec();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    expect(r.stdout).not.toContain(GENERATIVE_CALLED);
    expect(r.stdout).toContain("done");
    const [rec] = readProvenance();
    expect(rec!.called).toBe(true);
    expect(isAiGenerated(FIXTURE_UUID)).toBe(true);
  });

  it("exception before the call: called false, the did-not-run label, export labels ignore it", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\nTypeError: boom\n    at gen.js:2\n`);
    const r = await exec();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: exception");
    expect(r.stdout).toContain("provenance: logged (generative identifier found; the call did not run)");
    expect(r.stdout).not.toContain("(ai-generated)");
    const [rec] = readProvenance();
    expect(rec).toMatchObject({ called: false, outcome: "exception", documents: [FIXTURE_UUID] });
    expect(isAiGenerated(FIXTURE_UUID)).toBe(false);
    expect(recordsFor(FIXTURE_UUID)).toEqual([]);
  });

  it("shim unavailable: called unknown, still labelled ai-generated, line stripped", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_SHIM_UNAVAILABLE}\nok\n`);
    const r = await exec();
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    expect(r.stdout).not.toContain(GENERATIVE_SHIM_UNAVAILABLE);
    expect(readProvenance()[0]!.called).toBe("unknown");
    expect(isAiGenerated(FIXTURE_UUID)).toBe(true);
  });

  it("timeout: called unknown (the call may have reached the service)", async () => {
    const connect = fakeConnect();
    const slow = async (opts?: Parameters<typeof connect>[0]) => {
      const c = await connect(opts);
      return {
        ...c,
        callTool: async (name: string, args: Record<string, unknown>, o?: { timeoutMs?: number }) => {
          if (name === "execute_script" && String(args["script"]).includes("generateImage")) {
            throw new TransportError("tools/call timed out after 10 ms");
          }
          return c.callTool(name, args, o);
        },
      };
    };
    const r = await runCommand(makeRun(slow as typeof connect), [file(), "--allow-generative"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("timed out");
    const [rec] = readProvenance();
    expect(rec).toMatchObject({ called: "unknown", outcome: "error" });
    expect(isAiGenerated(FIXTURE_UUID)).toBe(false); // no document named, and none was listed
  });

  it("the shim is one line on line 1, before the user's code", async () => {
    server.onScript("generateImage", `${GENERATIVE_CALLED}\n`);
    await exec();
    const sent = executed().find((s) => s.includes("gen.js") || s.includes("a plain wall"))!;
    const first = sent.split("\n")[0]!;
    expect(first.startsWith("(() => {")).toBe(true);
    expect(first.endsWith("console.log(String(Document.current.sessionUuid));")).toBe(true);
    expect(sent.split("\n")[1]).toBe("doc.generateImage('a plain wall');");
  });

  it("non-generative scripts get no shim", async () => {
    const p = join(root, "work", "plain.js");
    writeFileSync(p, "console.log('hi');\n");
    await runCommand(makeRun(fakeConnect()), [p]);
    expect(executed().some((s) => s.includes(GENERATIVE_CALLED))).toBe(false);
    expect(readProvenance()).toEqual([]);
  });
});

describe("marker helpers", () => {
  it("scanMarkers strips marker lines and reports called", () => {
    expect(scanMarkers(`a\n${GENERATIVE_CALLED}\nb`)).toEqual({ text: "a\nb", called: true });
    expect(scanMarkers("a\nb")).toEqual({ text: "a\nb", called: false });
    expect(scanMarkers(`${GENERATIVE_SHIM_UNAVAILABLE}\nb`).called).toBe("unknown");
    expect(scanMarkers(`${GENERATIVE_SHIM_UNAVAILABLE}\n${GENERATIVE_CALLED}`).called).toBe(true);
  });

  it("withGenerativeShim keeps the source on line 1 after the shim", () => {
    const out = withGenerativeShim("x();\ny();");
    expect(out.split("\n")).toHaveLength(2);
    expect(out.split("\n")[1]).toBe("y();");
  });

  it("old records without the field still count as generated; called false is ignored", () => {
    const base: ProvenanceRecord = {
      time: "2026-10-24T10:00:00.000Z",
      script: "s.js",
      sha256: "x",
      identifiers: [{ identifier: "generateImage", line: 1 }],
      args: null,
      outcome: "ok",
      documents: [FIXTURE_UUID],
    };
    appendProvenance({ ...base, called: false });
    expect(isAiGenerated(FIXTURE_UUID)).toBe(false);
    appendProvenance({ ...base, time: "2026-10-24T11:00:00.000Z" });
    expect(isAiGenerated(FIXTURE_UUID)).toBe(true);
  });
});
