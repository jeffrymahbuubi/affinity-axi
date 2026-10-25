// `fill` cut-out alignment (align, padding): the options reach the apply script, a bad option is
// exit 2 before any connection. Fake MCP server; no Affinity.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/fill.js";
import { type ApplyReply } from "../src/affinity/fill-script.js";
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
  root = mkdtempSync(join(tmpdir(), "axi-fill-align-"));
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

function write(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const OK_REPLY: ApplyReply = { applied: ["photo"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:photo"] };
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const applies = (): string[] => scripts().filter((s) => s.includes("affinity-axi:fill-apply"));

function stub(): void {
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:fill-open", JSON.stringify({ status: "loaded", uuid: "00000000-0000-4000-8000-000000000001" }));
  server.onScript("affinity-axi:fill-apply", JSON.stringify(OK_REPLY));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = JSON.parse(/const outPath = (".*");/.exec(script)![1]!) as string;
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
}

function run(name: string, body: string) {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  writeFileSync(join(desktop, "photo.png"), "png");
  return runCommand(fill, [template, "--data", write(desktop, name, body), "--key", "slug", "--out-dir", join(desktop, "out")]);
}

describe("fill align and padding", () => {
  it("a cut-out record defaults to align centre in the apply script", async () => {
    stub();
    expect((await run("a.json", JSON.stringify([{ slug: "a", photo: { image: "photo.png", cutout: true } }]))).code).toBe(0);
    const [s] = applies();
    expect(s).toContain('"align":"centre"');
    expect(s).not.toContain('"padding"');
  });

  it('"align": "none" sends no align', async () => {
    stub();
    expect((await run("n.json", JSON.stringify([{ slug: "a", photo: { image: "photo.png", cutout: true, align: "none" } }]))).code).toBe(0);
    expect(applies()[0]).not.toContain('"align"');
  });

  it("fit with padding reaches the script", async () => {
    stub();
    expect((await run("f.json", JSON.stringify([{ slug: "a", photo: { image: "photo.png", cutout: "subject", align: "fit", padding: 40 } }]))).code).toBe(0);
    expect(applies()[0]).toContain('"align":"fit","padding":40');
  });

  it("a CSV cell requests no align", async () => {
    stub();
    expect((await run("p.csv", "slug,photo\na,photo.png\n")).code).toBe(0);
    expect(applies()[0]).not.toContain('"align"');
  });

  it("bad options are exit 2 with zero connections", async () => {
    stub();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ image: "photo.png", cutout: true, align: "fit", padding: -1 }, "padding must be a number of 0 or more"],
      [{ image: "photo.png", cutout: true, padding: 10 }, "padding needs align 'fit'"],
      [{ image: "photo.png", align: "centre" }, "align needs cutout"],
      [{ image: "photo.png", cutout: true, align: "left" }, "align must be 'none', 'centre' or 'fit'"],
    ];
    for (const [photo, msg] of cases) {
      const r = await run("b.json", JSON.stringify([{ slug: "a", photo }]));
      expect([r.code, server.sessionsOpened(), r.stdout.includes(msg)]).toEqual([2, 0, true]);
    }
    expect(scripts()).toEqual([]);
  });
});
