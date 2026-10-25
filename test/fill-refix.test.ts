// `fill` re-fix (J4): when undo leaves the document dirty, the record is saved as a template
// copy under <out-dir>/_failed/<key>-<uuid8>.af with our manifest and a note naming the apply
// error, then closed through the unchanged DOC_CLOSE gate. The record is failed, not fatal.
// Fake MCP server; no Affinity.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { type ApplyReply } from "../src/affinity/fill-script.js";
import { readManifest } from "../src/affinity/manifest.js";
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

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-fill-refix-"));
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
const DIRTY: ApplyReply = { ...OK, applied: [], error: "axiSelectSubject: no subject found", cleaned: false };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const markers = (): string[] => scripts().map((s) => /affinity-axi:([a-z-]+)/.exec(s)?.[1] ?? "?").filter((m) => m !== "app-info");

interface Stub {
  apply: (n: number) => ApplyReply;
  save?: (path: string) => { status: string; dirty?: boolean; write?: boolean };
  close?: () => string;
}
const saves: string[] = [];

function stub(o: Stub): void {
  let opens = 0;
  let applies = 0;
  saves.length = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(["PNG"]));
  server.onScript("affinity-axi:fill-open", () => JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) }));
  server.onScript("affinity-axi:fill-apply", () => JSON.stringify(o.apply(++applies)));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    saves.push(path);
    const r = o.save ? o.save(path) : { status: "saved", dirty: false };
    if (r.write !== false && r.status === "saved") writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: r.status, uuid: "x", path, dirty: r.dirty ?? false });
  });
  server.onScript("affinity-axi:doc-close", () => (o.close ? o.close() : JSON.stringify({ status: "closed", uuid: "x" })));
}

function setup(): { template: string; data: string; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  const data = join(work, "posts.json");
  writeFileSync(data, JSON.stringify([{ slug: "mar", headline: "Spring" }, { slug: "apr", headline: "April" }]));
  return { template, data, out: join(desktop, "out") };
}
const argv = (t: string, d: string, o: string, extra: string[] = []): string[] => [t, "--data", d, "--key", "slug", "--out-dir", o, ...extra];

describe("fill: undo left the document dirty (J4 re-fix)", () => {
  it("saves a template copy under _failed/, closes it, and the record is failed but not fatal", async () => {
    stub({ apply: (n) => (n === 1 ? DIRTY : OK) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/apply failed: axiSelectSubject: no subject found \(undo left the document dirty; saved as _failed\/mar-[0-9A-F]{8}\.af and closed\)/);
    expect(r.stdout).toContain("mar,failed");
    expect(r.stdout).not.toContain("leftOpen:");
    expect(r.stdout).toContain(`failedCopies: ${join(out, "_failed")}`);
    expect(r.stdout).toContain(`rm -r ${join(out, "_failed")}   # template copies saved only so failed documents could be closed`);
    expect(r.stdout).toContain("apr,ok");
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-save", "doc-close", "fill-open", "fill-apply", "doc-save", "doc-close"]);

    const scratch = saves[0]!;
    expect(scratch.startsWith(join(out, "_failed") + "/")).toBe(true);
    expect(scratch).toMatch(/mar-00000000\.af$/);
    expect(existsSync(scratch)).toBe(true);
    const m = readManifest(scratch)!;
    expect(m.madeBy?.script).toBe("fill");
    expect(m.notes[0]!.text).toMatch(/^fill: apply failed: axiSelectSubject: no subject found/);
    expect(m.notes[0]!.text).toContain("saved only so the document could be closed");
  });

  it("without --continue-on-error the next record is skipped and the exit is 1", async () => {
    stub({ apply: () => DIRTY });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("mar,failed");
    expect(r.stdout).toContain("apr,skipped");
    expect(r.stdout).not.toContain("leftOpen:");
    expect(markers().filter((m) => m === "fill-open")).toHaveLength(1);
  });

  it("a copy that stays dirty after saveAs is fatal: left open, the apply error first", async () => {
    stub({ apply: () => DIRTY, save: () => ({ status: "saved", dirty: true }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
    expect(r.stdout).toMatch(/apply failed: axiSelectSubject: no subject found; could not save a copy/);
    expect(r.stdout).not.toContain("failedCopies:");
    expect(r.stdout).toContain("apr,skipped");
    expect(markers()).not.toContain("doc-close");
  });

  it("a copy that was not written is fatal as well", async () => {
    stub({ apply: () => DIRTY, save: () => ({ status: "saved", dirty: false, write: false }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out));
    expect(r.stdout).toContain("could not save a copy");
    expect(r.stdout).toContain("leftOpen:");
  });

  it("DOC_CLOSE answering dirty after a good copy is still fatal, apply error first", async () => {
    stub({ apply: () => DIRTY, close: () => JSON.stringify({ status: "dirty", uuid: "x" }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.stdout).toMatch(/apply failed: axiSelectSubject: no subject found \(undo left the document dirty;.*has unsaved changes/);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
    expect(r.stdout).toContain("apr,skipped");
  });

  it("a document that vanished before the copy is a failed row, nothing saved", async () => {
    stub({ apply: (n) => (n === 1 ? DIRTY : OK), save: (p) => (p.includes("_failed") ? { status: "missing" } : { status: "saved" }) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.stdout).toContain("mar,failed");
    expect(r.stdout).toContain("document vanished");
    expect(r.stdout).not.toContain("leftOpen:");
    expect(r.stdout).not.toContain("failedCopies:");
  });

  it("a cleaned document keeps today's path: no _failed folder, no copy", async () => {
    stub({ apply: (n) => (n === 1 ? { ...DIRTY, cleaned: true } : OK) });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.stdout).toContain("(changes undone)");
    expect(r.stdout).not.toContain("failedCopies:");
    expect(existsSync(join(out, "_failed"))).toBe(false);
    expect(markers().slice(0, 3)).toEqual(["fill-open", "fill-apply", "doc-close"]);
  });

  it("the run log records outcome exception with the scratch path", async () => {
    stub({ apply: (n) => (n === 1 ? DIRTY : OK) });
    const { template, data, out } = setup();
    await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    const run = readRuns(work)[0]!;
    expect(run.outcome).toBe("exception");
    expect(run.documents[0]!.path).toBe(saves[0]);
  });
});
