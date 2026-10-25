import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { make, setupHook } from "../src/commands/setup.js";
import { dispatch, type Registry } from "../src/cli/router.js";
import { renderHelp } from "../src/cli/help.js";
import { fakeConnect, runCommand } from "./fake-mcp/client.js";

const BIN_A = "/opt/a/bin/affinity-axi.js";
const BIN_B = "/opt/b/bin/affinity-axi.js";

let dir: string;
let savedArgv1: string | undefined;
const target = () => join(dir, "hooks.json");
const readTarget = () => JSON.parse(readFileSync(target(), "utf8"));
const setup = (...args: string[]) => runCommand(setupHook, args);
const setupFile = (...args: string[]) => setup("--file", target(), ...args);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "axi-setup-"));
  savedArgv1 = process.argv[1];
  process.argv[1] = BIN_A;
});

afterEach(() => {
  process.argv[1] = savedArgv1 as string;
  rmSync(dir, { recursive: true, force: true });
});

describe("setup hook without --file", () => {
  it("prints the command and a note, and writes nothing", async () => {
    const r = await setup();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: session-start");
    expect(r.stdout).toContain(`command: ${BIN_A} --brief`);
    expect(r.stdout).toContain("note: add this command to your agent's session-start hook");
    expect(r.stdout).not.toContain("file:");
  });

  it("--check and --remove need --file", async () => {
    for (const flag of ["--check", "--remove"]) {
      const r = await setup(flag);
      expect(r.code).toBe(2);
      expect(r.stdout).toContain("needs --file");
    }
  });

  it("is reachable as `setup hook` and by the older `setup hooks` alias", async () => {
    const registry: Registry = {
      tool: "affinity-axi",
      root: setupHook,
      rootHelp: () => "",
      commands: { "setup hook": setupHook },
      aliases: { "setup hooks": "setup hook" },
    };
    for (const words of [["setup", "hook", "--check"], ["setup", "hooks", "--check"]]) {
      const r = await runCommand({ spec: setupHook.spec, run: () => dispatch(registry, [...words, "--file", target()]) }, []);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hook: not installed");
    }
  });
});

