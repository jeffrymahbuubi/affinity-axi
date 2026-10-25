// checkOverwrite: the pure verdict shared by every command that writes a .af.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FORCE_FLAG, checkOverwrite } from "../src/affinity/overwrite.js";
import { manifestPath, sha256File, writeManifest } from "../src/affinity/manifest.js";
import type { Manifest } from "../src/affinity/manifest-types.js";

let dir: string;
const CMD = "affinity-axi doc save 70E876CB out/x.af";
const SAVED_AT = "2026-10-24T13:02:11.000Z";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-overwrite-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manifestFor(file: string, sha256: string): Manifest {
  return {
    schema: "affinity-axi/manifest/1",
    file,
    af: { sha256, bytes: 1, savedAt: SAVED_AT, tool: "affinity-axi test" },
    madeBy: null,
    history: [],
    exports: [],
    ai: { generated: false, records: 0 },
    inventory: null,
    notes: [],
  } as Manifest;
}

function seed(name: string, bytes: string, manifest: "none" | "fresh" | "stale" | "nohash"): string {
  const af = join(dir, name);
  writeFileSync(af, bytes);
  if (manifest === "fresh") writeManifest(af, manifestFor(name, sha256File(af)));
  if (manifest === "stale") writeManifest(af, manifestFor(name, "0".repeat(64)));
  if (manifest === "nohash") writeManifest(af, manifestFor(name, ""));
  return af;
}

describe("checkOverwrite", () => {
  it("a missing target is ok and never forced, even with force", () => {
    const t = join(dir, "new.af");
    expect(checkOverwrite(t, { force: false, cmd: CMD })).toEqual({ ok: true, forced: false });
    expect(checkOverwrite(t, { force: true, cmd: CMD })).toEqual({ ok: true, forced: false });
  });

  it("a missing target with a leftover manifest is still ok", () => {
    const t = join(dir, "gone.af");
    writeManifest(t, manifestFor("gone.af", "0".repeat(64)));
    expect(checkOverwrite(t, { force: false, cmd: CMD })).toEqual({ ok: true, forced: false });
  });

  it("a fresh manifest is ok and not forced, even with force", () => {
    const t = seed("fresh.af", "BYTES", "fresh");
    expect(checkOverwrite(t, { force: false, cmd: CMD })).toEqual({ ok: true, forced: false });
    expect(checkOverwrite(t, { force: true, cmd: CMD })).toEqual({ ok: true, forced: false });
  });

  it("a stale manifest is refused with the frozen message and suggestion", () => {
    const t = seed("promo.af", "EDITED", "stale");
    const v = checkOverwrite(t, { force: false, cmd: CMD });
    expect(v).toEqual({
      ok: false,
      reason: "stale",
      message: `promo.af was changed outside affinity-axi after ${SAVED_AT}; refusing to overwrite`,
      suggestion: `${CMD} --force to overwrite anyway; or affinity-axi doc open ${t} to work on that file`,
    });
  });

  it("a stale manifest without savedAt says 'the last save'", () => {
    const t = seed("promo.af", "EDITED", "stale");
    const m = manifestFor("promo.af", "0".repeat(64));
    m.af.savedAt = "";
    writeManifest(t, m);
    const v = checkOverwrite(t, { force: false, cmd: CMD });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toContain("after the last save;");
  });

  it("a stale manifest with force is ok and forced", () => {
    const t = seed("promo.af", "EDITED", "stale");
    expect(checkOverwrite(t, { force: true, cmd: CMD })).toEqual({ ok: true, forced: true });
  });

  it("stale is refused even for the document's own path", () => {
    const t = seed("promo.af", "EDITED", "stale");
    const v = checkOverwrite(t, { force: false, ownPath: t, cmd: CMD });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("stale");
  });

  it("an existing file with no manifest is refused as unmanaged", () => {
    const t = seed("hand.af", "BYTES", "none");
    const v = checkOverwrite(t, { force: false, cmd: CMD });
    expect(v).toEqual({
      ok: false,
      reason: "unmanaged",
      message: "hand.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite",
      suggestion: `pick another path, or ${CMD} --force to replace it; affinity-axi doc open ${t} opens the existing file instead`,
    });
  });

  it("an unmanaged file with force is ok and forced", () => {
    const t = seed("hand.af", "BYTES", "none");
    expect(checkOverwrite(t, { force: true, cmd: CMD })).toEqual({ ok: true, forced: true });
  });

  it("an unmanaged file at the document's own path is ok and not forced", () => {
    const t = seed("hand.af", "BYTES", "none");
    expect(checkOverwrite(t, { force: false, ownPath: t, cmd: CMD })).toEqual({ ok: true, forced: false });
  });

  it("the own path matches through a symlinked parent folder", () => {
    const t = seed("hand.af", "BYTES", "none");
    const link = join(dir, "link");
    symlinkSync(dir, link);
    expect(checkOverwrite(t, { force: false, ownPath: join(link, "hand.af"), cmd: CMD })).toEqual({ ok: true, forced: false });
  });

  it("another document's path is not the own path; an empty ownPath is no own path", () => {
    const t = seed("hand.af", "BYTES", "none");
    mkdirSync(join(dir, "sub"));
    for (const ownPath of [join(dir, "sub", "hand.af"), "", undefined]) {
      const v = checkOverwrite(t, { force: false, ownPath, cmd: CMD });
      expect(v.ok).toBe(false);
    }
  });

  it("a manifest without a hash counts as unmanaged", () => {
    const t = seed("nohash.af", "BYTES", "nohash");
    expect(manifestPath(t)).toContain("nohash.af.axi.json");
    const v = checkOverwrite(t, { force: false, cmd: CMD });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("unmanaged");
  });
});

describe("FORCE_FLAG", () => {
  it("is the shared boolean flag spec", () => {
    expect(FORCE_FLAG.name).toBe("force");
    expect(FORCE_FLAG.type).toBe("boolean");
    expect(FORCE_FLAG.description).toBe(
      "overwrite a .af that was changed outside affinity-axi (stale manifest) or that affinity-axi never saved (no manifest)",
    );
  });
});
