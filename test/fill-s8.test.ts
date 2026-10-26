// S8 fill findings: an open target is refused before anything is loaded (F-a), a failed save
// reports the filled copy as left open and names the template (F-a), and a fatal row reports
// the real elapsed ms (F-d). Fake MCP server; no Affinity.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { leftOpenHelp, saveFailNote, targetOpenNote } from "../src/commands/fill-parts.js";
import { FILL_OPEN, type ApplyReply } from "../src/affinity/fill-script.js";
import { connect } from "../src/mcp/connect.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-fill-s8-"));
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
const OK_REPLY: ApplyReply = { applied: ["headline"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline"] };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const markers = (): string[] =>
  scripts()
    .map((s) => /affinity-axi:([a-z-]+)/.exec(s)?.[1] ?? "?")
    .filter((m) => m !== "app-info");
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;

interface Stubs {
  /** Target file names (basenames) that count as open in Affinity. */
  openTargets?: string[];
  apply?: () => string | Promise<string>;
  close?: () => string;
  save?: (path: string) => string;
}

function stub(o: Stubs = {}): void {
  let opens = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:fill-open", (script) => {
    const target = quoted(script, "targetAf");
    if ((o.openTargets ?? []).includes(basename(target))) return JSON.stringify({ status: "target-open", uuid: uuidFor(900) });
    return JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) });
  });
  server.onScript("affinity-axi:fill-apply", async () => (o.apply ? await o.apply() : JSON.stringify(OK_REPLY)));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    if (o.save) return o.save(path);
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", () => (o.close ? o.close() : JSON.stringify({ status: "closed", uuid: "x" })));
}

function setup(): { template: string; data: string; out: string } {
  const template = join(desktop, "template.af");
  writeFileSync(template, "template");
  const data = join(work, "posts.json");
  writeFileSync(data, JSON.stringify([{ slug: "mug", headline: "Mug" }, { slug: "cup", headline: "Cup" }]));
  return { template, data, out: join(desktop, "c2") };
}
const argv = (t: string, d: string, o: string, extra: string[] = []): string[] => [t, "--data", d, "--key", "slug", "--out-dir", o, ...extra];

describe("fill: the target .af is open in Affinity (F-a)", () => {
  it("FILL_OPEN checks the target path first and loads nothing when it is open", () => {
    const s = FILL_OPEN("/home/x/Desktop/template.af", "/home/x/Desktop/c2/mug.af");
    expect(quoted(s, "target")).toBe("/home/x/Desktop/template.af");
    expect(quoted(s, "targetAf")).toBe("/home/x/Desktop/c2/mug.af");
    expect(s.indexOf("target-open")).toBeLessThan(s.indexOf("Document.load("));
    expect(s).toContain("status: 'already-open'");
  });

  it("fails the row with the open-target note, loads and closes nothing, exit 1; the rest are skipped", async () => {
    stub({ openTargets: ["mug.af"] });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("mug.af is open in Affinity; close it (doc save + doc close) or pick another --out-dir");
    expect(r.stdout).toContain("cup,skipped");
    expect(r.stdout).not.toContain("leftOpen");
    expect(markers()).toEqual(["fill-open"]);
    expect(r.stdout).toMatch(/mug,failed,,\d+,/);
  });

  it("--continue-on-error runs the next record", async () => {
    stub({ openTargets: ["mug.af"] });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("mug.af is open in Affinity");
    expect(r.stdout).toContain("cup,ok");
    expect(r.stdout).not.toContain("leftOpen");
    expect(markers()).toEqual(["fill-open", "fill-open", "fill-apply", "doc-save", "doc-close"]);
  });
});

describe("fill: a failed save leaves the filled copy open and says so (F-a)", () => {
  it("is fatal with the uuid: leftOpen, the template title, 'not saved', and the keep-a-copy help line", async () => {
    stub({ save: () => "Error: OPEN_IN_APP\n    at main:3:1" });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--continue-on-error"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
    expect(r.stdout).toMatch(/mug,failed,00000000,\d+,"?saving mug\.af failed: Error: OPEN_IN_APP; the filled copy is still open as 'template' \(not saved\)\./);
    expect(r.stdout).toContain("Do not save it over the template: doc save 00000000");
    expect(r.stdout).toContain(`${join(out, "mug.af")} once the file is closed`);
    expect(r.stdout).toContain("Don't Save");
    expect(r.stdout).toContain(`affinity-axi doc save 00000000 ${join(out, "_failed", "mug.af")} && affinity-axi doc close 00000000   # keep a left-open copy, then close it`);
    expect(r.stdout).toContain("cup,skipped");
    expect(markers()).toEqual(["fill-open", "fill-apply", "doc-save"]);
  });

  it("a failed close is fatal with the uuid as well", async () => {
    stub({ close: () => "Error: nope\n    at main:1:1" });
    const { template, data, out } = setup();
    const r = await runCommand(fill, argv(template, data, out, ["--limit", "1"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
  });

  it("the note helpers", () => {
    expect(targetOpenNote("mug")).toBe("mug.af is open in Affinity; close it (doc save + doc close) or pick another --out-dir");
    const note = saveFailNote("saving mug.af failed: Error: OPEN_IN_APP", "mug", "/home/x/Desktop/template.af", uuidFor(1).toUpperCase(), "/home/x/Desktop/c2");
    expect(note).toBe(
      "saving mug.af failed: Error: OPEN_IN_APP; the filled copy is still open as 'template' (not saved). Do not save it over the template: doc save 00000000 /home/x/Desktop/c2/mug.af once the file is closed, or close it in Affinity with Don't Save",
    );
    expect(leftOpenHelp("00000000-0000-4000-8000-000000000001", "mug", "/home/x/Desktop/c2")).toBe(
      "affinity-axi doc save 00000000 /home/x/Desktop/c2/_failed/mug.af && affinity-axi doc close 00000000   # keep a left-open copy, then close it",
    );
  });
});

describe("fill: a fatal row reports its real elapsed time (F-d)", () => {
  it("a timed-out apply has ms of about the timeout, not 0", async () => {
    stub({ apply: () => new Promise<never>(() => {}) });
    const { template, data, out } = setup();
    // The fake test client has no timeouts; the real transport does.
    const r = await runCommand(make(connect), argv(template, data, out, ["--timeout", "150", "--limit", "1"]));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("timed out after 150 ms");
    const m = /mug,failed,00000000,(\d+),/.exec(r.stdout);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(100);
    expect(r.stdout).toContain(`leftOpen: ${uuidFor(1).toUpperCase()}`);
  });
});