describe("setup hook --file", () => {
  it("creates the file in a fresh directory with the session-start entry", async () => {
    const r = await setupFile();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: installed");
    expect(r.stdout).toContain(`file: ${target()}`);
    expect(r.stdout).toContain(`command: ${BIN_A} --brief`);
    expect(readTarget()).toEqual({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${BIN_A} --brief` }] }] },
    });
  });

  it("creates missing parent folders", async () => {
    const nested = join(dir, "a", "b", "hooks.json");
    const r = await setup("--file", nested);
    expect(r.code).toBe(0);
    expect(existsSync(nested)).toBe(true);
  });

  it("second run is a no-op", async () => {
    await setupFile();
    const before = readFileSync(target(), "utf8");
    const r = await setupFile();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: already installed (no-op)");
    expect(readFileSync(target(), "utf8")).toBe(before);
  });

  it("repairs a stale bin path", async () => {
    await setupFile();
    process.argv[1] = BIN_B;
    const r = await setupFile();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: repaired bin path");
    const groups = readTarget().hooks.SessionStart;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks).toEqual([{ type: "command", command: `${BIN_B} --brief` }]);
  });

  it("preserves unrelated keys and hooks when installing", async () => {
    const existing = {
      env: { FOO: "bar" },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo pre" }] }],
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] }],
      },
    };
    writeFileSync(target(), JSON.stringify(existing, null, 2));
    await setupFile();
    const after = readTarget();
    expect(after.env).toEqual(existing.env);
    expect(after.hooks.PreToolUse).toEqual(existing.hooks.PreToolUse);
    expect(after.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(after.hooks.SessionStart).toHaveLength(2);
    expect(after.hooks.SessionStart[1].hooks[0].command).toBe(`${BIN_A} --brief`);
  });

  it("keeps an unrelated file byte for byte when only checking or removing an absent entry", async () => {
    const content = '{"env":{"A":"1"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo x"}]}]}}';
    writeFileSync(target(), content);
    for (const flag of ["--check", "--remove"]) {
      const r = await setupFile(flag);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("hook: not installed");
      expect(readFileSync(target(), "utf8")).toBe(content);
    }
  });

  it("detects an existing entry nested in a group with other hooks", async () => {
    const group = {
      matcher: "startup",
      hooks: [
        { type: "command", command: "echo hello" },
        { type: "command", command: `${BIN_A} --brief` },
      ],
    };
    writeFileSync(target(), JSON.stringify({ hooks: { SessionStart: [group] } }));
    const r = await setupFile();
    expect(r.stdout).toContain("already installed (no-op)");
    expect(readTarget().hooks.SessionStart).toEqual([group]);
  });

  it("recognises the bare `affinity-axi --brief` form and repairs it", async () => {
    writeFileSync(
      target(),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "affinity-axi --brief" }] }] } }),
    );
    const r = await setupFile();
    expect(r.stdout).toContain("hook: repaired bin path");
  });

  it("--check writes nothing and reports each state", async () => {
    let r = await setupFile("--check");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: not installed");
    expect(existsSync(target())).toBe(false);

    await setupFile();
    const before = readFileSync(target(), "utf8");
    r = await setupFile("--check");
    expect(r.stdout).toContain("hook: installed");
    process.argv[1] = BIN_B;
    r = await setupFile("--check");
    expect(r.stdout).toContain("hook: stale bin path");
    expect(readFileSync(target(), "utf8")).toBe(before);
  });

  it("--remove on an absent entry is a no-op with exit 0 and writes nothing", async () => {
    const r = await setupFile("--remove");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hook: not installed");
    expect(existsSync(target())).toBe(false);
  });

  it("--remove deletes only our entry and prunes empty containers", async () => {
    await setupFile();
    let r = await setupFile("--remove");
    expect(r.stdout).toContain("hook: removed");
    expect(readTarget()).toEqual({});

    const other = { matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] };
    writeFileSync(target(), JSON.stringify({ env: { A: "1" }, hooks: { SessionStart: [other] } }));
    await setupFile();
    r = await setupFile("--remove");
    expect(r.stdout).toContain("hook: removed");
    expect(readTarget()).toEqual({ env: { A: "1" }, hooks: { SessionStart: [other] } });
  });

  it("--key picks another dotted array and leaves the default one alone", async () => {
    const existing = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo keep" }] }] } };
    writeFileSync(target(), JSON.stringify(existing));
    let r = await setupFile("--key", "events.onStart");
    expect(r.stdout).toContain("hook: installed");
    const after = readTarget();
    expect(after.hooks).toEqual(existing.hooks);
    expect(after.events.onStart).toEqual([{ hooks: [{ type: "command", command: `${BIN_A} --brief` }] }]);

    r = await setupFile("--key", "events.onStart", "--check");
    expect(r.stdout).toContain("hook: installed");
    r = await setupFile("--check");
    expect(r.stdout).toContain("hook: not installed");

    r = await setupFile("--key", "events.onStart", "--remove");
    expect(r.stdout).toContain("hook: removed");
    expect(readTarget()).toEqual(existing);
  });

  it("invalid JSON exits 1 with the path and leaves the file untouched", async () => {
    writeFileSync(target(), "{ not json");
    const r = await setupFile();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error:");
    expect(r.stdout).toContain(target());
    expect(r.stdout).toContain("suggestion:");
    expect(readFileSync(target(), "utf8")).toBe("{ not json");
  });

  it("malformed shapes exit 1 and leave the file untouched", async () => {
    writeFileSync(target(), JSON.stringify({ hooks: { SessionStart: "nope" } }));
    let r = await setupFile();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not an array");

    const crossing = JSON.stringify({ hooks: "nope" });
    writeFileSync(target(), crossing);
    r = await setupFile();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("not an object");
    expect(readFileSync(target(), "utf8")).toBe(crossing);
  });

  it("rejects an empty segment in --key with exit 2", async () => {
    const r = await setupFile("--key", "hooks..x");
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("invalid --key");
  });
});

describe("setup hook help", () => {
  it("make() returns the same module and --help lists flags and examples", () => {
    expect(make(fakeConnect())).toBe(setupHook);
    const help = renderHelp("affinity-axi", setupHook.spec);
    for (const s of ["--file", "--key", "--check", "--remove", "affinity-axi setup hook --file ./hooks.json --check"]) {
      expect(help).toContain(s);
    }
  });
});
