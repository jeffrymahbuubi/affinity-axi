// recordsFor walks up from the cwd and from the saved document's folder, and counts a record once.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
