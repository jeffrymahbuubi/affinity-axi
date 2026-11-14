// Guard for the display rule: what the built CLI prints for a path uses "/" between segments
// on every OS. The paths are built with join() inside nested folders, so on Windows they are
// native until the command prints them; where the separator is already "/" the test is
// trivially true. Commands that pass user content through (helpers --source, docs read) are
// left out on purpose: their text is not a path and may hold a legitimate backslash.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXAMPLES } from "../src/examples/registry.js";
import { parseCommandPaths } from "../src/examples/runner.js";

const toolDir = fileURLToPath(new URL("..", import.meta.url));
const bin = join(toolDir, "bin", "affinity-axi.js");

let root: string;
let nested: string;
let af: string;

/** The CLI in the temp tree; no connection is ever made (a dead URL, and these commands are offline). */
function cli(...args: string[]): { status: number | null; text: string; stdout: string } {
  const r = spawnSync("node", [bin, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, AFFINITY_MCP_URL: "http://127.0.0.1:1" },
  });
  return { status: r.status, text: r.stdout + r.stderr, stdout: r.stdout };
}

function expectNoBackslash(label: string, text: string): void {
  expect(text, `${label} printed a backslash:\n${text}`).not.toContain("\\");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "axi-sep-"));
  nested = join(root, "sub", "deeper");
  mkdirSync(nested, { recursive: true });
  af = join(nested, "one.af");
  writeFileSync(af, "BYTES");
  writeFileSync(
    af + ".axi.json",
    JSON.stringify({
      schema: "affinity-axi/manifest/1",
      file: "one.af",
      af: { sha256: "0".repeat(64), bytes: 5, savedAt: "2026-10-01T08:00:00.000Z", tool: "affinity-axi 0.1.0" },
      madeBy: null,
      history: [],
      exports: [],
      ai: { generated: false, records: 0 },
      inventory: null,
      notes: [],
    }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("printed paths use / on every OS", () => {
  it("assets, with and without manifests and with --dir", () => {
    const empty = join(root, "empty", "inner");
    mkdirSync(empty, { recursive: true });
    const withManifests = cli("assets");
    expect(withManifests.stdout).toContain("sub/deeper/one.af");
    expectNoBackslash("assets", withManifests.text);
    const none = cli("assets", "--dir", empty);
    expect(none.stdout).toContain("assets: none under");
    expectNoBackslash("assets (none)", none.text);
    const dir = cli("assets", "--dir", join(root, "sub"));
    expect(dir.stdout).toContain("one.af");
    expectNoBackslash("assets --dir", dir.text);
  });

  it("doc info and doc note", () => {
    const info = cli("doc", "info", af);
    expect(info.status).toBe(0);
    expect(info.stdout).toMatch(/^path: .*sub\/deeper\/one\.af$/m);
    expectNoBackslash("doc info", info.text);
    const note = cli("doc", "note", af, "approved");
    expect(note.status).toBe(0);
    expect(note.stdout).toMatch(/^noted: .*sub\/deeper\/one\.af$/m);
    expectNoBackslash("doc note", note.text);
    const missing = cli("doc", "info", join(nested, "gone.af"));
    expect(missing.status).not.toBe(0);
    expectNoBackslash("doc info (missing)", missing.text);
  });

  it("brand init, list and show", () => {
    const kits = join("kits", "a");
    const init = cli("brand", "init", "acme", "--dir", kits);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("wrote: ");
    expect(init.stdout).toContain("kits/a/acme.brand.json");
    expectNoBackslash("brand init", init.text);
    const again = cli("brand", "init", "acme", "--dir", kits);
    expect(again.status).not.toBe(0);
    expectNoBackslash("brand init (exists)", again.text);
    const nestedInit = cli("brand", "init", "beta");
    expectNoBackslash("brand init (default dir)", nestedInit.text);
    expectNoBackslash("brand list", cli("brand", "list").text);
    const show = cli("brand", "show", join(kits, "acme.brand.json"));
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("path: kits/a/acme.brand.json");
    expectNoBackslash("brand show", show.text);
  });

  it("setup hook --file", () => {
    const file = join(nested, "settings.json");
    const r = cli("setup", "hook", "--file", file);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^file: .*sub\/deeper\/settings\.json$/m);
    // `command:` is the hook shell line, which is stored and run as written; the rest is display.
    expectNoBackslash("setup hook", r.stdout.split("\n").filter((l) => !l.startsWith("command:")).join("\n"));
  });

  for (const id of ["render", "export", "doc-save"]) {
    it(`examples ${id}`, () => {
      expect(EXAMPLES.some((e) => e.id === id)).toBe(true);
      const r = cli("examples", id);
      expect(r.status).toBe(0);
      expectNoBackslash(`examples ${id}`, r.text);
    });
  }

  it("--help of every command", () => {
    const paths = parseCommandPaths(cli("--help").stdout);
    expect(paths.length).toBeGreaterThan(10);
    // `docs read` documents a regex example (`--grep "export\("`): user-typed pattern text, not a path.
    for (const p of paths.filter((c) => c !== "docs read")) {
      const r = cli(...p.split(" "), "--help");
      expect(r.status, p).toBe(0);
      expectNoBackslash(`${p} --help`, r.text);
    }
  });

  it("usage errors: run with a missing file, export with a hidden path, batch with a missing template", () => {
    const run = cli("run", join("nowhere", "gone", "a.js"));
    expect(run.status).toBe(2);
    expect(run.text).toContain("nowhere/gone/a.js");
    expectNoBackslash("run (missing file)", run.text);

    const hidden = cli("export", "current", "PNG", join(nested, ".cache", "x.png"));
    expect(hidden.status).toBe(2);
    expect(hidden.text).toContain("hidden folder");
    expectNoBackslash("export (hidden path)", hidden.text);

    const batch = cli("batch", join("nowhere", "gone", "t.js"), "--data", join(nested, "d.json"));
    expect(batch.status).toBe(2);
    expectNoBackslash("batch (missing template)", batch.text);
  });
});
