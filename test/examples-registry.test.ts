import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EXAMPLES, examplesFor, outputSample } from "../src/examples/registry.js";
import { normalise } from "../src/examples/normalise.js";
import { isSideEffect } from "../src/examples/runner.js";

const toolDir = fileURLToPath(new URL("..", import.meta.url));
const bin = join(toolDir, "bin/affinity-axi.js");

function cli(...args: string[]) {
  return spawnSync("node", [bin, ...args], { encoding: "utf8" });
}

/** Shell-like split: whitespace separates, single and double quotes group. */
function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** Command paths in the root --help table, e.g. "doc save", "docs read". */
function registeredCommands(): string[] {
  const lines = cli("--help").stdout.split("\n");
  const start = lines.findIndex((l) => l.startsWith("commands["));
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  const rows = lines.slice(start + 1, end);
  const paths = rows.map((row) => {
    const cell = row.trim().startsWith('"') ? row.trim().slice(1).split('"')[0]! : row.trim().split(",")[0]!;
    return cell.split(" ").filter((w) => w && !w.startsWith("<") && !w.startsWith("[")).join(" ");
  });
  return paths.filter((p) => p !== "" && !p.startsWith("-"));
}

const tmp = mkdtempSync(join(tmpdir(), "axi-examples-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("examples registry", () => {
  it("has unique, folder-safe ids", () => {
    const ids = EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it("gives every entry commands that start with $BIN and 1 to 6 sample lines", () => {
    for (const e of EXAMPLES) {
      expect(e.commands.length, e.id).toBeGreaterThan(0);
      for (const c of e.commands) expect(c.startsWith("$BIN"), `${e.id}: ${c}`).toBe(true);
      expect(e.output.length, e.id).toBeGreaterThanOrEqual(1);
      expect(e.output.length, e.id).toBeLessThanOrEqual(6);
      expect(e.title.length, e.id).toBeGreaterThan(0);
      expect(e.summary, e.id).not.toContain("\n");
    }
  });

  it("covers every registered command with an example (pending counts)", () => {
    const features = new Set(EXAMPLES.map((e) => e.feature));
    const alias: Record<string, string> = { docs: "docs list" };
    const commands = registeredCommands();
    expect(commands.length).toBeGreaterThan(15);
    for (const c of commands) expect(features.has(alias[c] ?? c), `no example for '${c}'`).toBe(true);
  });

  it("covers the helper families; every feature is merged, so nothing is pending", () => {
    for (const f of ["helpers:text", "helpers:shapes", "helpers:image", "helpers:ml", "helpers:layout", "helpers:named"]) {
      expect(examplesFor(f).length, f).toBeGreaterThan(0);
    }
    const pending = EXAMPLES.filter((e) => e.pending).map((e) => e.feature).sort();
    expect(pending).toEqual([]);
  });

  it("covers area and size export", () => {
    expect(examplesFor("export").map((e) => e.id)).toEqual(["export", "export-area", "export-size", "export-budget", "export-alt"]);
  });

  it("outputSample caps at max and prefers a non-pending entry", () => {
    expect(outputSample("render")).toHaveLength(6);
    expect(outputSample("render", 2)).toEqual(["render: .affinity-axi/renders/<uuid8>-s0.jpg", "doc: <uuid>"]);
    expect(outputSample("no such command")).toEqual([]);
  });

  it("uses only the neutral demo brand (no real client name or palette)", () => {
    const text = JSON.stringify(EXAMPLES).toLowerCase();
    const sourceDir = join(toolDir, "src/examples");
    const sources = readdirSync(sourceDir).map((f) => readFileSync(join(sourceDir, f), "utf8").toLowerCase());
    const galleryDir = join(toolDir, "examples");
    const gallery: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "_run") walk(p); }
        else if (/\.(json|txt|md|js|sh)$/.test(name)) gallery.push(readFileSync(p, "utf8").toLowerCase());
      }
    };
    if (existsSync(galleryDir)) walk(galleryDir);
    const banned = [["pulo", "sari"].join(""), ["ko", "st"].join(""), "b5553a", "6f8f7a", "e0a84a", "f6efe6"];
    for (const term of banned) {
      expect(text.includes(term), `registry mentions ${term}`).toBe(false);
      expect(sources.some((s) => s.includes(term)), `src/examples mentions ${term}`).toBe(false);
      expect(gallery.some((s) => s.includes(term)), `gallery mentions ${term}`).toBe(false);
    }
    expect(text).toContain("lumen studio");
    expect(text).toContain("helvetica");
  });
});

