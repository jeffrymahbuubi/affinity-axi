// recordsFor walks up from the cwd and from the saved document's folder, and counts a record once.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendProvenance, isAiGenerated, recordsFor, type ProvenanceRecord } from "../src/affinity/provenance.js";

const UUID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";

function rec(script: string, time = "2026-11-11T10:00:00.000Z", documents = [UUID]): ProvenanceRecord {
  return { time, script, sha256: "0".repeat(64), identifiers: [], args: null, outcome: "ok", documents };
}

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "axi-prov-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dir = (...parts: string[]): string => {
  const d = join(root, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("recordsFor lookup", () => {
  it("finds a log in a parent folder from a child cwd", () => {
    const proj = dir("proj");
    appendProvenance(rec("gen.js"), proj);
    const child = dir("proj", "sub", "deeper");
    expect(recordsFor(UUID, child).map((r) => r.script)).toEqual(["gen.js"]);
    expect(isAiGenerated(UUID, child)).toBe(true);
  });

  it("finds a log beside a saved document from an unrelated cwd through docPath", () => {
    const proj = dir("proj");
    appendProvenance(rec("gen.js"), proj);
    const other = dir("other");
    expect(recordsFor(UUID, other)).toEqual([]);
    const doc = join(proj, "poster.af");
    expect(recordsFor(UUID, other, { docPath: doc }).map((r) => r.script)).toEqual(["gen.js"]);
    expect(isAiGenerated(UUID, other, { docPath: doc })).toBe(true);
  });

  it("finds a log above a document saved in a subfolder", () => {
    appendProvenance(rec("gen.js"), dir("proj"));
    const doc = join(dir("proj", "art"), "poster.af");
    expect(recordsFor(UUID, dir("other"), { docPath: doc })).toHaveLength(1);
  });

  it("counts a record found through both the cwd and the document once", () => {
    const proj = dir("proj");
    appendProvenance(rec("gen.js"), proj);
    appendProvenance(rec("later.js", "2026-11-11T11:00:00.000Z"), proj);
    const child = dir("proj", "sub");
    appendProvenance(rec("gen.js"), child); // the same record logged in a nested folder too
    const found = recordsFor(UUID, child, { docPath: join(proj, "poster.af") });
    expect(found.map((r) => r.script).sort()).toEqual(["gen.js", "later.js"]);
  });

  it("ignores records of other documents and answers [] without any log", () => {
    appendProvenance(rec("other.js", "2026-11-11T10:00:00.000Z", ["11111111-2222-3333-4444-555555555555"]), dir("proj"));
    expect(recordsFor(UUID, dir("proj", "sub"))).toEqual([]);
    expect(recordsFor(UUID, dir("empty"), { docPath: join(dir("nowhere"), "x.af") })).toEqual([]);
  });

  it("ignores a blank or missing docPath", () => {
    appendProvenance(rec("gen.js"), dir("proj"));
    const other = dir("other");
    expect(recordsFor(UUID, other, { docPath: "" })).toEqual([]);
    expect(recordsFor(UUID, other, {})).toEqual([]);
  });
});

describe("recordsFor lookup by saved path and manifest uuids", () => {
  const NEW = "AAAA0000-0000-4000-8000-000000000001";
  const OLD = "01D01D01-D01D-4D01-8D01-D01D01D01D01";
  const withPaths = (script: string, paths: string[], documents = [UUID]): ProvenanceRecord => ({ ...rec(script, "2026-11-11T10:00:00.000Z", documents), paths });

  it("matches a foreign uuid by saved path, case-insensitively", () => {
    const proj = dir("proj");
    const doc = join(proj, "p.af");
    appendProvenance(withPaths("gen.js", [doc]), proj);
    expect(recordsFor(NEW, proj, { docPath: join(proj, "P.AF") }).map((r) => r.script)).toEqual(["gen.js"]);
    expect(isAiGenerated(NEW, proj, { docPath: doc })).toBe(true);
  });

  it("matches through a symlinked path (realpath)", () => {
    const proj = dir("proj");
    const real = join(proj, "p.af");
    writeFileSync(real, "x");
    const link = join(proj, "link.af");
    symlinkSync(real, link);
    appendProvenance(withPaths("gen.js", [real]), proj);
    expect(recordsFor(NEW, proj, { docPath: link })).toHaveLength(1);
  });

  it("without docPath only the uuid matches; a different path does not match", () => {
    const proj = dir("proj");
    appendProvenance(withPaths("gen.js", [join(proj, "p.af")]), proj);
    expect(recordsFor(NEW, proj)).toEqual([]);
    expect(recordsFor(NEW, proj, { docPath: join(proj, "q.af") })).toEqual([]);
    expect(recordsFor(UUID, proj)).toHaveLength(1);
  });

  it("keeps ignoring called: false, also when the path matches", () => {
    const proj = dir("proj");
    const doc = join(proj, "p.af");
    appendProvenance({ ...withPaths("gen.js", [doc]), called: false }, proj);
    expect(recordsFor(NEW, proj, { docPath: doc })).toEqual([]);
  });

  it("a manifest beside docPath with ai.uuids makes a record for that uuid match", () => {
    const proj = dir("proj");
    const doc = join(proj, "q.af");
    appendProvenance(rec("gen.js", "2026-11-11T10:00:00.000Z", [OLD]), proj);
    expect(recordsFor(NEW, proj, { docPath: doc })).toEqual([]);
    writeFileSync(`${doc}.axi.json`, JSON.stringify({ ai: { generated: true, records: 1, uuids: [OLD.toLowerCase()] } }));
    expect(recordsFor(NEW, proj, { docPath: doc }).map((r) => r.script)).toEqual(["gen.js"]);
  });

  it("ignores a missing, old-shape or malformed manifest", () => {
    const proj = dir("proj");
    const doc = join(proj, "q.af");
    appendProvenance(rec("gen.js", "2026-11-11T10:00:00.000Z", [OLD]), proj);
    writeFileSync(`${doc}.axi.json`, JSON.stringify({ ai: { generated: true, records: 1 } }));
    expect(recordsFor(NEW, proj, { docPath: doc })).toEqual([]);
    writeFileSync(`${doc}.axi.json`, "{not json");
    expect(recordsFor(NEW, proj, { docPath: doc })).toEqual([]);
    writeFileSync(`${doc}.axi.json`, JSON.stringify({ ai: { uuids: "OLD" } }));
    expect(recordsFor(NEW, proj, { docPath: doc })).toEqual([]);
  });

  it("counts a record matched by uuid, path and manifest once", () => {
    const proj = dir("proj");
    const doc = join(proj, "p.af");
    appendProvenance(withPaths("gen.js", [doc], [UUID, OLD]), proj);
    writeFileSync(`${doc}.axi.json`, JSON.stringify({ ai: { uuids: [OLD] } }));
    expect(recordsFor(UUID, proj, { docPath: doc })).toHaveLength(1);
  });
});
