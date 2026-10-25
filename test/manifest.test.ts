// Manifest, run log and asset scan: pure filesystem, no Affinity.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanManifests } from "../src/affinity/assets-scan.js";
import { freshness, manifestPath, readManifest, recordSave, sha256File, writeManifest } from "../src/affinity/manifest.js";
import type { Inventory, Manifest, RunRecord } from "../src/affinity/manifest-types.js";
import { appendRun, readRuns, runsPath, runsSince } from "../src/affinity/runlog.js";

const UUID = "01E35352-1111-4222-8333-444455556666";
const OTHER = "AAAAAAAA-1111-4222-8333-444455556666";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-manifest-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    time: new Date().toISOString(),
    cmd: "run",
    script: "scripts/promo.js",
    scriptSha256: "abc",
    args: { headline: "Hi" },
    flags: ["--with-helpers"],
    outcome: "ok",
    ms: 12,
    cwd: root,
    documents: [{ uuid: UUID, path: "" }],
    ...over,
  };
}

const inventory: Inventory = {
  at: "2026-10-24T00:00:00.000Z",
  doc: { uuid: UUID, title: "t", path: "", units: "Pixel", width: 10, height: 10, dpi: 72 },
  artboards: [],
  nodes: [],
  counts: { nodes: 0, named: 0, text: 0, images: 0 },
};

function writeAf(name: string, body = "af-bytes"): string {
  const p = join(root, name);
  writeFileSync(p, body);
  return p;
}

describe("manifest read/write", () => {
  it("names the manifest <file>.af.axi.json and accepts either path form", () => {
    const af = join(root, "a.af");
    expect(manifestPath(af)).toBe(`${af}.axi.json`);
    expect(manifestPath(`${af}.axi.json`)).toBe(`${af}.axi.json`);
  });

  it("round-trips with two-space JSON and keeps unknown keys", () => {
    const af = writeAf("a.af");
    const m = recordSave(af, UUID, null, root);
    const withExtra = { ...m, futureKey: { keep: true } } as Manifest;
    writeManifest(af, withExtra);
    const text = readFileSync(manifestPath(af), "utf8");
    expect(text).toContain('\n  "schema": "affinity-axi/manifest/1"');
    expect(text.endsWith("\n")).toBe(true);
    const back = readManifest(af) as Manifest & { futureKey?: unknown };
    expect(back.futureKey).toEqual({ keep: true });
    expect(readManifest(`${af}.axi.json`)?.file).toBe("a.af");
  });

  it("returns null for a missing or corrupt manifest", () => {
    const af = writeAf("a.af");
    expect(readManifest(af)).toBeNull();
    writeFileSync(manifestPath(af), "{not json");
    expect(readManifest(af)).toBeNull();
  });

  it("returns null for a manifest file holding an array", () => {
    const af = writeAf("a.af");
    writeFileSync(manifestPath(af), "[]");
    expect(readManifest(af)).toBeNull();
  });

  it("fills in the full shape for a partial manifest and keeps unknown keys", () => {
    const af = writeAf("a.af");
    writeFileSync(manifestPath(af), JSON.stringify({ schema: "affinity-axi/manifest/1", file: "x.af", futureKey: 7 }));
    const m = readManifest(af) as Manifest & { futureKey?: unknown };
    expect(m.schema).toBe("affinity-axi/manifest/1");
    expect(m.file).toBe("x.af");
    expect(m.history).toEqual([]);
    expect(m.exports).toEqual([]);
    expect(m.notes).toEqual([]);
    expect(m.madeBy).toBeNull();
    expect(m.inventory).toBeNull();
    expect(m.af).toEqual({ sha256: "", bytes: 0, savedAt: "", tool: "" });
    expect(m.ai).toEqual({ generated: false, records: 0 });
    expect(m.futureKey).toBe(7);
    expect(freshness(af)).toEqual({ state: "none" });
  });

  it("defaults a partial af and ai field by field and replaces wrongly typed members", () => {
    const af = writeAf("a.af");
    writeFileSync(
      manifestPath(af),
      JSON.stringify({ af: { bytes: 3, extra: "kept" }, ai: { records: 2 }, history: "nope", notes: {}, madeBy: 5, inventory: [] }),
    );
    const m = readManifest(af) as Manifest;
    expect(m.file).toBe("a.af");
    expect(m.af).toMatchObject({ sha256: "", bytes: 3, savedAt: "", tool: "", extra: "kept" });
    expect(m.ai).toEqual({ generated: false, records: 2 });
    expect(m.history).toEqual([]);
    expect(m.notes).toEqual([]);
    expect(m.madeBy).toBeNull();
    expect(m.inventory).toBeNull();
  });

  it("recordSave on a partial manifest keeps its unknown keys and fills the rest", () => {
    const af = writeAf("a.af");
    writeFileSync(manifestPath(af), JSON.stringify({ futureKey: 1 }));
    const m = recordSave(af, UUID, null, root) as Manifest & { futureKey?: unknown };
    expect(m.futureKey).toBe(1);
    expect(m.history.at(-1)?.kind).toBe("save");
    expect(freshness(af).state).toBe("fresh");
  });
});

