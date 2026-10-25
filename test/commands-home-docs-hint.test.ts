// Tests for the home view, docs, hint and the agent guide content, in-process against
// the fake MCP server (no Affinity needed).

import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type Registry } from "../src/cli/router.js";
import { make as makeDocs, parseTopicNames } from "../src/commands/docs.js";
import { make as makeHint } from "../src/commands/hint.js";
import { make as makeHome, rootHelp } from "../src/commands/home.js";
import { HOME_INFO } from "../src/affinity/scripts.js";
import { parseToon } from "../src/output/toon.js";
import { renderGuide } from "../src/guide/content.js";
import { DOC_LIST, DOC_NAMES, DOC_TOPICS, FIXTURE_APP, FIXTURE_DOCS, FIXTURE_UUID, FIXTURE_UUID_2 } from "./fake-mcp/fixtures.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

const AI_LINE = "ai: generative opt-in (--allow-generative); ml allowed";

const DEAD_URL = "http://127.0.0.1:1";
const connect = fakeConnect();

let server: FakeServer;
beforeEach(async () => {
  server = await startFakeServer();
});
afterEach(async () => {
  await server.close();
});

function stubHome(documents = FIXTURE_DOCS, current: string | null = FIXTURE_UUID): void {
  server.onScript(
    "affinity-axi:home-info",
    JSON.stringify({ version: FIXTURE_APP.version, desktop: FIXTURE_APP.desktop, current, documents }),
  );
}

// An empty folder, so assets that happen to exist in the repo never change the home view.
const emptyCwd = mkdtempSync(join(tmpdir(), "axi-home-"));
const home = () => makeHome(connect, { cwd: emptyCwd });
const docs = () => makeDocs(connect);
const hint = () => makeHint(connect);

