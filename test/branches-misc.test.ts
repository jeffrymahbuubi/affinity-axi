// Branch cases for `assets`, the per-command help renderer and the home view that the feature
// tests do not reach: unreadable scans, odd script output, flags with defaults, missing --url.
// The home view runs against stub clients; the manifest scan is steered per test.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec } from "../src/cli/spec.js";
import { renderHelp } from "../src/cli/help.js";
import { make as makeAssets } from "../src/commands/assets.js";
import { make as makeHome, parseHomeInfo, rootHelp } from "../src/commands/home.js";
import { ConnectError, type AffinityClient, type ConnectFn, type ToolResult } from "../src/mcp/types.js";
import { version } from "../src/mcp/connect.js";
import { runCommand } from "./fake-mcp/client.js";

// The manifest scan is real unless a test asks for a failure or fixed rows.
const scan = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "throw-string" | "rows",
  rows: [] as Array<{ file: string; dir: string; madeBy: string; savedAt: string; fresh: string }>,
}));
vi.mock("../src/affinity/assets-scan.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/affinity/assets-scan.js")>();
  return {
    ...real,
    scanManifests: (dir: string, depth?: number) => {
      if (scan.mode === "throw") throw new Error("EACCES: permission denied");
      if (scan.mode === "throw-string") throw "not an error object";
      if (scan.mode === "rows") return scan.rows;
      return real.scanManifests(dir, depth);
    },
  };
});

let root: string;
const savedEnv = { url: process.env["AFFINITY_MCP_URL"], debug: process.env["AFFINITY_AXI_DEBUG"] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-branches-"));
  scan.mode = "real";
  scan.rows = [];
  delete process.env["AFFINITY_MCP_URL"];
  delete process.env["AFFINITY_AXI_DEBUG"];
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["AFFINITY_MCP_URL", savedEnv.url], ["AFFINITY_AXI_DEBUG", savedEnv.debug]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A saved .af with a hand-made manifest, like test/assets.test.ts writes. */
function seed(name: string, savedAt: string, dir = root): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "BYTES");
  writeFileSync(
    join(dir, name + ".axi.json"),
    JSON.stringify({
      schema: "affinity-axi/manifest/1",
      file: name,
      af: { sha256: "0".repeat(64), bytes: 5, savedAt, tool: "affinity-axi 0.1.0" },
      madeBy: null,
      history: [],
      exports: [],
      ai: { generated: false, records: 0 },
      inventory: null,
      notes: [],
    }),
  );
}

describe("assets: branch cases", () => {
  const assets = makeAssets().assets;

  it("builds without a connect function (the command is offline)", () => {
    expect(assets.spec.name).toBe("assets");
    expect(assets.spec.flags.map((f) => f.name)).toEqual(["dir"]);
  });

  it("scans the current directory when --dir is not given", async () => {
    seed("here.af", "2026-10-02T09:30:00.000Z");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const r = await runCommand(assets, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("assets[1]{file,madeBy,saved,fresh}:");
    expect(r.stdout).toContain("here.af");
    expect(r.stdout).toContain("2026-10-02T09:30Z");
  });

  it("prints a saved time that is not an ISO stamp as it is", async () => {
    seed("odd.af", "last tuesday");
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.stdout).toContain("last tuesday");
  });

  it("reports an empty directory with a pointer to the next step", async () => {
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`assets: none under ${root}`);
    expect(r.stdout).toContain("affinity-axi assets --dir <other-dir>");
  });

  it("caps the table at 30 rows and says how many are hidden", async () => {
    for (let i = 0; i < 32; i++) seed(`f${String(i).padStart(2, "0")}.af`, `2026-10-01T08:${String(i).padStart(2, "0")}:00.000Z`);
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.stdout).toContain("assets[30 of 32 total]{file,madeBy,saved,fresh}:");
    expect(r.stdout).toContain("note: 30 of 32 shown; narrow with --dir");
  });

  it("turns a scan failure into a usage error naming the directory", async () => {
    scan.mode = "throw";
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain(`error: cannot scan ${root}: EACCES: permission denied`);
    expect(r.stdout).toContain("suggestion: pass an existing directory with --dir");
  });

  it("stringifies a scan failure that is not an Error", async () => {
    scan.mode = "throw-string";
    const r = await runCommand(assets, ["--dir", root]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("cannot scan");
    expect(r.stdout).toContain("not an error object");
  });
});

const SPEC: CommandSpec = {
  name: "demo",
  summary: "Demo command",
  args: [{ name: "file", required: true, description: "input" }, { name: "extra", required: false, description: "optional" }],
  flags: [
    { name: "mode", type: "string", default: "fast", values: ["fast", "slow"], description: "speed" },
    { name: "keep", type: "boolean", default: false, description: "keep it" },
    { name: "out", type: "string", description: "output path" },
  ],
  examples: ["tool demo a.txt"],
};