describe("normalise", () => {
  const home = "/home/someone";

  it("replaces UUIDs, their short ids, timings, sizes and the home directory", () => {
    const raw = [
      "render: .affinity-axi/renders/70E876CB-s0.jpg",
      "doc: 70E876CB-1A2B-4C3D-8E9F-0123456789AB",
      "bytes: 48213",
      "ms: 1250",
      `saved: ${home}/Desktop/affinity-axi/demo.af`,
      "help[1]:",
      "  affinity-axi render 70E876CB",
    ].join("\n");
    expect(normalise(raw, { home })).toBe(
      [
        "render: .affinity-axi/renders/<uuid8>-s0.jpg",
        "doc: <uuid>",
        "bytes: <n>",
        "ms: <n>",
        "saved: ~/Desktop/affinity-axi/demo.af",
        "help[1]:",
        "  affinity-axi render <uuid8>",
      ].join("\n"),
    );
  });

  it("replaces counts inside tables by header name and in summaries", () => {
    const raw = [
      "batch[2]{key,status,doc,ms,note}:",
      "  a,ok,70E876CB-1A2B-4C3D-8E9F-0123456789AB,812,",
      '  b,failed,,0,"no, dice"',
      "summary: ok=1 failed=1 skipped=0 ms=2204",
      "exports[1]{artboard,path,bytes,size}:",
      "  og,/x/og.png,9001,1200x630",
    ].join("\n");
    expect(normalise(raw, { home })).toBe(
      [
        "batch[2]{key,status,doc,ms,note}:",
        "  a,ok,<uuid>,<n>,",
        '  b,failed,,<n>,"no, dice"',
        "summary: ok=1 failed=1 skipped=0 ms=<n>",
        "exports[1]{artboard,path,bytes,size}:",
        "  og,/x/og.png,<n>,1200x630",
      ].join("\n"),
    );
  });

  it("leaves other text and similar home prefixes alone and is idempotent", () => {
    const raw = "path: /home/someone2/x\nsize: 1080x1080 px @ 72 dpi";
    const once = normalise(raw, { home });
    expect(once).toBe(raw);
    expect(normalise(once, { home })).toBe(once);
  });
});

describe("--help output block", () => {
  it("ends render --help with output[6] after examples[3]", () => {
    const r = cli("render", "--help");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("examples[3]:");
    expect(r.stdout.indexOf("examples[3]:")).toBeLessThan(r.stdout.indexOf("output[6]:"));
    const tail = r.stdout.trimEnd().split("\n");
    expect(tail.slice(-7)[0]).toBe("output[6]:");
    expect(tail.slice(-6)[0]).toBe("  render: .affinity-axi/renders/<uuid8>-s0.jpg");
  });

  it("keeps examples[2] for run and shows the output block for each sampled command", () => {
    const run = cli("run", "--help").stdout;
    expect(run).toContain("examples[3]:");
    expect(run).toContain("output[4]:");
    expect(cli("platforms", "--help").stdout).toContain("output[3]:");
  });

  it("leaves a command without a sample unchanged", () => {
    // 'docs read' has a sample; the root help is a separate text and gets none.
    expect(cli("docs", "read", "--help").stdout).toContain("output[2]:");
    expect(cli("--help").stdout).not.toContain("output[");
  });
});

describe("offline samples match the real CLI", () => {
  // Side-effect examples (brand init writes a kit into the cwd) are never executed here.
  const offline = EXAMPLES.filter((e) => e.needs.length === 0 && !e.pending && !isSideEffect(e));

  it("has at least helpers, platforms and setup-hooks offline", () => {
    expect(offline.map((e) => e.id)).toEqual(expect.arrayContaining(["helpers", "platforms", "setup-hooks"]));
  });

  for (const e of offline) {
    it(`${e.id}: sample lines appear in order in the normalised output`, () => {
      const out = e.commands
        .map((c) => {
          const argv = tokenize(c.replaceAll("$OUT", tmp)).slice(1);
          return cli(...argv).stdout;
        })
        .join("\n");
      const lines = normalise(out).split("\n");
      let at = 0;
      for (const sample of e.output) {
        const found = lines.indexOf(sample, at);
        expect(found, `${e.id}: missing or out of order: ${sample}`).toBeGreaterThanOrEqual(0);
        at = found + 1;
      }
    });
  }
});
