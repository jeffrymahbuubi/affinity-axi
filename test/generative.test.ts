// Generative AI is opt-in: run --allow-generative, the provenance log, export
// tagging, library save, ML helpers and the agent guide.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX } from "../src/affinity/helpers.js";
import { scanForAi } from "../src/affinity/guard.js";
import {
  appendProvenance,
  extractUuids,
  isAiGenerated,
  provenancePath,
  readProvenance,
  recordsFor,
  sha256,
  type ProvenanceRecord,
} from "../src/affinity/provenance.js";
import { make as makeExport } from "../src/commands/export.js";
import { make as makeLibrary } from "../src/commands/library.js";
import { make as makeRun } from "../src/commands/run.js";
import { GENERATIVE_CALLED } from "../src/commands/run-parts.js";
import { renderGuide } from "../src/guide/content.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, FIXTURE_UUID_2 } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-gen-"));
  work = join(root, "work");
  desktop = join(root, "Desktop");
  mkdirSync(work);
  mkdirSync(desktop);
  process.chdir(work);
});

afterEach(async () => {
  process.chdir(origCwd);
  if (origUrl === undefined) delete process.env["AFFINITY_MCP_URL"];
  else process.env["AFFINITY_MCP_URL"] = origUrl;
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const GEN = "const doc = Document.current;\nconsole.log(String(doc.sessionUuid));\ndoc.generateImage(ARGS.prompt);\n";
const PROMPT = '{"prompt":"soft terracotta abstract background"}';

function writeScript(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

const run = (connect: ConnectFn = fakeConnect()) => makeRun(connect);
const logFile = () => join(work, ".affinity-axi", "provenance.jsonl");
const scriptCalls = () => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));

function rec(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    time: "2026-10-24T10:00:00.000Z",
    script: "s.js",
    sha256: "x",
    identifiers: [{ identifier: "generateImage", line: 1 }],
    args: null,
    outcome: "ok",
    documents: [FIXTURE_UUID],
    ...overrides,
  };
}

