// Run log and manifest hooks in run, batch and export. Fake MCP server.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeBatch } from "../src/commands/batch.js";
import { make as makeExportModule } from "../src/commands/export.js";
import { make as makeRun } from "../src/commands/run.js";
import { freshness, readManifest, recordSave } from "../src/affinity/manifest.js";
import { readRuns } from "../src/affinity/runlog.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_PRESETS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-a4-"));
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

const run = makeRun(fakeConnect());
const batch = makeBatch(fakeConnect());
const { export: exportCmd } = makeExportModule(fakeConnect());

function write(name: string, body: string): string {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
}

const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const logLines = (): string[] => {
  const f = join(work, ".affinity-axi", "runs.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : [];
};

function stubDocs(docs: Array<{ uuid: string; path: string }>, current: string | null): void {
  server.onScript(
    "affinity-axi:list-documents",
    JSON.stringify({ current, documents: docs.map((d) => ({ ...d, title: "t", dirty: false, units: "Pixel" })) }),
  );
}

describe("run log in run", () => {
  it("appends exactly one line with the printed UUID and leaves stdout alone", async () => {
    server.onScript("SMOKE", `session ${FIXTURE_UUID}\nPNG ok\n`);
    stubDocs([{ uuid: FIXTURE_UUID, path: "" }], FIXTURE_UUID);
    const file = write("smoke.js", "// SMOKE\n");
    const r = await runCommand(run, [file, "--args", '{"a":1}', "--with-helpers"]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("runs.jsonl");
    expect(r.stdout).not.toContain("log");
    const lines = logLines();
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      cmd: "run",
      script: file,
      args: { a: 1 },
      flags: ["--with-helpers"],
      outcome: "ok",
      documents: [{ uuid: FIXTURE_UUID, path: "" }],
    });
    expect(rec.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.cwd).toBe(process.cwd());
    expect(typeof rec.ms).toBe("number");
  });

  it("adds the current document and the saved path when the output names none", async () => {
    server.onScript("QUIET", "done\n");
    stubDocs([{ uuid: FIXTURE_UUID, path: "/d/a.af" }], FIXTURE_UUID);
    await runCommand(run, [write("q.js", "// QUIET\n")]);
    const [rec] = readRuns();
    expect(rec!.documents).toEqual([{ uuid: FIXTURE_UUID, path: "/d/a.af" }]);
    expect(rec!.args).toBeNull();
  });

  it("logs an exception outcome too", async () => {
    server.onScript("BOOM", "Error: boom\n    at main:1:1\n");
    stubDocs([], null);
    const r = await runCommand(run, [write("b.js", "// BOOM\n")]);
    expect(r.code).toBe(1);
    expect(readRuns().map((x) => x.outcome)).toEqual(["exception"]);
  });

  it("a guard-refused script appends nothing and never connects", async () => {
    const r = await runCommand(run, [write("bad.js", 'doc.generateImage("a cat");\n')]);
    expect(r.code).toBe(1);
    expect(logLines()).toHaveLength(0);
    expect(server.sessionsOpened()).toBe(0);
    const c = await runCommand(run, [write("close.js", "doc.close();\n")]);
    expect(c.code).toBe(1);
    expect(logLines()).toHaveLength(0);
  });

  it("an unwritable log never fails the run", async () => {
    writeFileSync(join(work, ".affinity-axi"), "a file where the directory should be");
    server.onScript("OKRUN", "fine\n");
    const r = await runCommand(run, [write("ok.js", "// OKRUN\n")]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("status: ok");
  });

  it("recordSave folds the logged run into the manifest history", async () => {
    server.onScript("SMOKE", `session ${FIXTURE_UUID}\n`);
    stubDocs([{ uuid: FIXTURE_UUID, path: "" }], FIXTURE_UUID);
    await runCommand(run, [write("smoke.js", "// SMOKE\n")]);
    const af = join(desktop, "a.af");
    writeFileSync(af, "af bytes");
    const m = recordSave(af, FIXTURE_UUID, null, process.cwd());
    expect(m.history.map((h) => h.kind)).toEqual(["run", "save"]);
    expect(m.madeBy?.scriptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

const POSTS = JSON.stringify([{ slug: "a", headline: "Satu" }, { slug: "b", headline: "Dua" }]);
const TEMPLATE = "/* TEMPLATE_MARK */\nconsole.log(JSON.stringify({uuid: String(doc.sessionUuid)}));\n";

function stubTemplate(): void {
  let n = 0;
  server.onScript("TEMPLATE_MARK", () => JSON.stringify({ uuid: uuidFor(++n) }));
}

function stubApp(): void {
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
}

function stubSaveClose(): void {
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;
    writeFileSync(path, "af " + path);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
}

describe("run log and manifest in batch", () => {
  it("appends one line per data record, with the record as args", async () => {
    stubTemplate();
    stubDocs([], null);
    const t = write("t.js", TEMPLATE);
    const r = await runCommand(batch, [t, "--data", write("d.json", POSTS), "--key", "slug", "--with-helpers"]);
    expect(r.code).toBe(0);
    const runs = readRuns();
    expect(runs).toHaveLength(2);
    expect(runs.map((x) => x.cmd)).toEqual(["batch", "batch"]);
    expect(runs.map((x) => x.args)).toEqual([{ slug: "a", headline: "Satu" }, { slug: "b", headline: "Dua" }]);
    expect(runs[0]!.flags).toEqual(["--with-helpers"]);
    expect(runs[0]!.documents.map((d) => d.uuid)).toEqual([uuidFor(1).toUpperCase()]);
    expect(runs[1]!.documents.map((d) => d.uuid)).toEqual([uuidFor(2).toUpperCase()]);
  });

  it("--save-dir writes a manifest per saved file with the batch run in its history", async () => {
    stubApp();
    stubTemplate();
    stubSaveClose();
    const dir = join(desktop, "af");
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--save-dir", dir]);
    expect(r.code).toBe(0);
    for (const k of ["a", "b"]) {
      const m = readManifest(join(dir, `${k}.af`))!;
      expect(m.history.map((h) => h.kind)).toEqual(["batch", "save"]);
      expect(m.history[0]!.args).toMatchObject({ slug: k });
      expect(m.inventory).toBeNull();
      expect(freshness(join(dir, `${k}.af`)).state).toBe("fresh");
    }
  });

  it("a stale target fails that record without saving or closing it; the batch goes on", async () => {
    stubApp();
    stubTemplate();
    stubSaveClose();
    const dir = join(desktop, "af");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "a.af");
    writeFileSync(target, "original");
    recordSave(target, uuidFor(99), null, process.cwd());
    writeFileSync(target, "hand edited");
    const r = await runCommand(batch, [
      write("t.js", TEMPLATE),
      "--data",
      write("d.json", POSTS),
      "--key",
      "slug",
      "--save-dir",
      dir,
      "--continue-on-error",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("changed outside affinity-axi");
    expect(readFileSync(target, "utf8")).toBe("hand edited");
    expect(scripts().filter((s) => s.includes("doc-save"))).toHaveLength(1);
    expect(scripts().filter((s) => s.includes("doc-close"))).toHaveLength(1);
    expect(readManifest(join(dir, "b.af"))).not.toBeNull();
  });

  it("a manifest whose .af is gone does not block the save", async () => {
    stubApp();
    stubTemplate();
    stubSaveClose();
    const dir = join(desktop, "af");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "a.af");
    writeFileSync(target, "original");
    recordSave(target, uuidFor(99), null, process.cwd());
    rmSync(target);
    const r = await runCommand(batch, [write("t.js", TEMPLATE), "--data", write("d.json", POSTS), "--key", "slug", "--save-dir", dir]);
    expect(r.code).toBe(0);
    expect(freshness(target).state).toBe("fresh");
  });
});

describe("exports in export", () => {
  function stubExport(target: string, docs: Array<{ uuid: string; path: string }>): void {
    server.onScript("affinity-axi:list-presets", JSON.stringify(FIXTURE_PRESETS));
    stubApp();
    stubDocs(docs, FIXTURE_UUID);
    server.onScript("affinity-axi:export", () => (writeFileSync(target, "png bytes"), "{}"));
  }

  it("appends exports[1] for a saved document with a manifest and keeps stdout unchanged", async () => {
    const af = join(desktop, "a.af");
    writeFileSync(af, "af");
    recordSave(af, FIXTURE_UUID, null, process.cwd());
    const before = readManifest(af)!;
    const target = join(desktop, "a.png");
    stubExport(target, [{ uuid: FIXTURE_UUID, path: af }]);
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`export: ${target}`);
    expect(r.stdout).not.toContain("manifest");
    const m = readManifest(af)!;
    expect(m.exports).toHaveLength(1);
    expect(m.exports[0]).toMatchObject({ path: target, preset: "PNG", area: "whole", size: "", bytes: 9, aiGenerated: false });
    // only the exports field changed, and the .af is still fresh
    expect({ ...m, exports: [] }).toEqual({ ...before, exports: [] });
    expect(freshness(af).state).toBe("fresh");
  });

  it("flags aiGenerated from the provenance log", async () => {
    const af = join(desktop, "a.af");
    writeFileSync(af, "af");
    recordSave(af, FIXTURE_UUID, null, process.cwd());
    const target = join(desktop, "a.png");
    stubExport(target, [{ uuid: FIXTURE_UUID, path: af }]);
    mkdirSync(join(work, ".affinity-axi"), { recursive: true });
    writeFileSync(
      join(work, ".affinity-axi", "provenance.jsonl"),
      JSON.stringify({ time: new Date().toISOString(), script: "g.js", sha256: "x", identifiers: [], args: null, outcome: "ok", documents: [FIXTURE_UUID] }) + "\n",
    );
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(readManifest(af)!.exports[0]!.aiGenerated).toBe(true);
  });

  it("writes nothing for an unsaved document", async () => {
    const target = join(desktop, "a.png");
    stubExport(target, [{ uuid: FIXTURE_UUID, path: "" }]);
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(existsSync(join(desktop, "a.af.axi.json"))).toBe(false);
  });

  it("does not create a manifest for a saved document that has none", async () => {
    const af = join(desktop, "plain.af");
    writeFileSync(af, "af");
    const target = join(desktop, "a.png");
    stubExport(target, [{ uuid: FIXTURE_UUID, path: af }]);
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(readManifest(af)).toBeNull();
  });

  it("an unreadable manifest never fails the export", async () => {
    const af = join(desktop, "a.af");
    writeFileSync(af, "af");
    writeFileSync(`${af}.axi.json`, "{ not json");
    const target = join(desktop, "a.png");
    stubExport(target, [{ uuid: FIXTURE_UUID, path: af }]);
    const r = await runCommand(exportCmd, ["current", "PNG", target]);
    expect(r.code).toBe(0);
    expect(readFileSync(`${af}.axi.json`, "utf8")).toBe("{ not json");
  });
});
