// `fill` sweep fixes (J4, J1): a caught apply error becomes a per-record failure with
// the real message, a cleaned document is closed and the run goes on, an uncleaned one
// is saved under _failed/ and closed (see fill-refix.test.ts), script notes land in the ok row; `templates new
// --args photo` takes the same image types as fill. Fake MCP server; no Affinity.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { make as makeTemplates } from "../src/commands/templates.js";
import { type ApplyReply } from "../src/affinity/fill-script.js";
import { readRuns } from "../src/affinity/runlog.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const BRAND_FILE = fileURLToPath(new URL("../examples/_brand/brand.json", import.meta.url));
const TPL_UUID = "00000000-0000-4000-8000-0000000000a1";

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-fill-sweep-"));
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

const fill = make(fakeConnect());
const OK: ApplyReply = { applied: ["headline"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline"], notes: [] };
const FAILED: ApplyReply = { ...OK, applied: [], error: "axiSelectSubject: no subject found", cleaned: true };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const markers = (): string[] => scripts().map((s) => /affinity-axi:([a-z-]+)/.exec(s)?.[1] ?? "?").filter((m) => m !== "app-info");

/** Stubs open/apply/save/close/export; `apply` and `close` get the 1-based record counter. */
function stub(o: { apply: (n: number) => ApplyReply | string; close?: (n: number) => string }): void {
  let opens = 0;
  let applies = 0;
  let closes = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG"]));
  server.onScript("affinity-axi:fill-open", () => JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) }));
  server.onScript("affinity-axi:fill-apply", () => {
    const r = o.apply(++applies);
    return typeof r === "string" ? r : JSON.stringify(r);
  });
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", () => (o.close ? o.close(++closes) : JSON.stringify({ status: "closed", uuid: "x" })));
  server.onScript("affinity-axi:export", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, "img");
    return JSON.stringify({ exported: path });
  });
}

function setup(): { template: string; data: string; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  const data = join(work, "posts.json");
  writeFileSync(data, JSON.stringify([{ slug: "mar", headline: "Spring" }, { slug: "apr", headline: "April" }]));
  return { template, data, out: join(desktop, "out") };
}
const argv = (t: string, d: string, o: string, extra: string[] = []): string[] => [t, "--data", d, "--key", "slug", "--out-dir", o, ...extra];

describe("fill: an apply error the script caught and undid (J4)", () => {
  it("is a failed row with the real message and 'changes undone'; --continue-on-error runs the next record", async () => {
    stub({ apply: (n) => (n === 1 ? FAILED : OK) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("mar,failed");
    expect(r.stdout).toContain("apply failed: axiSelectSubject: no subject found (changes undone)");
    expect(r.stdout).toContain("apr,ok");
    expect(r.stdout).not.toContain("leftOpen");
    // the clean document was closed before the next record opened
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-close", "fill-open", "fill-apply", "doc-save", "doc-close"]);
    expect(readRuns(work)[0]!.outcome).toBe("exception");
  });

  it("without --continue-on-error the run stops after the failed row, nothing left open", async () => {
    stub({ apply: () => FAILED });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("apr,skipped");
    expect(r.stdout).not.toContain("leftOpen");
  });

  it("a document undo could not clean is saved under _failed/ and closed; the row is failed, not fatal", async () => {
    stub({ apply: (n) => (n === 1 ? { ...FAILED, cleaned: false } : OK) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/mar,failed,[0-9a-f]{8},\d+,"?apply failed: axiSelectSubject: no subject found \(undo left the document dirty; saved as _failed\/mar-[0-9A-F]{8}\.af and closed\)/);
    expect(r.stdout).not.toContain("leftOpen");
    expect(r.stdout).toContain("apr,ok");
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-save", "doc-close", "fill-open", "fill-apply", "doc-save", "doc-close"]);
  });

  it("a thrown script exception on a dirty document keeps the exception text first", async () => {
    stub({ apply: () => "Error: boom\n    at main:3:1", close: () => JSON.stringify({ status: "dirty", uuid: "x" }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.stdout).toMatch(/boom.*has unsaved changes/);
    expect(r.stdout).toContain("leftOpen:");
  });
});

describe("fill: notes from the apply script", () => {
  it("land in the ok row after 'saved', separated by '; '", async () => {
    const note = "headline: text shrunk from 64 to 41 px to stay on ig-square";
    stub({ apply: () => ({ ...OK, notes: [note] }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--limit", "1"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`saved mar.af; ${note}`);
  });

  it("keep their place before the export note, and a reply without notes is tolerated", async () => {
    const note = "para: text shrunk from 32 to 19 px to fit its 400x120 frame";
    stub({ apply: (n) => (n === 1 ? { ...OK, notes: [note] } : ({ ...OK, notes: undefined } as unknown as ApplyReply)) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--export", "PNG"]));
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`saved mar\\.af; ${note}; exported mar\\.png`));
    expect(r.stdout).toContain("apr,ok");
  });
});

describe("templates new --args photo (J1)", () => {
  const cmd = makeTemplates(fakeConnect())["templates new"];
  const newArgs = (photo: string): string[] => ["ig-post", "--out", join(desktop, "x.af"), "--brand", BRAND_FILE, "--args", JSON.stringify({ photo })];

  it("accepts HEIC, HEIF and TIFF and reaches the script", async () => {
    server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
    server.onScript("affinity-axi:template ", JSON.stringify({ uuid: TPL_UUID, slots: ["photo", "headline", "sub", "cta"] }));
    server.onScript("affinity-axi:doc-save", (script) => {
      const path = quoted(script, "outPath");
      writeFileSync(path, `af:${path}`);
      return JSON.stringify({ status: "saved", uuid: TPL_UUID, path, dirty: false });
    });
    server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: TPL_UUID }));
    for (const name of ["x.heic", "y.HEIF", "z.tiff", "w.tif"]) {
      const photo = join(desktop, name);
      writeFileSync(photo, "img");
      const r = await runCommand(cmd, newArgs(photo));
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(scripts().filter((s) => s.includes("affinity-axi:template ig-post")).at(-1)).toContain(JSON.stringify(photo));
    }
  });

  it("a .gif is exit 2 with the new message, before connecting", async () => {
    const photo = join(desktop, "x.gif");
    writeFileSync(photo, "gif");
    const before = server.sessionsOpened();
    const r = await runCommand(cmd, newArgs(photo));
    expect(r.code).toBe(2);
    expect(r.stderr + r.stdout).toContain("photo must be the path of a .png, .jpg, .jpeg, .webp, .heic, .heif, .tif or .tiff file");
    expect(server.sessionsOpened()).toBe(before);
  });
});
