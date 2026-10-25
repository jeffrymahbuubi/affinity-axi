// library list / read / save, in-process against the fake MCP server.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch, type Registry } from "../src/cli/router.js";
import { make, parseTitles } from "../src/commands/library.js";
import type { ConnectFn } from "../src/mcp/types.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";
import { startFakeServer, type FakeServer } from "./fake-mcp/server.js";

let server: FakeServer;
let dir: string;
let connects: number;

/** fakeConnect that counts how many connections the command opened. */
const counting: ConnectFn = (opts) => {
  connects++;
  return fakeConnect()(opts);
};

const mods = () => make(counting);
const libCalls = (name?: string) => server.calls.filter((c) => c.name.endsWith("_library_script") || c.name === "list_library_scripts" || c.name === "save_script_to_library").filter((c) => !name || c.name === name);

beforeEach(async () => {
  server = await startFakeServer();
  process.env["AFFINITY_MCP_URL"] = server.url;
  dir = mkdtempSync(join(tmpdir(), "axi-lib-"));
  connects = 0;
});

afterEach(async () => {
  delete process.env["AFFINITY_MCP_URL"];
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("library list", () => {
  it("prints the definitive empty state", async () => {
    const r = await runCommand(mods()["library list"], []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scripts: 0 results (Affinity script library)");
  });

  it("lists titles as a TOON table", async () => {
    server.library.set("Logo mark", { description: "d", code: "a" });
    server.library.set("Grid", { description: "d", code: "b" });
    const r = await runCommand(mods()["library list"], []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scripts[2]{title}:");
    expect(r.stdout).toContain("  Logo mark");
    expect(r.stdout).toContain("  Grid");
    expect(r.stdout).not.toContain("raw[");
  });

  it("keeps the raw server text behind --full", async () => {
    server.library.set("Grid", { description: "d", code: "b" });
    const r = await runCommand(mods()["library list"], ["--full"]);
    expect(r.stdout).toContain("raw[1]:");
  });

  it("honors --url over a missing environment", async () => {
    delete process.env["AFFINITY_MCP_URL"];
    const r = await runCommand(mods()["library list"], ["--url", server.url]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scripts: 0 results");
  });
});

describe("parseTitles", () => {
  it("handles empty, lines, JSON strings and JSON objects", () => {
    expect(parseTitles("")).toEqual([]);
    expect(parseTitles("  \n")).toEqual([]);
    expect(parseTitles("A\r\nB\n\nC")).toEqual(["A", "B", "C"]);
    // The live Affinity 3.3 format: comma-separated with a trailing comma.
    expect(parseTitles("Lumen Studio demo, ")).toEqual(["Lumen Studio demo"]);
    expect(parseTitles("Card A, Card B, ")).toEqual(["Card A", "Card B"]);
    expect(parseTitles('["A","B"]')).toEqual(["A", "B"]);
    expect(parseTitles('[{"title":"A","description":"x"},"B",3]')).toEqual(["A", "B"]);
    expect(parseTitles("[not json")).toEqual(["[not json"]);
  });
});

describe("library read", () => {
  const code = "console.log('hi');\nconsole.log('there');\n";

  it("--out writes the file and prints no code", async () => {
    server.library.set("Greeter", { description: "d", code });
    const out = join(dir, "sub", "greeter.js");
    const r = await runCommand(mods()["library read"], ["Greeter", "--out", out]);
    expect(r.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(code);
    expect(r.stdout).toContain(`file: ${out}`);
    expect(r.stdout).toContain(`bytes: ${Buffer.byteLength(code)}`);
    expect(r.stdout).toContain("lines: 2");
    expect(r.stdout).not.toContain("console.log");
  });

  it("without --out prints the code", async () => {
    server.library.set("Greeter", { description: "d", code });
    const r = await runCommand(mods()["library read"], ["Greeter"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("console.log('hi');");
    expect(r.stdout).not.toContain("truncated");
  });

  it("truncates long code with an exact --full hint, and --full prints it all", async () => {
    const long = "x".repeat(4000);
    server.library.set("Big one", { description: "d", code: long });
    const r = await runCommand(mods()["library read"], ["Big one"]);
    expect(r.stdout).toContain("(truncated, 4000 chars total)");
    expect(r.stdout).toContain('affinity-axi library read "Big one" --full');
    expect(r.stdout).not.toContain("x".repeat(2000));
    const full = await runCommand(mods()["library read"], ["Big one", "--full"]);
    expect(full.stdout).toContain(long);
    expect(full.stdout).not.toContain("truncated");
  });

  it("unknown title exits 1 with a structured error", async () => {
    const r = await runCommand(mods()["library read"], ["Nope"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error: cannot read 'Nope'/);
    expect(r.stdout).toContain("suggestion:");
    expect(r.stdout).not.toContain("isError");
  });

  it("missing title is a usage error (exit 2)", async () => {
    const r = await runCommand(mods()["library read"], []);
    expect(r.code).toBe(2);
    expect(connects).toBe(0);
  });
});

describe("library save", () => {
  const args = (file: string, title = "Logo") => [file, "--title", title, "--description", "A logo"];

  it("saves a new script", async () => {
    const f = script("logo.js", "console.log('logo');\n");
    const r = await runCommand(mods()["library save"], args(f));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("library: saved");
    expect(server.library.get("Logo")).toEqual({ description: "A logo", code: "console.log('logo');\n" });
    expect(libCalls("save_script_to_library")).toHaveLength(1);
  });

  it("identical existing title is a no-op without calling save_script_to_library", async () => {
    const f = script("logo.js", "console.log('logo');\n");
    server.library.set("Logo", { description: "old", code: "console.log('logo');\n" });
    const r = await runCommand(mods()["library save"], args(f));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("library: already saved (no-op)");
    expect(libCalls("save_script_to_library")).toHaveLength(0);
    expect(server.library.get("Logo")?.description).toBe("old");
  });

  it("ignores line-ending and trailing-whitespace differences when comparing", async () => {
    const f = script("logo.js", "a();\r\nb();\r\n");
    server.library.set("Logo", { description: "d", code: "a();\nb();" });
    const r = await runCommand(mods()["library save"], args(f));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("already saved (no-op)");
  });

  it("different code under an existing title exits 1 and never saves", async () => {
    const f = script("logo.js", "console.log('new');\n");
    server.library.set("Logo", { description: "d", code: "console.log('old');\n" });
    const r = await runCommand(mods()["library save"], args(f));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error: a different script is already saved as 'Logo'");
    expect(r.stdout).toContain("the Affinity library cannot overwrite; choose a new --title");
    expect(libCalls("save_script_to_library")).toHaveLength(0);
    expect(server.library.get("Logo")?.code).toBe("console.log('old');\n");
  });

  it("refuses SDK AI APIs with exit 1 and zero connections and calls", async () => {
    const f = script("bad.js", "const d = 1;\ndoc.generateImage('a cat');\n");
    const r = await runCommand(mods()["library save"], args(f));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error: script references SDK AI API generateImage at line 2/);
    expect(connects).toBe(0);
    expect(server.calls).toHaveLength(0);
    expect(server.sessionsOpened()).toBe(0);
    expect(server.library.size).toBe(0);
  });

  it("surfaces a server-side save error instead of claiming success", async () => {
    // Title not visible to the list parse, but the server rejects the duplicate.
    const f = script("logo.js", "console.log(1);\n");
    const orig = server.library;
    server.library.set("Logo", { description: "d", code: "other" });
    const mod = make(async (opts) => {
      const client = await fakeConnect()(opts);
      return {
        ...client,
        baseUrl: client.baseUrl,
        serverInfo: client.serverInfo,
        close: () => client.close(),
        callTool: async (name, a) =>
          name === "list_library_scripts" ? { isError: false, content: [] } : client.callTool(name, a),
      };
    })["library save"];
    const r = await runCommand(mod, args(f));
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^error: save failed: A script with that title already exists\./);
    expect(r.stdout).not.toContain("library: saved");
    expect(orig.get("Logo")?.code).toBe("other");
  });

  it("requires --title and --description (usage error, no connection)", async () => {
    const f = script("logo.js", "console.log(1);\n");
    const noTitle = await runCommand(mods()["library save"], [f, "--description", "d"]);
    expect(noTitle.code).toBe(2);
    expect(noTitle.stdout).toContain("--title");
    const noDesc = await runCommand(mods()["library save"], [f, "--title", "t"]);
    expect(noDesc.code).toBe(2);
    expect(connects).toBe(0);
  });

  it("missing file is a usage error (exit 2) with no connection", async () => {
    const r = await runCommand(mods()["library save"], args(join(dir, "missing.js")));
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("cannot read file");
    expect(connects).toBe(0);
    expect(existsSync(join(dir, "missing.js"))).toBe(false);
  });
});

describe("--help and flags via the router", () => {
  function registry(): Registry {
    const m = make(counting);
    return {
      tool: "affinity-axi",
      root: { spec: { name: "", summary: "root", flags: [], examples: [] }, run: () => 0 },
      rootHelp: () => "root help",
      commands: m,
      aliases: { library: "library list" },
    };
  }

  async function run(argv: string[]) {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string | Uint8Array) => (chunks.push(String(s)), true)) as typeof process.stdout.write;
    let code: number;
    try {
      code = await dispatch(registry(), argv);
    } finally {
      process.stdout.write = write;
    }
    return { code, stdout: chunks.join("") };
  }

  it.each([["library", "--help"], ["library", "list", "--help"], ["library", "read", "--help"], ["library", "save", "--help"]])(
    "%s makes no connection",
    async (...argv) => {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("--");
      expect(connects).toBe(0);
      expect(server.calls).toHaveLength(0);
      expect(server.sessionsOpened()).toBe(0);
    },
  );

  it("the 'library' alias lists", async () => {
    const r = await run(["library"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("scripts: 0 results");
  });

  it("an unknown flag exits 2 listing valid flags", async () => {
    const r = await run(["library", "read", "T", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--out");
    expect(connects).toBe(0);
  });
});
