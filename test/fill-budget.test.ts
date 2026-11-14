// `fill --export <preset> --max-kb <n>`: the same ladder as `export --max-kb` per record
// (preset steps, then size steps), the row notes, the no-fit failure, the manifest entry and
// the usage errors that open no session. Fake MCP server; the exporter writes PNG bytes of a
// size taken from a schedule.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApplyReply } from "../src/affinity/fill-script.js";
import { NO_FIT_SUGGESTION } from "../src/affinity/export-budget.js";
import { readManifest } from "../src/affinity/manifest.js";
import { make } from "../src/commands/fill.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { FIXTURE_APP } from "./fake-mcp/fixtures.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const LIVE = [
  "PNG",
  "PNG-8 (dithered)",
  "JPEG (Best quality)",
  "JPEG (High quality)",
  "JPEG (Medium quality)",
  "JPEG (Low quality)",
  "PDF (digital - high quality)",
];
const HIGH = "JPEG (High quality)";
const LOW = "JPEG (Low quality)";

let server: FakeServer;
let root: string;
let work: string;
let desktop: string;
const origCwd = process.cwd();
const origUrl = process.env["AFFINITY_MCP_URL"];
const fill = make(fakeConnect());

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  root = mkdtempSync(join(tmpdir(), "axi-fill-budget-"));
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

