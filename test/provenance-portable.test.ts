// The provenance log and sidecar store paths relative or ~-based, never with the home folder.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendProvenance,
  provenancePath,
  readProvenance,
  recordsFor,
  writeSidecar,
  type ProvenanceRecord,
} from "../src/affinity/provenance.js";

const UUID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const NEW_UUID = "11111111-2222-3333-4444-555555555555";

function rec(over: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return { time: "2026-11-11T10:00:00.000Z", script: "make.js", sha256: "0".repeat(64), identifiers: [], args: null, outcome: "ok", documents: [UUID], ...over };
}

const fwd = (p: string): string => p.replace(/\\/g, "/");

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "axi-provp-")));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const logText = (): string => readFileSync(provenancePath(cwd), "utf8");

describe("appendProvenance stored form", () => {
  it("stores paths relative to the cwd or with ~, and reads them back absolute", () => {
    const a = join(cwd, "out", "a.af");
    const b = join(homedir(), "Desktop", "b.af");
    appendProvenance(rec({ paths: [a, b] }), cwd);
    const line = JSON.parse(logText().trim()) as ProvenanceRecord;
    // tmpdir may sit below the home folder, where the encoder prefers ../ over ~
    expect(line.paths![0]).toBe("out/a.af");
    expect(line.paths![1]).toMatch(/^(~\/|\.\.\/).*Desktop\/b\.af$/);
    const back = readProvenance(cwd)[0]!.paths!;
    expect(fwd(back[0]!)).toBe(fwd(a));
    expect(fwd(back[1]!)).toBe(fwd(b));
  });

  it("stores an absolute script relative and leaves a typed relative one", () => {
    appendProvenance(rec({ script: join(cwd, "scripts", "gen.js") }), cwd);
    appendProvenance(rec({ script: "scripts/other.js", time: "2026-11-11T11:00:00.000Z" }), cwd);
    const lines = logText().trim().split("\n").map((l) => JSON.parse(l) as ProvenanceRecord);
    expect(lines[0]!.script).toBe("scripts/gen.js");
    expect(lines[1]!.script).toBe("scripts/other.js");
  });

  it("scrubs the home folder out of args", () => {
    appendProvenance(rec({ args: { out: join(homedir(), "Desktop", "o.png") } }), cwd);
    expect(logText()).not.toContain(homedir());
    expect(logText()).toContain("~");
  });
});

describe("recordsFor with stored paths", () => {
  it("matches a new session UUID by a relative stored path", () => {
    const a = join(cwd, "out", "a.af");
    appendProvenance(rec({ paths: [a] }), cwd);
    expect(recordsFor(NEW_UUID, cwd, { docPath: a })).toHaveLength(1);
    expect(recordsFor(NEW_UUID, cwd, { docPath: join(cwd, "out", "zzz.af") })).toHaveLength(0);
  });

  it("matches a ~ path under the home folder", () => {
    const b = join(homedir(), "Desktop", "b.af");
    appendProvenance(rec({ paths: [b] }), cwd);
    expect(recordsFor(NEW_UUID, cwd, { docPath: b })).toHaveLength(1);
  });

  it("still matches a hand-written old line with absolute paths", () => {
    const a = join(cwd, "old", "a.af");
    mkdirSync(join(cwd, ".affinity-axi"), { recursive: true });
    writeFileSync(provenancePath(cwd), JSON.stringify(rec({ paths: [a] })) + "\n");
    expect(recordsFor(NEW_UUID, cwd, { docPath: a })).toHaveLength(1);
  });
});

describe("writeSidecar stored form", () => {
  it("stores the export as a file name and paths relative to the image folder or ~", () => {
    const imgDir = join(cwd, "img");
    mkdirSync(imgDir, { recursive: true });
    const exported = join(imgDir, "poster.png");
    const records = [rec({ paths: [join(imgDir, "doc.af"), join(homedir(), "Desktop", "b.af")] })];
    const file = writeSidecar(exported, UUID, records);
    const text = readFileSync(file, "utf8");
    const body = JSON.parse(text) as { export: string; records: ProvenanceRecord[] };
    expect(body.export).toBe("poster.png");
    expect(body.records[0]!.paths![0]).toBe("doc.af");
    expect(body.records[0]!.paths![1]).toMatch(/^(~\/|\.\.\/).*Desktop\/b\.af$/);
    expect(text).not.toContain(homedir());
  });
});