describe("home", () => {
  it("HOME_INFO carries the marker the fake server keys on", () => {
    expect(HOME_INFO).toContain("/* affinity-axi:home-info */");
  });

  it("connected view lists documents, filesystem, ai and 2-4 help lines", async () => {
    stubHome();
    const r = await runCommand(home(), ["--url", server.url]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^affinity-axi: .*affinity-axi.*— /);
    expect(r.stdout).toContain("affinity: connected");
    expect(r.stdout).toContain(`url: ${server.url}`);
    expect(r.stdout).toContain("version: 3.3.1.4940\n");
    expect(r.stdout).toContain("documents[2]{uuid,title,dirty,units}:");
    expect(r.stdout).toContain(`  ${FIXTURE_UUID},<Untitled>,true,Millimetre`);
    expect(r.stdout).toContain(`  ${FIXTURE_UUID_2},logo.af,false,Pixel`);
    expect(r.stdout).toContain("filesystem: desktop-only");
    expect(r.stdout).toContain(AI_LINE);
    const help = /help\[(\d+)\]:/.exec(r.stdout);
    expect(Number(help?.[1])).toBeGreaterThanOrEqual(2);
    expect(Number(help?.[1])).toBeLessThanOrEqual(4);
    expect(r.stdout).toContain(`affinity-axi render ${FIXTURE_UUID.slice(0, 8)}`);
    expect(parseToon(r.stdout).ok).toBe(true);
  });

  it("presents generative AI only as a per-run opt-in, never as blocked or on by default", async () => {
    stubHome();
    const r = await runCommand(home(), ["--url", server.url]);
    expect(r.stdout).not.toContain("blocked-by-cli");
    // The only mention of generative is the opt-in flag line; no SDK identifiers leak.
    const mentions = r.stdout.split("\n").slice(1).filter((l) => /generat/i.test(l));
    expect(mentions).toEqual([AI_LINE]);
    expect(r.stdout).not.toMatch(/generateImage|generativeEditImage/);
  });

  it("reads the preamble before the single execute_script call", async () => {
    stubHome();
    await runCommand(home(), ["--url", server.url]);
    expect(server.calls.map((c) => c.name)).toEqual(["read_sdk_documentation_topic", "execute_script"]);
    expect(server.calls[0]!.args).toEqual({ filename: "preamble" });
  });

  it("zero open documents still shows an empty table and exits 0", async () => {
    stubHome([], null);
    const r = await runCommand(home(), ["--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("documents[0]{uuid,title,dirty,units}:");
    expect(r.stdout).not.toContain("affinity-axi render");
  });

  it("unreachable: exit 0, affinity: unreachable, fix and help block", async () => {
    const r = await runCommand(home(), ["--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity: unreachable");
    expect(r.stdout).toMatch(/^fix: .*Settings > Model Context Protocol > Enable MCP server/m);
    expect(r.stdout).toContain("help[2]:");
    expect(parseToon(r.stdout).ok).toBe(true);
  });

  it("a blank AFFINITY_MCP_URL does not win over --url in the unreachable view", async () => {
    const saved = process.env["AFFINITY_MCP_URL"];
    process.env["AFFINITY_MCP_URL"] = "  ";
    try {
      const r = await runCommand(home(), ["--url", DEAD_URL]);
      expect(r.stdout).toContain(`url: ${DEAD_URL}`);
    } finally {
      if (saved === undefined) delete process.env["AFFINITY_MCP_URL"];
      else process.env["AFFINITY_MCP_URL"] = saved;
    }
  });

  it("connected but unparseable script output degrades without failing", async () => {
    server.onScript("affinity-axi:home-info", "not json at all");
    const r = await runCommand(home(), ["--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity: connected");
    expect(r.stdout).toContain("documents: unavailable (");
    expect(r.stdout).toContain(AI_LINE);
  });

  it("--brief is at most 6 lines (connected)", async () => {
    stubHome();
    const r = await runCommand(home(), ["--brief", "--url", server.url]);
    const lines = r.stdout.trimEnd().split("\n");
    expect(r.code).toBe(0);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toBe("affinity: connected");
    expect(r.stdout).toContain("documents: 2 open");
    expect(r.stdout).toContain(AI_LINE);
    expect(lines.filter((l) => l.startsWith("help:")).length).toBe(1);
  });

  it("--brief is at most 6 lines (unreachable) and exits 0", async () => {
    const r = await runCommand(home(), ["--brief", "--url", DEAD_URL]);
    expect(r.code).toBe(0);
    expect(r.stdout.trimEnd().split("\n").length).toBeLessThanOrEqual(6);
    expect(r.stdout).toContain("affinity: unreachable");
  });

  it("--version prints without connecting", async () => {
    const r = await runCommand(home(), ["--version"]);
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(r.stdout).toBe(`affinity-axi: ${pkg.version}\n`);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("exports make and rootHelp for the registry", () => {
    expect(makeHome(fakeConnect()).spec.name).toBe("");
    expect(rootHelp()).toContain("docs read <file>");
    expect(rootHelp()).not.toMatch(/TODO|items/);
  });
});

describe("docs", () => {
  it("groups the live comma-separated listing into four sane groups", async () => {
    const r = await runCommand(docs()["docs list"]!, ["--url", server.url]);
    expect(r.code).toBe(0);
    const count = (g: string) => Number(new RegExp(`^${g}\\[(\\d+)\\]:`, "m").exec(r.stdout)?.[1]);
    expect(count("modules")).toBeGreaterThan(40);
    expect(count("examples")).toBeGreaterThan(20);
    expect(count("tests")).toBeGreaterThan(20);
    expect(count("data")).toBeGreaterThanOrEqual(3);
    expect(count("modules") + count("examples") + count("tests") + count("data")).toBe(DOC_NAMES.length);
    expect(r.stdout).toContain("examples/rectangle.js");
    expect(r.stdout).toContain("  hints.json");
    expect(r.stdout).toContain("  document.js");
    expect(parseToon(r.stdout).ok).toBe(true);
    for (const line of r.stdout.split("\n")) expect(line.length).toBeLessThan(120);
    const topics = r.stdout.split("\n").filter((l) => l.startsWith("  ") && !l.includes("affinity-axi"));
    for (const t of topics) expect(t.trim()).toMatch(/^[\w./-]+$/);
    expect(r.stdout).toMatch(/help\[3\]:\n {2}affinity-axi docs read \S+ --grep <regex>\n/);
  });

  it("one-per-line listings still group", async () => {
    const saved = DOC_LIST.splice(0, DOC_LIST.length, DOC_NAMES.join("\n"));
    try {
      const r = await runCommand(docs()["docs list"]!, ["--url", server.url]);
      expect(r.stdout).toContain("examples[37]:");
      expect(r.stdout).toContain("tests[37]:");
      expect(r.stdout).toContain("data[4]:");
    } finally {
      DOC_LIST.splice(0, DOC_LIST.length, ...saved);
    }
  });

  it("parseTopicNames handles JSON arrays, bullets, CRLF and stray delimiters", () => {
    expect(parseTopicNames('["a.js", "examples/b.js"]')).toEqual(["a.js", "examples/b.js"]);
    expect(parseTopicNames("a.js, b.js,\n")).toEqual(["a.js", "b.js"]);
    expect(parseTopicNames("- a.js\r\n* b.js\r\n\r\n")).toEqual(["a.js", "b.js"]);
    expect(parseTopicNames(",, a.js ,, ,b.js,")).toEqual(["a.js", "b.js"]);
    expect(parseTopicNames("")).toEqual([]);
  });

  it("read --grep returns only matching lines with L<n> prefixes", async () => {
    const r = await runCommand(docs()["docs read"]!, ["document.js", "--grep", "export\\(", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("matches: 2");
    expect(r.stdout).toContain("  L5:   export(path, options, a, b) { return true; }");
    expect(r.stdout).toContain("  L7: export function export(doc) {}");
    expect(r.stdout).not.toContain("class Document");
  });

  it("read --grep with no match reports matches: 0", async () => {
    const r = await runCommand(docs()["docs read"]!, ["document.js", "--grep", "zzz-nope", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("matches: 0");
    expect(r.stdout).not.toContain("content:");
  });

  it("read --lines returns the inclusive range", async () => {
    const r = await runCommand(docs()["docs read"]!, ["document.js", "--lines", "2-3", "--url", server.url]);
    expect(r.stdout).toContain("lines: 2-3");
    expect(r.stdout).toContain("  export class Document {");
    expect(r.stdout).toContain("  static get all()");
    expect(r.stdout).not.toContain("import { DocumentCommand");
    expect(r.stdout).not.toContain("static get current");
  });

  describe("truncation", () => {
    const big = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${"x".repeat(20)}`).join("\n");
    beforeEach(() => {
      DOC_TOPICS["big.js"] = big;
    });
    afterAll(() => {
      delete DOC_TOPICS["big.js"];
    });

    it("cuts at 1500 chars with total size and the exact --full command", async () => {
      const r = await runCommand(docs()["docs read"]!, ["big.js", "--url", server.url]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`size: ${big.length} chars, 200 lines`);
      expect(r.stdout).toContain(`... (truncated, ${big.length} chars total)`);
      expect(r.stdout).toContain("help[1]:\n  affinity-axi docs read big.js --full");
      expect(r.stdout).not.toContain("line 200 ");
    });

    it("the --full hint keeps the narrowing flags", async () => {
      const r = await runCommand(docs()["docs read"]!, ["big.js", "--grep", "line", "--url", server.url]);
      expect(r.stdout).toContain('affinity-axi docs read big.js --grep "line" --full');
    });

    it("--full prints everything without a truncation note", async () => {
      const r = await runCommand(docs()["docs read"]!, ["big.js", "--full", "--url", server.url]);
      expect(r.stdout).toContain("line 200 ");
      expect(r.stdout).not.toContain("truncated");
    });
  });

  it("unknown topic is an exit-1 error pointing at docs", async () => {
    const r = await runCommand(docs()["docs read"]!, ["nope.js", "--url", server.url]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error: .*nope\.js/m);
    expect(r.stdout).toContain("suggestion: run 'affinity-axi docs'");
  });

  it("invalid --lines and --grep are usage errors (exit 2) before any connection", async () => {
    const a = await runCommand(docs()["docs read"]!, ["document.js", "--lines", "9-2", "--url", server.url]);
    const b = await runCommand(docs()["docs read"]!, ["document.js", "--grep", "(", "--url", server.url]);
    expect(a.code).toBe(2);
    expect(b.code).toBe(2);
    expect(server.sessionsOpened()).toBe(0);
  });

  it("unreachable Affinity is a structured exit-1 error", async () => {
    const r = await runCommand(docs()["docs list"]!, ["--url", DEAD_URL]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error:");
    expect(r.stdout).toContain("suggestion:");
  });
});

describe("hint", () => {
  it("search prints the hint text", async () => {
    server.hints.push("Set the current spread before editing");
    const r = await runCommand(hint()["hint search"]!, ["rounded", "rectangle", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("prompt: rounded rectangle");
    expect(r.stdout).toContain("hints:\n  Set the current spread before editing");
    expect(server.calls.at(-1)).toMatchObject({ name: "search_sdk_hints", args: { prompt: "rounded rectangle" } });
  });

  it("search with no hints states the empty result", async () => {
    const r = await runCommand(hint()["hint search"]!, ["anything", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hints: 0 results");
  });

  it("search truncates long output and names the exact --full command", async () => {
    server.hints.push(...Array.from({ length: 120 }, (_, i) => `hint number ${i} ${"y".repeat(20)}`));
    const r = await runCommand(hint()["hint search"]!, ["spread", "--url", server.url]);
    expect(r.stdout).toContain("truncated");
    expect(r.stdout).toContain('affinity-axi hint search "spread" --full');
    const full = await runCommand(hint()["hint search"]!, ["spread", "--full", "--url", server.url]);
    expect(full.stdout).toContain("hint number 119");
  });

  it("add records the hint and prints hint: added with exit 0", async () => {
    const r = await runCommand(hint()["hint add"]!, ["Use", "Millimetre", "units", "--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("hint: added");
    expect(server.hints).toEqual(["Use Millimetre units"]);
  });

  it("add does not claim success when Affinity is unreachable", async () => {
    const r = await runCommand(hint()["hint add"]!, ["x", "--url", DEAD_URL]);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("hint: added");
  });
});

describe("--help", () => {
  it("answers without any network call for every command here", async () => {
    const reg: Registry = {
      tool: "affinity-axi",
      root: home(),
      rootHelp,
      commands: { ...docs(), ...hint() },
      aliases: { docs: "docs list", hint: "hint search" },
    };
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    const codes: number[] = [];
    try {
      for (const argv of [["--help"], ["docs", "--help"], ["docs", "read", "--help"], ["hint", "--help"], ["hint", "add", "--help"]]) {
        codes.push(await dispatch(reg, argv));
      }
    } finally {
      process.stdout.write = write;
    }
    expect(codes).toEqual([0, 0, 0, 0, 0]);
    expect(server.sessionsOpened()).toBe(0);
    const text = out.join("");
    expect(text).toContain("flags[");
    expect(text).toContain("examples[");
  });
});

describe("agent guide content", () => {
  it("is deterministic and free of scaffold leftovers", () => {
    const a = renderGuide();
    expect(renderGuide()).toBe(a);
    expect(a).not.toMatch(/TODO|demo|items list|npx -y affinity-axi/);
    expect(a.startsWith("# affinity-axi usage guide\n")).toBe(true);
    expect(a).not.toContain("---");
    expect(a).toContain(AI_LINE);
    expect(a).toContain("affinity: connected");
    expect(a).toContain("--allow-generative");
    expect(a).not.toContain("blocked-by-cli");
  });

  it("carries no machine-specific paths", () => {
    expect(renderGuide()).not.toContain(homedir());
  });
});
