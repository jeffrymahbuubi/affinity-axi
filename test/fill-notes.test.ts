// `fill`: the refused-row note is short, the help block carries the --force line
// and the full `doc open` path; number flags take one strict form. Fake MCP server.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { parseToon } from "../src/output/toon.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-fill-notes-"));
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
const markers = (): string[] =>
  server.calls
    .filter((c) => c.name === "execute_script")
    .map((c) => /affinity-axi:([a-z-]+)/.exec(String(c.args["script"]))?.[1] ?? "?")
    .filter((m) => m !== "app-info");

const POSTS = JSON.stringify([
  { slug: "mar", headline: "Spring" },
  { slug: "apr", headline: "April" },
]);

function setup(outName = "out"): { template: string; data: string; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  const data = join(work, "posts.json");
  writeFileSync(data, POSTS);
  const out = join(desktop, outName);
  mkdirSync(out, { recursive: true });
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  return { template, data, out };
}

describe("fill refused rows", () => {
  it("the row note is short and never carries the path; the help block has --force and the full doc open path", async () => {
    const folder = "a-folder-name-long-enough-to-push-the-old-note-well-past-three-hundred-characters-";
    const { template, data, out } = setup(folder.repeat(2));
    const mar = join(out, "mar.af");
    writeFileSync(mar, "hand made");
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--limit", "1"]);
    expect(r.code).toBe(1);
    expect(parseToon(r.stdout).ok).toBe(true);
    const rowLine = r.stdout.split("\n").find((l) => l.startsWith("  mar,failed"))!;
    expect(rowLine).toContain("mar.af exists and was not saved by affinity-axi (no manifest); refusing to overwrite (--force to replace)");
    expect(rowLine).not.toContain("doc open");
    expect(rowLine).not.toContain(out);
    expect(rowLine.endsWith('"')).toBe(false);
    expect(r.stdout.split(`doc open ${mar}`)).toHaveLength(2);
    expect(r.stdout).toContain(`fill ${template} --data ${data} --key slug --out-dir ${out} --force   # replace the 1 refused .af: mar.af`);
    expect(markers()).toEqual([]);
    expect(readFileSync(mar, "utf8")).toBe("hand made");
  });

  it("with several refused rows the help names them but doc open names only the first", async () => {
    const { template, data, out } = setup();
    writeFileSync(join(out, "mar.af"), "x");
    writeFileSync(join(out, "apr.af"), "y");
    const r = await runCommand(fill, [template, "--data", data, "--key", "slug", "--out-dir", out, "--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("# replace the 2 refused .af: mar.af, apr.af");
    expect(r.stdout).toContain(`doc open ${join(out, "mar.af")}`);
    expect(r.stdout).not.toContain(`doc open ${join(out, "apr.af")}`);
  });
});

describe("fill number flags", () => {
  it("--limit 1.5, --timeout 1e3 and --limit 0x2 are usage errors with no connection", async () => {
    const { template, data, out } = setup();
    const base = [template, "--data", data, "--out-dir", out];
    expect((await runCommand(fill, [...base, "--limit", "1.5"])).code).toBe(2);
    const t = await runCommand(fill, [...base, "--timeout", "1e3"]);
    expect(t.code).toBe(2);
    expect(t.stdout).toContain("invalid --timeout '1e3'");
    expect((await runCommand(fill, [...base, "--limit", "0x2"])).code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });
});
