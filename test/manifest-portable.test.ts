// Manifests store paths without the home folder and read them back: pure filesystem, no Affinity.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brandFor, freshness, manifestPath, readManifest, recordSave, sha256File, writeManifest } from "../src/affinity/manifest.js";
import type { Manifest, RunRecord } from "../src/affinity/manifest-types.js";
import { toPosix } from "../src/affinity/paths.js";
import { appendRun } from "../src/affinity/runlog.js";

const UUID = "01E35352-1111-4222-8333-444455556666";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-mfport-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    time: new Date().toISOString(),
    cmd: "run",
    script: "scripts/promo.js",
    scriptSha256: "abc",
    args: {},
    flags: [],
    outcome: "ok",
    ms: 1,
    cwd: root,
    documents: [{ uuid: UUID, path: "" }],
    ...over,
  };
}

function af(dir: string, name = "x.af"): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "BYTES");
  return p;
}

const brand = (path: string) => ({ name: "Acme", path, sha256: "s" });

/** Saves `x.af` in `outDir` after one run logged from `proj` (a folder under `home`). */
function saveFrom(outDir: string, over: Partial<RunRecord> = {}): Manifest {
  const proj = join(home, "proj");
  mkdirSync(proj, { recursive: true });
  const file = af(outDir);
  appendRun(run({ cwd: proj, script: "scripts/promo.js", brand: brand("brands/acme.json"), ...over }), proj);
  return recordSave(file, UUID, null, proj, { home });
}

describe("recordSave stores portable paths", () => {
  it("uses ../ when the .af is under home", () => {
    const m = saveFrom(join(home, "Desktop", "out"));
    expect(m.madeBy?.script).toBe("../../proj/scripts/promo.js");
    expect(m.madeBy?.brand?.path).toBe("../../proj/brands/acme.json");
    expect(m.history[0]!.script).toBe("../../proj/scripts/promo.js");
    expect(m.history[0]!.brand?.path).toBe("../../proj/brands/acme.json");
  });

  it("uses ~/ when the .af is outside home", () => {
    const m = saveFrom(join(root, "elsewhere"));
    expect(m.madeBy?.script).toBe("~/proj/scripts/promo.js");
    expect(m.madeBy?.brand?.path).toBe("~/proj/brands/acme.json");
    expect(m.history[0]!.script).toBe("~/proj/scripts/promo.js");
    expect(m.history[0]!.brand?.path).toBe("~/proj/brands/acme.json");
  });

  it("is plain relative inside the .af folder", () => {
    const out = join(home, "proj", "scripts");
    const m = saveFrom(out, { script: "promo.js", cwd: out });
    expect(m.madeBy?.script).toBe("promo.js");
  });

  it("keeps an absolute path outside home when the .af is under home", () => {
    const script = join(root, "ext", "s.js");
    const m = saveFrom(join(home, "Desktop"), { script });
    expect(m.madeBy?.script).toBe(toPosix(script));
    expect(m.madeBy?.script).not.toContain("\\");
  });

  it("stores a fill template as a relative path and keeps a templates script as logged", () => {
    const out = join(root, "work", "out");
    const template = join(root, "work", "template.af");
    const file = af(out);
    appendRun(run({ cmd: "fill", script: template, documents: [{ uuid: UUID, path: "" }] }), root);
    appendRun(run({ cmd: "templates", script: "templates/ig-post", time: new Date(Date.now() + 1000).toISOString() }), root);
    const m = recordSave(file, UUID, null, root, { home });
    expect(m.history.map((h) => h.script)).toEqual(["../template.af", "templates/ig-post", undefined]);
    expect(m.madeBy?.script).toBe("../template.af");
  });

  it("brandFor gives the ../ or ~/ form for a cwd-relative ref", () => {
    const proj = join(home, "proj");
    const under = brandFor(brand("brands/acme.json"), join(home, "Desktop", "x.af"), proj, home);
    expect(under.path).toBe("../proj/brands/acme.json");
    expect(brandFor(brand("brands/acme.json"), join(root, "out", "x.af"), proj, home).path).toBe("~/proj/brands/acme.json");
  });

  it("returns exports and inventory paths absolute (the in-memory shape)", () => {
    const out = join(home, "out");
    const file = af(out);
    appendRun(run(), root);
    const first = recordSave(file, UUID, null, root, { home });
    first.exports.push({ time: "t", path: join(out, "a.png"), preset: "PNG", area: "document", size: "1x1", bytes: 1, aiGenerated: false });
    writeManifest(file, first, home);
    const second = recordSave(file, UUID, null, root, { home });
    expect(second.exports[0]!.path).toBe(join(out, "a.png"));
  });
});