describe("freshness", () => {
  it("is none without a manifest, fresh after a save, stale after a hand edit or deletion", () => {
    const af = writeAf("a.af");
    expect(freshness(af)).toEqual({ state: "none" });
    recordSave(af, UUID, null, root);
    const f = freshness(af);
    expect(f.state).toBe("fresh");
    expect(f.savedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    writeFileSync(af, "edited by hand");
    expect(freshness(af).state).toBe("stale");
    rmSync(af);
    expect(freshness(af).state).toBe("stale");
  });

  it("treats a manifest that never recorded a hash as none", () => {
    const af = writeAf("a.af");
    const m = recordSave(af, UUID, null, root);
    writeManifest(af, { ...m, af: { ...m.af, sha256: "" } });
    expect(freshness(af).state).toBe("none");
  });
});

describe("recordSave", () => {
  it("hashes the file, folds this session's runs into history and sets madeBy", () => {
    appendRun(run({ time: "2026-10-24T10:00:00.000Z", script: "scripts/promo.js" }), root);
    appendRun(run({ time: "2026-10-24T10:01:00.000Z", cmd: "batch", documents: [{ uuid: OTHER, path: "" }] }), root);
    appendRun(run({ time: "2026-10-24T10:02:00.000Z", documents: [{ uuid: UUID.toLowerCase(), path: "" }] }), root);
    const af = writeAf("a.af", "v1");
    const m = recordSave(af, UUID, inventory, root);
    expect(m.af.sha256).toBe(sha256File(af));
    expect(m.af.bytes).toBe(2);
    expect(m.af.tool).toMatch(/^affinity-axi \d/);
    expect(m.file).toBe("a.af");
    expect(m.history.map((h) => h.kind)).toEqual(["run", "run", "save"]);
    expect(m.history[0]).toMatchObject({ script: "scripts/promo.js", args: { headline: "Hi" }, outcome: "ok", ms: 12 });
    expect(m.history[2]?.forced).toBeUndefined();
    expect(m.madeBy).toEqual({ script: "scripts/promo.js", scriptSha256: "abc", args: { headline: "Hi" }, flags: ["--with-helpers"] });
    expect(m.inventory).toEqual(inventory);
  });

  it("makes madeBy.script relative to the manifest directory", () => {
    mkdirSync(join(root, "out"));
    appendRun(run({ script: join(root, "scripts", "promo.js") }), root);
    const af = writeAf("out/a.af");
    expect(recordSave(af, UUID, null, root).madeBy?.script).toBe(join("..", "scripts", "promo.js"));
  });

  it("rebases brand.path onto the manifest directory in history and madeBy", () => {
    const proj = join(root, "proj");
    mkdirSync(join(proj, "out"), { recursive: true });
    const brand = { name: "Acme", path: "brands/acme.brand.json", sha256: "feed" };
    appendRun(run({ cwd: proj, script: "scripts/promo.js", brand }), root);
    const af = writeAf("proj/out/a.af");
    const m = recordSave(af, UUID, null, root);
    const rebased = { ...brand, path: join("..", "brands", "acme.brand.json") };
    expect(m.madeBy?.brand).toEqual(rebased);
    expect(m.history[0]?.brand).toEqual(rebased);
    // the run-log line itself keeps its cwd-relative meaning
    expect(readRuns(root)[0]?.brand?.path).toBe("brands/acme.brand.json");
  });

  it("falls back to the save cwd when a run recorded none; a run without a brand is unchanged", () => {
    mkdirSync(join(root, "out"));
    appendRun(run({ cwd: "", brand: { name: "Acme", path: "acme.brand.json", sha256: "feed" } }), root);
    const withKit = recordSave(writeAf("out/a.af"), UUID, null, root);
    expect(withKit.madeBy?.brand?.path).toBe(join("..", "acme.brand.json"));

    const other = "BBBBBBBB-1111-4222-8333-444455556666";
    appendRun(run({ documents: [{ uuid: other, path: "" }] }), root);
    const plain = recordSave(writeAf("b.af"), other, null, root);
    expect(plain.madeBy).not.toHaveProperty("brand");
    expect(plain.history[0]).not.toHaveProperty("brand");
  });

  it("folds only the runs since the previous save and keeps madeBy, exports and notes", () => {
    appendRun(run({ time: "2026-10-24T10:00:00.000Z" }), root);
    const af = writeAf("a.af", "v1");
    const first = recordSave(af, UUID, null, root);
    writeManifest(af, { ...first, exports: [{ time: "t", path: "p.png", preset: "PNG", area: "page", size: "1x", bytes: 3, aiGenerated: false }], notes: [{ time: "t", text: "keep me" }] });

    appendRun(run({ time: new Date(Date.now() + 60_000).toISOString(), script: "scripts/other.js" }), root);
    writeFileSync(af, "v2");
    const second = recordSave(af, UUID, inventory, root);
    expect(second.history.map((h) => h.kind)).toEqual(["run", "save", "run", "save"]);
    expect(second.madeBy?.script).toBe("scripts/promo.js");
    expect(second.exports).toHaveLength(1);
    expect(second.notes[0]?.text).toBe("keep me");
    expect(second.af.sha256).toBe(sha256File(af));
  });

  it("records forced: true on a --force save", () => {
    const af = writeAf("a.af");
    expect(recordSave(af, UUID, null, root, { forced: true }).history.at(-1)).toMatchObject({ kind: "save", forced: true });
  });

  it("clears a stale inventory when none is given", () => {
    const af = writeAf("a.af");
    recordSave(af, UUID, inventory, root);
    expect(recordSave(af, UUID, null, root).inventory).toBeNull();
  });

  it("sets ai from the provenance log", () => {
    mkdirSync(join(root, ".affinity-axi"), { recursive: true });
    writeFileSync(
      join(root, ".affinity-axi", "provenance.jsonl"),
      JSON.stringify({ time: "t", script: "s", sha256: "x", identifiers: [], args: null, outcome: "ok", documents: [UUID] }) + "\n",
    );
    const af = writeAf("a.af");
    expect(recordSave(af, UUID, null, root).ai).toEqual({ generated: true, records: 1 });
  });
});

describe("run log", () => {
  it("appends one JSON line per record under .affinity-axi/runs.jsonl", () => {
    appendRun(run(), root);
    appendRun(run(), root);
    expect(runsPath(root)).toBe(join(root, ".affinity-axi", "runs.jsonl"));
    expect(readFileSync(runsPath(root), "utf8").trim().split("\n")).toHaveLength(2);
    expect(readRuns(root)).toHaveLength(2);
  });

  it("skips torn lines and returns [] when the log is absent", () => {
    expect(readRuns(root)).toEqual([]);
    appendRun(run({ script: "a.js" }), root);
    writeFileSync(runsPath(root), readFileSync(runsPath(root), "utf8") + '{"time":"torn\n\n');
    appendRun(run({ script: "b.js" }), root);
    expect(readRuns(root).map((r) => r.script)).toEqual(["a.js", "b.js"]);
  });

  it("runsSince filters by UUID (case-insensitive) and strictly later time", () => {
    appendRun(run({ time: "2026-10-24T10:00:00.000Z", script: "old.js" }), root);
    appendRun(run({ time: "2026-10-24T11:00:00.000Z", script: "new.js" }), root);
    appendRun(run({ time: "2026-10-24T12:00:00.000Z", script: "other.js", documents: [{ uuid: OTHER, path: "" }] }), root);
    expect(runsSince(UUID.toLowerCase(), "2026-10-24T10:00:00.000Z", root).map((r) => r.script)).toEqual(["new.js"]);
    expect(runsSince(UUID, "", root).map((r) => r.script)).toEqual(["old.js", "new.js"]);
    expect(runsSince(OTHER, "2026-10-24T13:00:00.000Z", root)).toEqual([]);
  });
});

describe("scanManifests", () => {
  function asset(rel: string, savedAt: string, script = "scripts/x.js", body = "bytes"): string {
    const af = join(root, rel);
    mkdirSync(join(af, ".."), { recursive: true });
    writeFileSync(af, body);
    const m = recordSave(af, UUID, null, root);
    writeManifest(af, { ...m, af: { ...m.af, savedAt }, madeBy: { script, scriptSha256: "s", args: null, flags: [] } });
    return af;
  }

  it("finds manifests, sorts by savedAt descending and reports freshness", () => {
    asset("old/a.af", "2026-10-01T00:00:00.000Z");
    const b = asset("deep/er/b.af", "2026-10-20T00:00:00.000Z", "scripts/b.js");
    writeFileSync(b, "hand edited");
    const rows = scanManifests(root);
    expect(rows.map((r) => r.file)).toEqual([join("deep", "er", "b.af"), join("old", "a.af")]);
    expect(rows[0]).toMatchObject({ madeBy: "scripts/b.js", savedAt: "2026-10-20T00:00:00.000Z", fresh: "stale", dir: join(root, "deep", "er") });
    expect(rows[1]?.fresh).toBe("fresh");
  });

  it("ignores node_modules, .git, dist and .affinity-axi, and respects maxDepth", () => {
    asset("keep/a.af", "2026-10-01T00:00:00.000Z");
    for (const d of ["node_modules/pkg", ".git/x", "dist", ".affinity-axi"]) asset(`${d}/z.af`, "2026-10-02T00:00:00.000Z");
    expect(scanManifests(root).map((r) => r.file)).toEqual([join("keep", "a.af")]);
    asset("l1/l2/l3/deep.af", "2026-10-03T00:00:00.000Z");
    expect(scanManifests(root, 1).map((r) => r.file)).toEqual([join("keep", "a.af")]);
    expect(scanManifests(root, 3)).toHaveLength(2);
  });

  it("returns [] for a missing directory", () => {
    expect(scanManifests(join(root, "nope"))).toEqual([]);
  });
});