describe("provenance log", () => {
  it("extracts unique uppercase UUIDs and hashes with sha256", () => {
    const text = `a ${FIXTURE_UUID.toLowerCase()} b ${FIXTURE_UUID} c ${FIXTURE_UUID_2}`;
    expect(extractUuids(text)).toEqual([FIXTURE_UUID, FIXTURE_UUID_2]);
    expect(extractUuids("no ids here")).toEqual([]);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("appends one JSON line per record and answers isAiGenerated", () => {
    expect(isAiGenerated(FIXTURE_UUID)).toBe(false);
    expect(readProvenance()).toEqual([]);
    appendProvenance(rec());
    appendProvenance(rec({ documents: [FIXTURE_UUID_2], outcome: "not-allowed" }));
    const lines = readFileSync(provenancePath(), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).script).toBe("s.js");
    expect(isAiGenerated(FIXTURE_UUID)).toBe(true);
    expect(isAiGenerated(FIXTURE_UUID.toLowerCase())).toBe(true);
    expect(isAiGenerated("11111111-2222-3333-4444-555555555555")).toBe(false);
    expect(recordsFor(FIXTURE_UUID_2)).toHaveLength(1);
  });

  it("skips torn lines without hiding the rest", () => {
    appendProvenance(rec());
    writeFileSync(provenancePath(), readFileSync(provenancePath(), "utf8") + '{"torn":\n\nnot json\n', "utf8");
    appendProvenance(rec({ script: "later.js" }));
    expect(readProvenance().map((r) => r.script)).toEqual(["s.js", "later.js"]);
  });
});

describe("run --allow-generative", () => {
  it("refuses without the flag, names the flag, and logs nothing", async () => {
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(run(), [file, "--args", PROMPT]);
    expect(r.code).toBe(1);
    expect(r.stdout.startsWith("error: script references SDK AI API generateImage at line 3")).toBe(true);
    expect(r.stdout).toContain(`run ${file} --allow-generative`);
    expect(r.stdout).toContain("logs provenance");
    expect(server.sessionsOpened()).toBe(0);
    expect(existsSync(logFile())).toBe(false);
  });

  it("runs with the flag and logs a full provenance record", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\n`);
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(run(), [file, "--args", PROMPT, "--allow-generative"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: ok");
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    const [record] = readProvenance();
    expect(record).toMatchObject({
      script: file,
      sha256: sha256(GEN),
      identifiers: [{ identifier: "generateImage", line: 3 }],
      args: { prompt: "soft terracotta abstract background" },
      outcome: "ok",
      documents: [FIXTURE_UUID],
    });
    expect(Date.parse(record!.time)).not.toBeNaN();
    expect(isAiGenerated(FIXTURE_UUID)).toBe(true);
    // One listing before the call (left-open report) and one after it, which serves the run log and provenance.
    expect(scriptCalls().filter((s) => s.includes("affinity-axi:list-documents"))).toHaveLength(2);
  });

  it("hashes the user's script, not the args or helpers wrapper", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n`);
    const file = writeScript("gen.js", GEN);
    await runCommand(run(), [file, "--args", PROMPT, "--with-helpers", "--allow-generative"]);
    expect(readProvenance()[0]!.sha256).toBe(sha256(GEN));
  });

  it("falls back to the current document when the script prints no UUID", async () => {
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID_2, documents: FIXTURE_DOCS }));
    server.onScript("createGenerateImage", "done\n");
    const file = writeScript("gen2.js", "x.createGenerateImage('a');\n");
    const r = await runCommand(run(), [file, "--allow-generative"]);
    expect(r.code).toBe(0);
    expect(readProvenance()[0]!.documents).toEqual([FIXTURE_UUID_2]);
    expect(readProvenance()[0]!.args).toBeNull();
  });

  it("writes no record and no provenance line when the flag is given but nothing generative is referenced", async () => {
    server.onScript("removeBackground", "done");
    const file = writeScript("ml.js", "doc.removeBackground();\n");
    const r = await runCommand(run(), [file, "--allow-generative"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("provenance");
    expect(existsSync(logFile())).toBe(false);
  });

  it("ML-only scripts run without the flag and log nothing", async () => {
    server.onScript("selectSubject", "done");
    const file = writeScript("ml2.js", "doc.selectSubject(); doc.detectDepth(); doc.colourise();\n");
    const r = await runCommand(run(), [file]);
    expect(r.code).toBe(0);
    expect(existsSync(logFile())).toBe(false);
  });

  it("logs a NOT_ALLOWED run and points at the Canva AI Studio setting", async () => {
    server.onScript("generateImage", `${GENERATIVE_CALLED}\nNOT_ALLOWED: Canva AI access is disabled\n`);
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(run(), [file, "--args", PROMPT, "--allow-generative"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("status: not-allowed");
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    expect(r.stdout).toContain("Use Canva AI Studio features");
    expect(readProvenance()[0]!.outcome).toBe("not-allowed");
  });

  it("logs a script exception", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\nTypeError: bad\n    at main:3:5\n`);
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(run(), [file, "--args", PROMPT, "--allow-generative"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("provenance: logged (ai-generated)");
    expect(readProvenance()[0]!.outcome).toBe("exception");
  });

  it("logs a call that fails in transit, since Canva AI may already have been used", async () => {
    const failing: ConnectFn = async (opts) => {
      const client = await fakeConnect()(opts);
      return {
        ...client,
        async callTool(name, args, o) {
          if (name === "execute_script") throw new Error("socket closed");
          return client.callTool(name, args, o);
        },
      };
    };
    const file = writeScript("gen.js", GEN);
    await expect(runCommand(run(failing), [file, "--args", PROMPT, "--allow-generative"])).rejects.toThrow("socket closed");
    expect(readProvenance()[0]!.outcome).toBe("error");
  });

  it("still refuses blocking calls independently of the generative flag", async () => {
    const file = writeScript("both.js", "doc.generateImage('a');\ndoc.close();\n");
    const r = await runCommand(run(), [file, "--allow-generative"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("script calls close() at line 2");
    expect(existsSync(logFile())).toBe(false);
  });
});

describe("export tags AI-generated documents", () => {
  const exportCmd = () => makeExport(fakeConnect()).export;

  function stubExport(target: string): void {
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
    server.onScript("affinity-axi:export", (script) => (writeFileSync(JSON.parse(/const outPath = (.*);/.exec(script)![1]!) as string, "png"), "{}"));
  }

  it("prints provenance and writes a sidecar with the matching records", async () => {
    appendProvenance(rec({ args: { prompt: "p" } }));
    appendProvenance(rec({ documents: [FIXTURE_UUID_2], script: "other.js" }));
    const target = join(desktop, "hero.png");
    stubExport(target);
    const r = await runCommand(exportCmd(), ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("provenance: ai-generated");
    expect(r.stdout).toContain(`provenance_file: ${target}.provenance.json`);
    const sidecar = JSON.parse(readFileSync(`${target}.provenance.json`, "utf8"));
    expect(sidecar).toMatchObject({ ai_generated: true, document: FIXTURE_UUID, export: target });
    expect(sidecar.records).toHaveLength(1);
    expect(sidecar.records[0].args).toEqual({ prompt: "p" });
  });

  it("an end-to-end generative run followed by an export tags the file", async () => {
    server.onScript("generateImage", `${FIXTURE_UUID}\n${GENERATIVE_CALLED}\n`);
    const file = writeScript("gen.js", GEN);
    await runCommand(run(), [file, "--args", PROMPT, "--allow-generative"]);
    const target = join(desktop, "bg.png");
    stubExport(target);
    const r = await runCommand(exportCmd(), ["current", "PNG", target]);
    expect(r.stdout).toContain("provenance: ai-generated");
    expect(existsSync(`${target}.provenance.json`)).toBe(true);
  });

  it("leaves untouched documents alone: no provenance line, no sidecar", async () => {
    appendProvenance(rec({ documents: [FIXTURE_UUID_2] }));
    const target = join(desktop, "plain.png");
    stubExport(target);
    const r = await runCommand(exportCmd(), ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("provenance");
    expect(existsSync(`${target}.provenance.json`)).toBe(false);
  });
});

describe("library save", () => {
  const save = () => makeLibrary(fakeConnect())["library save"];
  const flags = ["--title", "Hero", "--description", "d"];

  it("refuses generative scripts by default and names the flag", async () => {
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(save(), [file, ...flags]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error: script references SDK AI API generateImage at line 3/);
    expect(r.stdout).toContain("--allow-generative");
    expect(server.sessionsOpened()).toBe(0);
    expect(server.library.size).toBe(0);
  });

  it("saves with --allow-generative, runs nothing and logs nothing", async () => {
    const file = writeScript("gen.js", GEN);
    const r = await runCommand(save(), [file, ...flags, "--allow-generative"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("library: saved");
    expect(server.library.get("Hero")?.code).toBe(GEN);
    expect(scriptCalls()).toHaveLength(0);
    expect(existsSync(logFile())).toBe(false);
  });
});

describe("ML helpers", () => {
  const ml = ["axiImage", "axiRemoveBackground", "axiSelectSubject", "axiDetectDepth", "axiColourise"];

  it("are indexed, declared and call the real SDK methods", () => {
    for (const name of ml) {
      expect(HELPER_INDEX.some((h) => h.name === name)).toBe(true);
      expect(HELPERS_SOURCE).toMatch(new RegExp(`^function ${name}\\(`, "m"));
    }
    for (const call of ["doc.removeBackground()", "doc.selectSubject()", "doc.detectDepth()", "doc.colourise()", "doc.rasteriseObjects()", "Bitmap.loadFromFile(", "ImageNodeDefinition.create("]) {
      expect(HELPERS_SOURCE).toContain(call);
    }
  });

  it("contain no generative identifier", () => {
    expect(scanForAi(HELPERS_SOURCE)).toEqual([]);
  });
});

describe("guide and home wording", () => {
  it("tells the reader when to opt in, that provenance is automatic and what NOT_ALLOWED means", () => {
    const guide = renderGuide();
    expect(guide).toContain("ai: generative opt-in (--allow-generative); ml allowed");
    expect(guide).toContain("run <file> --allow-generative");
    expect(guide).toContain(".affinity-axi/provenance.jsonl");
    expect(guide).toContain("provenance: logged (ai-generated)");
    expect(guide).toContain("Use Canva AI Studio features");
    expect(guide).toMatch(/`NOT_ALLOWED` result means the setting is off/);
    expect(guide).not.toContain("no override");
  });
});