describe("renderHelp: branch cases", () => {
  it("shows defaults, allowed values, arg requirement and examples", () => {
    const text = renderHelp("tool", SPEC);
    expect(text).toContain("command: tool demo");
    expect(text).toContain("summary: Demo command");
    expect(text).toContain("args[2]{name,required,description}:");
    expect(text).toContain("  file,yes,input");
    expect(text).toContain("  extra,no,optional");
    expect(text).toContain("flags[4]{flag,default,description}:");
    expect(text).toContain("  --mode,fast,speed (fast|slow)");
    expect(text).toContain("  --keep,false,keep it");
    expect(text).toContain("  --out,,output path");
    expect(text).toContain("  --help,,show this help");
    expect(text).toContain("examples[1]:\n  tool demo a.txt");
  });

  it("omits the args and examples blocks when the spec has none", () => {
    const text = renderHelp("tool", { name: "bare", summary: "Bare", flags: [], examples: [] });
    expect(text).not.toContain("args[");
    expect(text).not.toContain("examples[");
    expect(text).toContain("flags[1]{flag,default,description}:");
  });

  it("names just the tool for the root spec and skips the output sample", () => {
    const text = renderHelp("tool", { name: "", summary: "Root", flags: [], examples: [] });
    expect(text.split("\n")[0]).toBe("command: tool");
    expect(text).not.toContain("output[");
  });

  it("adds the first registry sample as an output block for a documented command", () => {
    const text = renderHelp("affinity-axi", { name: "render", summary: "Render", flags: [], examples: [] });
    expect(text).toContain("output[");
    expect(text).toContain("render: .affinity-axi/renders/<uuid8>-s0.jpg");
  });
});

describe("parseHomeInfo", () => {
  it("returns null for empty text, non-JSON, and JSON of the wrong shape", () => {
    expect(parseHomeInfo("")).toBeNull();
    expect(parseHomeInfo("\n  \n")).toBeNull();
    expect(parseHomeInfo("not json")).toBeNull();
    expect(parseHomeInfo('{"version":3,"documents":[]}')).toBeNull();
    expect(parseHomeInfo('{"version":"1.0"}')).toBeNull();
  });

  it("reads the last non-empty line and defaults desktop and current", () => {
    const info = parseHomeInfo('progress line\n{"version":"Affinity 3.3.1","documents":[]}\n');
    expect(info).toEqual({ version: "Affinity 3.3.1", desktop: "", current: null, documents: [] });
  });
});

const ok = (text: string): ToolResult => ({ isError: false, content: [{ type: "text", text }] });

function stub(callTool: AffinityClient["callTool"], baseUrl = "http://stub:1"): { connect: ConnectFn; closed: () => number } {
  let closed = 0;
  const client: AffinityClient = {
    baseUrl,
    serverInfo: { name: "Affinity", version: "1" },
    callTool,
    close: () => void closed++,
  };
  return { connect: async () => client, closed: () => closed };
}

const home = (connect: ConnectFn, cwd = root) => makeHome(connect, { cwd });
const doc = (uuid: string) => ({ uuid, title: "t", dirty: false, units: "Pixel", path: "" });
const info = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ version: "Affinity 3.3.1.4940 MacOS", desktop: "/d", current: null, documents: [], ...over });

