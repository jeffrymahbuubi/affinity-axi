// User-level run log: location, home scrubbing, torn lines, legacy migration, rotation.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeRun } from "../src/commands/run.js";
import { MAX_LOG_BYTES, appendRun, migrateLegacy, readRuns, runsPath, runsSince } from "../src/affinity/runlog.js";
import type { RunRecord } from "../src/affinity/manifest-types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer } from "./fake-mcp/server.js";

const UUID = "01E35352-1111-4222-8333-444455556666";
const OTHER = "AAAAAAAA-1111-4222-8333-444455556666";

let root: string;
let cwd: string;
let dir: string;
const origCwd = process.cwd();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-runlog-"));
  cwd = join(root, "proj");
  dir = join(root, "state");
  mkdirSync(cwd);
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    time: "2026-10-24T10:00:00.000Z",
    cmd: "run",
    script: "scripts/promo.js",
    scriptSha256: "abc",
    args: null,
    flags: [],
    outcome: "ok",
    ms: 12,
    cwd,
    documents: [{ uuid: UUID, path: "" }],
    ...over,
  };
}

const lines = (f: string): string[] => readFileSync(f, "utf8").split("\n").filter(Boolean);

describe("run log location and content", () => {
  it("writes <dir>/runs.jsonl, creates dir, nothing under the cwd", () => {
    expect(existsSync(dir)).toBe(false);
    expect(appendRun(rec(), cwd, dir)).toBe(join(dir, "runs.jsonl"));
    appendRun(rec(), cwd, dir);
    expect(lines(runsPath(dir))).toHaveLength(2);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("stores the home folder as ~ and returns it absolute; relative paths stay", () => {
    const h = homedir();
    appendRun(
      rec({
        cwd: join(h, "proj"),
        script: join(h, "s", "a.js"),
        documents: [{ uuid: UUID, path: join(h, "d", "x.af") }],
        brand: { name: "b", path: "rel/brand.afbrand", sha256: "z" },
      }),
      cwd,
      dir,
    );
    const text = readFileSync(runsPath(dir), "utf8");
    expect(text).not.toContain(h.replace(/\\/g, "\\\\"));
    const stored = JSON.parse(lines(runsPath(dir))[0]!);
    expect(stored.cwd).toBe("~/proj");
    expect(stored.script).toBe("~/s/a.js");
    expect(stored.documents[0].path).toBe("~/d/x.af");
    const [back] = readRuns(cwd, dir);
    expect(back!.cwd).toBe(join(h, "proj"));
    expect(back!.script).toBe(join(h, "s", "a.js"));
    expect(back!.documents[0]!.path).toBe(join(h, "d", "x.af"));
    expect(back!.brand!.path).toBe("rel/brand.afbrand");
  });

  it("a relative script is stored and returned unchanged", () => {
    appendRun(rec({ script: "scripts/promo.js" }), cwd, dir);
    expect(readRuns(cwd, dir)[0]!.script).toBe("scripts/promo.js");
  });

  it("skips torn lines and returns [] when the log is absent", () => {
    expect(readRuns(cwd, dir)).toEqual([]);
    appendRun(rec({ script: "a.js" }), cwd, dir);
    writeFileSync(runsPath(dir), readFileSync(runsPath(dir), "utf8") + '{"time":"torn\n\n');
    appendRun(rec({ script: "b.js" }), cwd, dir);
    expect(readRuns(cwd, dir).map((r) => r.script)).toEqual(["a.js", "b.js"]);
  });

  it("runsSince filters by UUID (case-insensitive) and strictly later time", () => {
    appendRun(rec({ time: "2026-10-24T10:00:00.000Z", script: "old.js" }), cwd, dir);
    appendRun(rec({ time: "2026-10-24T11:00:00.000Z", script: "new.js" }), cwd, dir);
    appendRun(rec({ time: "2026-10-24T12:00:00.000Z", script: "other.js", documents: [{ uuid: OTHER, path: "" }] }), cwd, dir);
    expect(runsSince(UUID.toLowerCase(), "2026-10-24T10:00:00.000Z", cwd, dir).map((r) => r.script)).toEqual(["new.js"]);
    expect(runsSince(UUID, "", cwd, dir).map((r) => r.script)).toEqual(["old.js", "new.js"]);
    expect(runsSince(OTHER, "2026-10-24T13:00:00.000Z", cwd, dir)).toEqual([]);
  });
});

describe("legacy migration", () => {
  const legacyDir = (): string => join(cwd, ".affinity-axi");
  const seed = (): string => {
    mkdirSync(legacyDir());
    const f = join(legacyDir(), "runs.jsonl");
    const a = JSON.stringify(rec({ script: "one.js" }));
    const { cwd: _drop, ...noCwd } = rec({ script: "two.js" });
    writeFileSync(f, [a, JSON.stringify(noCwd), '{"time":"torn'].join("\n") + "\n");
    return f;
  };

  it("moves the records, deletes the file and the empty folder", () => {
    const f = seed();
    const got = readRuns(cwd, dir);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(legacyDir())).toBe(false);
    expect(got.map((r) => r.script)).toEqual(["one.js", "two.js"]);
    expect(lines(runsPath(dir))).toHaveLength(2);
    expect(got[1]!.cwd).toBe(cwd);
    expect(migrateLegacy(cwd, dir)).toBe(0);
    expect(readRuns(cwd, dir)).toHaveLength(2);
  });

  it("keeps the folder when renders are still there", () => {
    const f = seed();
    mkdirSync(join(legacyDir(), "renders"));
    expect(migrateLegacy(cwd, dir)).toBe(2);
    expect(existsSync(f)).toBe(false);
    expect(existsSync(join(legacyDir(), "renders"))).toBe(true);
  });

  it("moves nothing and loses nothing when the cwd is the state folder's parent", () => {
    const state = join(cwd, ".affinity-axi");
    appendRun(rec({ script: "keep.js" }), cwd, state);
    expect(migrateLegacy(cwd, state)).toBe(0);
    expect(readRuns(cwd, state).map((r) => r.script)).toEqual(["keep.js"]);
  });
});

describe("rotation", () => {
  it("rotates a full log to runs.1.jsonl and reads old records first", () => {
    mkdirSync(dir);
    const old = JSON.stringify(rec({ script: "old.js" }));
    writeFileSync(runsPath(dir), old + "\n" + " ".repeat(MAX_LOG_BYTES));
    appendRun(rec({ script: "new.js" }), cwd, dir);
    expect(lines(runsPath(dir))).toHaveLength(1);
    expect(existsSync(join(dir, "runs.1.jsonl"))).toBe(true);
    expect(readRuns(cwd, dir).map((r) => r.script)).toEqual(["old.js", "new.js"]);
  });
});

describe("run through the fake server", () => {
  it("logs to the state folder, not the cwd, and a save from another cwd still folds it", async () => {
    const server = await startFakeServer();
    const prev = process.env["AFFINITY_MCP_URL"];
    process.env["AFFINITY_MCP_URL"] = server.url;
    try {
      server.onScript("SMOKE", `session ${FIXTURE_UUID}\nok\n`);
      server.onScript("affinity-axi:list-documents", JSON.stringify({ current: FIXTURE_UUID, documents: [] }));
      const script = join(cwd, "s.js");
      writeFileSync(script, "// SMOKE\n");
      process.chdir(cwd);
      const r = await runCommand(makeRun(fakeConnect()), [script]);
      expect(r.code).toBe(0);
      expect(existsSync(join(cwd, ".affinity-axi", "runs.jsonl"))).toBe(false);
      expect(readRuns().filter((x) => x.documents.some((d) => d.uuid === FIXTURE_UUID))).toHaveLength(1);
      const other = join(root, "other");
      mkdirSync(other);
      process.chdir(other);
      expect(runsSince(FIXTURE_UUID, "", other)).toHaveLength(1);
      expect(runsPath()).toBe(join(process.env["AFFINITY_AXI_HOME"]!, "runs.jsonl"));
    } finally {
      process.chdir(origCwd);
      if (prev === undefined) delete process.env["AFFINITY_MCP_URL"];
      else process.env["AFFINITY_MCP_URL"] = prev;
      await server.close();
    }
  });
});
