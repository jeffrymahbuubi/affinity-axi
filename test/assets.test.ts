// `assets` and the home view's assets line, in-process against the fake MCP server.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make as makeAssets } from "../src/commands/assets.js";
import { make as makeHome } from "../src/commands/home.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_UUID } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let root: string;
let server: FakeServer;
const assets = makeAssets(fakeConnect()).assets;
const DEAD_URL = "http://127.0.0.1:1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-assets-"));
});
afterEach(async () => {
  rmSync(root, { recursive: true, force: true });
  if (server) await server.close();
});

/** A saved .af with a hand-made manifest at <dir>/<name>. */
function seed(dir: string, name: string, savedAt: string, script: string, tamper = false): string {
  mkdirSync(dir, { recursive: true });
  const af = join(dir, name);
  writeFileSync(af, "BYTES");
  const m = {
    schema: "affinity-axi/manifest/1",
    file: name,
    af: { sha256: createHash("sha256").update("BYTES").digest("hex"), bytes: 5, savedAt, tool: "affinity-axi 0.1.0" },
    madeBy: script ? { script, scriptSha256: "x", args: {}, flags: [] } : null,
    history: [],
    exports: [],
    ai: { generated: false, records: 0 },
    inventory: null,
    notes: [],
  };
  writeFileSync(af + ".axi.json", JSON.stringify(m));
  if (tamper) writeFileSync(af, "EDITED");
  return af;
}

describe("assets", () => {
  it("lists manifests newest first with madeBy, saved and fresh, relative to the cwd", async () => {
    seed(join(root, "a"), "old.af", "2026-10-01T08:00:00.000Z", "scripts/old.js");
    seed(join(root, "b", "c"), "new.af", "2026-10-24T13:02:11.000Z", "scripts/promo.js", true);
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/assets\[2\]\{file,madeBy,saved,fresh\}:/);
    const rows = r.stdout.split("\n").filter((l) => l.startsWith("  ") && l.includes(".af,"));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("new.af");
    expect(rows[0]).toContain("scripts/promo.js,2026-10-24T13:02Z,stale");
    expect(rows[1]).toContain("old.af,scripts/old.js,2026-10-01T08:00Z,fresh");
    expect(r.stdout).toMatch(/help\[2\]:/);
    expect(r.stdout).toContain("doc open ");
  });

  it("ignores node_modules and says none when there is nothing", async () => {
    seed(join(root, "node_modules", "pkg"), "hidden.af", "2026-10-24T13:02:11.000Z", "");
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`assets: none under ${root}`);
    expect(r.stdout).toMatch(/help\[/);
  });

  it("makes no connection", async () => {
    server = await startFakeServer();
    process.env["AFFINITY_MCP_URL"] = server.url;
    try {
      seed(root, "a.af", "2026-10-24T13:02:11.000Z", "");
      await runCommand(assets, ["--dir", root]);
      expect(server.sessionsOpened()).toBe(0);
    } finally {
      delete process.env["AFFINITY_MCP_URL"];
    }
  });
});

describe("home assets line", () => {
  function stubHome(): void {
    server.onScript("affinity-axi:home-info", JSON.stringify({ version: FIXTURE_APP.version, desktop: FIXTURE_APP.desktop, current: FIXTURE_UUID, documents: FIXTURE_DOCS }));
  }

  it("is absent without manifests", async () => {
    server = await startFakeServer();
    stubHome();
    const home = makeHome(fakeConnect(), { cwd: root });
    const full = await runCommand(home, ["--url", server.url]);
    expect(full.stdout).not.toContain("assets:");
    const brief = await runCommand(home, ["--brief", "--url", server.url]);
    expect(brief.stdout).not.toContain("assets:");
  });

  it("shows `assets: N under ./` and a doc open help line when manifests exist", async () => {
    server = await startFakeServer();
    stubHome();
    seed(join(root, "x"), "one.af", "2026-10-24T13:02:11.000Z", "");
    seed(join(root, "y"), "two.af", "2026-10-23T13:02:11.000Z", "");
    const home = makeHome(fakeConnect(), { cwd: root });
    const full = await runCommand(home, ["--url", server.url]);
    expect(full.code).toBe(0);
    expect(full.stdout).toContain("assets: 2 under ./");
    expect(full.stdout).toMatch(/help\[4\]:/);
    expect(full.stdout).toContain(`doc open ${join("x", "one.af")}`);
    expect(full.stdout.indexOf("assets:")).toBeLessThan(full.stdout.indexOf("help["));
  });

  it("--brief stays within 6 lines with the assets line (connected and unreachable)", async () => {
    server = await startFakeServer();
    stubHome();
    seed(root, "one.af", "2026-10-24T13:02:11.000Z", "");
    const home = makeHome(fakeConnect(), { cwd: root });
    const on = await runCommand(home, ["--brief", "--url", server.url]);
    expect(on.stdout).toContain("assets: 1 under ./");
    expect(on.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(6);
    const off = await runCommand(home, ["--brief", "--url", DEAD_URL]);
    expect(off.code).toBe(0);
    expect(off.stdout).toContain("assets: 1 under ./");
    expect(off.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(6);
  });
});