describe("home: branch cases", () => {
  it("shows the script's first line when the home script fails, and still closes the client", async () => {
    const s = stub(async () => ({ isError: true, content: [{ type: "text", text: "ERROR: boom\nsecond line" }] }));
    const r = await runCommand(home(s.connect), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity: connected");
    expect(r.stdout).toContain("documents: unavailable (ERROR: boom)");
    expect(s.closed()).toBe(1);
  });

  it("says the script output was unexpected when it is not the JSON line", async () => {
    const s = stub(async () => ok("hello"));
    const r = await runCommand(home(s.connect), []);
    expect(r.stdout).toContain("unexpected script output");
  });

  it("notes a thrown script call, writing the reason to stderr only in debug mode", async () => {
    const s = stub(async () => {
      throw new Error("stream dropped");
    });
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const quiet = await runCommand(home(s.connect), ["--brief"]);
    expect(quiet.stdout).toContain("documents: unavailable (script call failed)");
    expect(err).not.toHaveBeenCalled();
    process.env["AFFINITY_AXI_DEBUG"] = "1";
    await runCommand(home(s.connect), ["--brief"]);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("[affinity-axi] home-info failed: stream dropped");
  });

  it("stringifies a thrown value that is not an Error", async () => {
    process.env["AFFINITY_AXI_DEBUG"] = "1";
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const s = stub(async () => {
      throw "plain";
    });
    await runCommand(home(s.connect), ["--brief"]);
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("home-info failed: plain");
  });

  it("keeps a version string with no digits as it is", async () => {
    const s = stub(async () => ok(info({ version: "dev build" })));
    const r = await runCommand(home(s.connect), []);
    expect(r.stdout).toContain("version: dev build");
  });

  it("points the render example at the first document when none is current, and at docs when there are none", async () => {
    const first = "abcdef12-0000-0000-0000-000000000000";
    const some = stub(async () => ok(info({ documents: [doc(first)] })));
    expect((await runCommand(home(some.connect), ["--brief"])).stdout).toContain("help: affinity-axi render abcdef12");
    const none = stub(async () => ok(info()));
    expect((await runCommand(home(none.connect), ["--brief"])).stdout).toContain("help: affinity-axi docs");
  });

  it("uses the current document for the render example when there is one", async () => {
    const a = "11111111-0000-0000-0000-000000000000";
    const b = "22222222-0000-0000-0000-000000000000";
    const s = stub(async () => ok(info({ documents: [doc(a), doc(b)], current: b })));
    expect((await runCommand(home(s.connect), ["--brief"])).stdout).toContain("render 22222222");
  });

  it("prints the --url value when the connection fails, unless the environment sets one", async () => {
    const refused: ConnectFn = async () => {
      throw new ConnectError("refused", "open Affinity");
    };
    process.env["AFFINITY_AXI_DEBUG"] = "1";
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    expect((await runCommand(home(refused), ["--url", "http://flag:9"])).stdout).toContain("url: http://flag:9");
    expect((await runCommand(home(refused), [])).stdout).toContain("url: http://[::1]:6767");
    process.env["AFFINITY_MCP_URL"] = "http://env:3";
    expect((await runCommand(home(refused), ["--url", "http://flag:9"])).stdout).toContain("url: http://env:3");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("connect failed: refused");
  });

  it("stringifies a connect failure that is not an Error", async () => {
    process.env["AFFINITY_AXI_DEBUG"] = "1";
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const r = await runCommand(home(async () => { throw "nope"; }), []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("affinity: unreachable");
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain("connect failed: nope");
  });

  it("prints the version and exits without connecting", async () => {
    const connect = vi.fn<ConnectFn>();
    const r = await runCommand(home(connect), ["--version"]);
    expect(r).toEqual({ code: 0, stdout: `affinity-axi: ${version()}\n` });
    expect(connect).not.toHaveBeenCalled();
  });

  it("falls back to the tool name in the header when argv has no script path", async () => {
    const argv = process.argv;
    process.argv = [argv[0]!];
    try {
      const r = await runCommand(home(async () => { throw new ConnectError("x", "y"); }), []);
      expect(r.stdout.split("\n")[0]).toMatch(/^affinity-axi: affinity-axi/);
    } finally {
      process.argv = argv;
    }
  });

  it("scans the process working directory when no cwd option is given", async () => {
    scan.mode = "rows";
    scan.rows = [];
    const r = await runCommand(makeHome(async () => { throw new ConnectError("x", "y"); }), ["--brief"]);
    expect(r.stdout).not.toContain("assets:");
  });
});

describe("home: assets line", () => {
  const dead: ConnectFn = async () => {
    throw new ConnectError("x", "y");
  };

  it("adds the count and a doc open help line to the full view, but only the count to --brief", async () => {
    seed("one.af", "2026-10-01T08:00:00.000Z", join(root, "sub"));
    const full = await runCommand(home(dead), []);
    expect(full.stdout).toContain("assets: 1 under ./");
    expect(full.stdout).toContain("affinity-axi doc open sub/one.af");
    const brief = await runCommand(home(dead), ["--brief"]);
    expect(brief.stdout).toContain("assets: 1 under ./");
    expect(brief.stdout).not.toContain("doc open");
  });

  it("shows nothing about assets when the scan fails or finds none", async () => {
    expect((await runCommand(home(dead), [])).stdout).not.toContain("assets:");
    scan.mode = "throw";
    expect((await runCommand(home(dead), [])).stdout).not.toContain("assets:");
  });

  it("falls back to the stored file name when it resolves to the working directory itself", async () => {
    scan.mode = "rows";
    scan.rows = [{ file: ".", dir: root, madeBy: "", savedAt: "2026-10-01T08:00:00.000Z", fresh: "none" }];
    const r = await runCommand(home(dead), []);
    expect(r.stdout).toContain("affinity-axi doc open .");
  });
});

describe("rootHelp", () => {
  it("returns the full tool reference", () => {
    expect(rootHelp()).toContain("commands[");
  });
});