describe("writeManifest and readManifest", () => {
  it("stores exports and inventory paths relative and reads them absolute again", () => {
    const out = join(root, "out");
    const file = af(out);
    writeManifest(file, {
      ...(readManifestOrEmpty(file)),
      exports: [{ time: "t", path: join(out, "a.png"), preset: "PNG", area: "document", size: "1x1", bytes: 1, aiGenerated: false }],
      inventory: { at: "t", doc: { uuid: UUID, title: "x", path: file, units: "Pixel", width: 1, height: 1, dpi: 72 }, artboards: [], nodes: [], counts: { nodes: 0, named: 0, text: 0, images: 0 } },
    }, home);
    const text = readFileSync(manifestPath(file), "utf8");
    expect(text).toContain('"path": "a.png"');
    expect(text).toContain('"path": "x.af"');
    const m = readManifest(file)!;
    expect(m.exports[0]!.path).toBe(join(out, "a.png"));
    expect(m.inventory?.doc.path).toBe(file);
  });

  it("leaves a madeBy.script of fill alone", () => {
    const file = af(join(root, "out"));
    writeManifest(file, { ...readManifestOrEmpty(file), madeBy: { script: "fill", scriptSha256: "", args: {}, flags: [] } }, home);
    expect(readManifest(file)?.madeBy?.script).toBe("fill");
  });

  it("scrubs the home path from args and notes", () => {
    const file = af(join(root, "out"));
    const image = join(home, "Desktop", "p.jpg");
    writeManifest(file, {
      ...readManifestOrEmpty(file),
      madeBy: { script: "fill", scriptSha256: "", args: { image }, flags: [] },
      notes: [{ time: "t", text: `took ${image} and ${toPosix(image)}` }],
    }, home);
    const text = readFileSync(manifestPath(file), "utf8");
    expect(text).not.toContain(toPosix(home));
    expect(text).not.toContain(JSON.stringify(home).slice(1, -1));
    expect((readManifest(file)!.madeBy!.args as { image: string }).image).toBe("~/Desktop/p.jpg");
  });

  it("reads a 0.5.1 manifest, rewrites it without the home path, and a second write is identical", () => {
    const out = join(home, "Desktop", "out");
    const file = af(out);
    const abs = (p: string) => join(home, p);
    const old = {
      schema: "affinity-axi/manifest/1",
      file: "x.af",
      af: { sha256: sha256File(file), bytes: 5, savedAt: "2026-10-24T13:02:11.000Z", tool: "affinity-axi 0.5.1" },
      madeBy: { script: abs("proj/s.js"), scriptSha256: "a", args: {}, flags: [], brand: brand(abs("proj/brand.json")) },
      history: [{ time: "t", kind: "run", script: abs("proj/s.js"), brand: brand("../../brands/x.json") }],
      exports: [{ time: "t", path: join(out, "a.png"), preset: "PNG", area: "document", size: "1x1", bytes: 1, aiGenerated: false }],
      ai: { generated: false, records: 0, uuids: [] },
      inventory: { at: "t", doc: { uuid: UUID, title: "x", path: file, units: "Pixel", width: 1, height: 1, dpi: 72 }, artboards: [], nodes: [], counts: { nodes: 0, named: 0, text: 0, images: 0 } },
      notes: [],
    };
    writeFileSync(manifestPath(file), JSON.stringify(old, null, 2));
    expect(freshness(file).state).toBe("fresh");
    const m = readManifest(file)!;
    expect(m.exports[0]!.path).toBe(join(out, "a.png"));
    expect(m.history[0]!.brand?.path).toBe("../../brands/x.json");

    writeManifest(file, m, home);
    const first = readFileSync(manifestPath(file), "utf8");
    expect(first).not.toContain(toPosix(home));
    expect(first).not.toContain(JSON.stringify(home).slice(1, -1));
    writeManifest(file, readManifest(file)!, home);
    expect(readFileSync(manifestPath(file), "utf8")).toBe(first);
    expect(freshness(file).state).toBe("fresh");
  });
});

function readManifestOrEmpty(file: string): Manifest {
  writeFileSync(manifestPath(file), JSON.stringify({}));
  return readManifest(file)!;
}