function pngOf(width: number, height: number, bytes: number): Buffer {
  const b = Buffer.alloc(Math.max(33, bytes));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const OK_REPLY: ApplyReply = { applied: ["headline"], unknown: [], duplicate: [], mismatch: [], slots: ["slot:headline"], notes: [] };
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const quoted = (script: string, name: string): string => JSON.parse(new RegExp(`const ${name} = (".*");`).exec(script)![1]!) as string;
const field = (script: string, name: string): unknown => JSON.parse(new RegExp(`const ${name} = (.*);`).exec(script)![1]!);
const scripts = (): string[] => server.calls.filter((c) => c.name === "execute_script").map((c) => String(c.args["script"]));
const marked = (m: string): string[] => scripts().filter((s) => s.includes(`affinity-axi:${m}`));

/** Stubs the fill pipeline; every export (plain or area) takes its file size from `schedule` in order, the last one repeats. */
function stub(schedule: number[], boards: string[] = ["ig", "story"]): Array<{ preset: string; out: unknown }> {
  const seen: Array<{ preset: string; out: unknown }> = [];
  let opens = 0;
  let n = 0;
  server.onScript("affinity-axi:app-info", JSON.stringify({ ...FIXTURE_APP, desktop }));
  server.onScript("affinity-axi:list-presets", JSON.stringify(LIVE));
  server.onScript("affinity-axi:fill-open", () => JSON.stringify({ status: "loaded", uuid: uuidFor(++opens) }));
  server.onScript("affinity-axi:fill-apply", JSON.stringify(OK_REPLY));
  server.onScript("affinity-axi:doc-save", (script) => {
    const path = quoted(script, "outPath");
    writeFileSync(path, `af:${path}`);
    return JSON.stringify({ status: "saved", uuid: "x", path, dirty: false });
  });
  server.onScript("affinity-axi:doc-close", JSON.stringify({ status: "closed", uuid: "x" }));
  server.onScript("affinity-axi:list-artboards", JSON.stringify({ spreads: 1, artboards: boards.map((name, index) => ({ index, name })) }));
  const nextBytes = (): number => schedule[Math.min(n++, schedule.length - 1)]!;
  server.onScript("affinity-axi:export", (script) => {
    seen.push({ preset: field(script, "presetName") as string, out: "plain" });
    writeFileSync(quoted(script, "outPath"), pngOf(1080, 1080, nextBytes()));
    return "{}";
  });
  server.onScript("affinity-axi:area-export", (script) => {
    const out = field(script, "outSize") as { width: number; height: number } | null;
    const dim = out ?? { width: 1080, height: 1080 };
    seen.push({ preset: field(script, "presetName") as string, out });
    writeFileSync(quoted(script, "outPath"), pngOf(dim.width, dim.height, nextBytes()));
    return "{}";
  });
  return seen;
}

function setup(): { base: string[]; out: string } {
  const template = join(desktop, "post.af");
  writeFileSync(template, "template");
  writeFileSync(join(work, "posts.json"), JSON.stringify([{ slug: "mar", headline: "Spring" }, { slug: "apr", headline: "April" }]));
  const out = join(desktop, "out");
  return { base: [template, "--data", join(work, "posts.json"), "--key", "slug", "--out-dir", out], out };
}

describe("fill --export --max-kb", () => {
  it("a file that fits at once makes one export and a plain size note", async () => {
    const seen = stub([20_000]);
    const { base, out } = setup();
    const r = await runCommand(fill, [...base, "--export", HIGH, "--max-kb", "40", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported mar.jpg (19.5 KB)");
    expect(r.stdout).toContain("exported: 1");
    expect(r.stdout).toContain("budget_kb: 40");
    expect(seen).toHaveLength(1);
    expect(readFileSync(join(out, "mar.jpg")).length).toBe(20_000);
  });

  it("steps the preset until the file fits and records requested and attempts in the manifest", async () => {
    const seen = stub([90_000, 30_000]);
    const { base, out } = setup();
    const r = await runCommand(fill, [...base, "--export", HIGH, "--max-kb", "40", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported mar.jpg (29.3 KB at JPEG (Medium quality) 1080x1080, 2 attempts)");
    expect(seen.map((e) => e.preset)).toEqual([HIGH, "JPEG (Medium quality)"]);
    expect(seen.map((e) => e.out)).toEqual(["plain", null]);
    const e = readManifest(join(out, "mar.af"))!.exports[0]!;
    expect(e).toMatchObject({ preset: "JPEG (Medium quality)", size: "1080x1080", requested: HIGH, attempts: 2, bytes: 30_000 });
  });

  it("steps the size after the lowest preset, never below --min-scale", async () => {
    const seen = stub([90_000, 70_000, 30_000]);
    const { base } = setup();
    const r = await runCommand(fill, [...base, "--export", LOW, "--max-kb", "40", "--min-scale", "0.8", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported mar.jpg (29.3 KB at JPEG (Low quality) 864x864, 3 attempts)");
    expect(seen.map((e) => e.out)).toEqual(["plain", { width: 972, height: 972 }, { width: 864, height: 864 }]);
  });

  it("a record that cannot fit fails, keeps its smallest file and stops the run", async () => {
    const seen = stub([90_000, 80_000, 70_000]);
    const { base, out } = setup();
    const r = await runCommand(fill, [...base, "--export", LOW, "--max-kb", "40", "--min-scale", "0.8"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/mar,failed,/);
    expect(r.stdout).toContain("cannot fit mar.jpg under 40 KB (smallest 68.4 KB at JPEG (Low quality) 864x864)");
    expect(r.stdout).toMatch(/apr,skipped,/);
    expect(r.stdout).toContain("exported: 1");
    expect(r.stdout).toContain(NO_FIT_SUGGESTION);
    expect(existsSync(join(out, "mar.jpg"))).toBe(true);
    expect(readFileSync(join(out, "mar.jpg")).length).toBe(70_000);
    expect(existsSync(join(out, "mar.af"))).toBe(true);
    expect(readManifest(join(out, "mar.af"))!.exports[0]).toMatchObject({ attempts: 3, size: "864x864" });
    expect(seen).toHaveLength(3);
  });

  it("--continue-on-error processes the next record after a miss", async () => {
    stub([90_000]);
    const { base, out } = setup();
    const r = await runCommand(fill, [...base, "--export", LOW, "--max-kb", "40", "--min-scale", "0.8", "--continue-on-error"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/mar,failed,/);
    expect(r.stdout).toMatch(/apr,failed,/);
    expect(r.stdout).not.toMatch(/,skipped,/); // a skipped row, not the metadata note
    expect(r.stdout).toContain("exported: 2");
    expect(existsSync(join(out, "apr.jpg"))).toBe(true);
  });

  it("--all-artboards budgets each board on its own", async () => {
    const seen = stub([90_000, 20_000, 30_000]);
    const { base, out } = setup();
    const r = await runCommand(fill, [...base, "--export", HIGH, "--max-kb", "40", "--all-artboards", "--limit", "1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported 2 files (largest 29.3 KB, 1 stepped down)");
    expect(r.stdout).toContain("exported: 2");
    // board ig: High then Medium; board story: High fits at once
    expect(seen.map((e) => e.preset)).toEqual([HIGH, "JPEG (Medium quality)", HIGH]);
    expect(marked("export")).toHaveLength(0);
    expect(existsSync(join(out, "mar-ig.jpg"))).toBe(true);
    expect(existsSync(join(out, "mar-story.jpg"))).toBe(true);
  });

  it("without --max-kb the note and the number of export calls are as before", async () => {
    stub([90_000]);
    const { base } = setup();
    const r = await runCommand(fill, [...base, "--export", HIGH]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("exported mar.jpg");
    expect(r.stdout).not.toContain("KB");
    expect(r.stdout).not.toContain("budget_kb");
    expect(marked("export")).toHaveLength(2);
    expect(marked("area-export")).toHaveLength(0);
  });
});

describe("fill --max-kb usage errors (before connecting)", () => {
  it.each([
    ["--max-kb without --export", ["--max-kb", "40"]],
    ["a PDF preset", ["--export", "PDF (digital - high quality)", "--max-kb", "40"]],
    ["a bad --max-kb", ["--export", "PNG", "--max-kb", "abc"]],
    ["--min-scale alone", ["--export", "PNG", "--min-scale", "0.7"]],
  ])("%s is exit 2 and opens no session", async (_name, extra) => {
    stub([20_000]);
    const { base } = setup();
    const r = await runCommand(fill, [...base, ...extra]);
    expect(r.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("--max-kb without --export says what to add", async () => {
    stub([20_000]);
    const { base } = setup();
    const r = await runCommand(fill, [...base, "--max-kb", "40"]);
    expect(r.stdout).toContain("--max-kb needs --export <preset>");
  });

  it("the flags are listed in the help", () => {
    const names = fill.spec.flags.map((f) => f.name);
    expect(names).toContain("max-kb");
    expect(names).toContain("min-scale");
    expect(names.indexOf("max-kb")).toBe(names.indexOf("all-artboards") + 1);
  });
});
