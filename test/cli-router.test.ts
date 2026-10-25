// The generic router: alias resolution, grouped commands, help paths and error mapping.
// Uses a small in-memory registry so each branch is reached without Affinity.

import { describe, expect, it, vi } from "vitest";
import { dispatch, type CommandModule, type Registry } from "../src/cli/router.js";
import type { CommandSpec } from "../src/cli/spec.js";
import { AxiError, UsageError } from "../src/output/errors.js";

function spec(name: string): CommandSpec {
  return {
    name,
    summary: `summary of ${name}`,
    args: [{ name: "target", required: false, description: "what to act on" }],
    flags: [{ name: "loud", type: "boolean", description: "shout" }],
    examples: [`demo ${name}`],
  };
}

function mod(name: string, run?: CommandModule["run"]): CommandModule {
  return { spec: spec(name), run: run ?? ((p) => (p.flags["loud"] ? 7 : 0)) };
}

function registry(over: Record<string, CommandModule> = {}): Registry {
  return {
    tool: "demo",
    root: { spec: { name: "", summary: "home", flags: [], examples: [] }, run: () => 0 },
    rootHelp: () => "ROOT HELP",
    commands: {
      list: mod("list"),
      "tools add": mod("tools add"),
      "tools remove": mod("tools remove"),
      ...over,
    },
    aliases: { tools: "tools add", ls: "list" },
  };
}

/** A registry where `tools` is only a group (no alias), so bare `tools` has no command. */
function grouped(): Registry {
  const reg = registry();
  reg.aliases = { ls: "list" };
  return reg;
}

function capture(): { out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string | Uint8Array) => {
    err.push(String(s));
    return true;
  }) as typeof process.stderr.write);
  return { out: () => out.join(""), err: () => err.join("") };
}

describe("dispatch: resolution", () => {
  it("runs a one-word command and parses the remaining argv against its spec", async () => {
    const io = capture();
    expect(await dispatch(registry(), ["list", "x", "--loud"])).toBe(7);
    expect(io.out()).toBe("");
  });

  it("resolves a one-word alias to its two-word command", async () => {
    const seen: string[] = [];
    const reg = registry({ "tools add": mod("tools add", (p) => (seen.push(...p.positionals), 0)) });
    expect(await dispatch(reg, ["tools", "thing"])).toBe(0);
    expect(seen).toEqual(["thing"]);
  });

  it("prefers the two-word command over the alias, and resolves an alias for a single word", async () => {
    const hit: string[] = [];
    const reg = registry({
      "tools remove": mod("tools remove", () => (hit.push("remove"), 0)),
      "tools add": mod("tools add", () => (hit.push("add"), 0)),
      list: mod("list", () => (hit.push("list"), 0)),
    });
    await dispatch(reg, ["tools", "remove"]);
    await dispatch(reg, ["tools", "add", "y"]);
    await dispatch(reg, ["ls"]);
    expect(hit).toEqual(["remove", "add", "list"]);
  });

  it("runs the root with no words and prints the root help for --help", async () => {
    const io = capture();
    expect(await dispatch(registry(), [])).toBe(0);
    expect(io.out()).toBe("");
    expect(await dispatch(registry(), ["--help"])).toBe(0);
    expect(io.out()).toBe("ROOT HELP\n");
  });

  it("stops collecting command words at the first flag and parses it against the root", async () => {
    const io = capture();
    expect(await dispatch(registry(), ["--bogus"])).toBe(2);
    expect(io.out()).toContain("error: unknown flag --bogus");
  });
});

describe("dispatch: help and subcommand listings", () => {
  it("renders per-command help for a one-word and a two-word command", async () => {
    const io = capture();
    expect(await dispatch(registry(), ["list", "--help"])).toBe(0);
    expect(io.out()).toContain("command: demo list");
    expect(await dispatch(registry(), ["tools", "remove", "--help"])).toBe(0);
    expect(io.out()).toContain("command: demo tools remove");
    expect(io.out()).toContain("summary: summary of tools remove");
  });

  it("lists the subcommands of a group that is not itself a command, for --help", async () => {
    const io = capture();
    expect(await dispatch(grouped(), ["tools", "--help"])).toBe(0);
    expect(io.out()).toContain("commands[2]{command,summary}:");
    expect(io.out()).toContain("demo tools add,summary of tools add");
    expect(io.out()).toContain("demo tools remove,summary of tools remove");
  });

  it("exits 2 with the valid subcommands when a group is used bare", async () => {
    const io = capture();
    expect(await dispatch(grouped(), ["tools"])).toBe(2);
    expect(io.out()).toContain("error: 'tools' requires a subcommand");
    expect(io.out()).toContain("suggestion: valid: demo tools add, demo tools remove");
  });
});

describe("dispatch: errors", () => {
  it("exits 2 for an unknown command and lists top-level commands including aliases", async () => {
    const io = capture();
    expect(await dispatch(registry(), ["nope", "again"])).toBe(2);
    expect(io.out()).toContain("error: unknown command 'nope again'");
    expect(io.out()).toContain("suggestion: valid commands: list, ls, tools");
  });

  it("exits 2 for an unknown flag on a known command", async () => {
    const io = capture();
    expect(await dispatch(registry(), ["list", "--zzz"])).toBe(2);
    expect(io.out()).toContain("unknown flag --zzz for 'list'");
  });

  it("prints an AxiError with its own exit code and suggestion", async () => {
    const reg = registry({ list: mod("list", () => { throw new AxiError("boom", "try again"); }) });
    const io = capture();
    expect(await dispatch(reg, ["list"])).toBe(1);
    expect(io.out()).toBe("error: boom\nsuggestion: try again\n");
  });

  it("maps a UsageError thrown by a command to exit 2", async () => {
    const reg = registry({ list: mod("list", () => { throw new UsageError("bad use"); }) });
    const io = capture();
    expect(await dispatch(reg, ["list"])).toBe(2);
    expect(io.out()).toBe("error: bad use\n");
  });

  it("wraps an unexpected Error as exit 1 with the stack on stderr", async () => {
    const reg = registry({ list: mod("list", () => { throw new Error("kaput"); }) });
    const io = capture();
    expect(await dispatch(reg, ["list"])).toBe(1);
    expect(io.out()).toContain("error: unexpected failure: kaput");
    expect(io.out()).toContain("suggestion: re-run with the same arguments");
    expect(io.err()).toContain("kaput");
  });

  it("wraps a thrown non-Error value without writing a stack", async () => {
    const reg = registry({ list: mod("list", () => { throw "plain string"; }) });
    const io = capture();
    expect(await dispatch(reg, ["list"])).toBe(1);
    expect(io.out()).toContain("unexpected failure: plain string");
    expect(io.err()).toBe("");
  });

  it("wraps an Error that has no stack without writing to stderr", async () => {
    const reg = registry({
      list: mod("list", () => {
        const e = new Error("stackless");
        e.stack = undefined;
        throw e;
      }),
    });
    const io = capture();
    expect(await dispatch(reg, ["list"])).toBe(1);
    expect(io.out()).toContain("unexpected failure: stackless");
    expect(io.err()).toBe("");
  });

  it("awaits an async command and maps its rejection the same way", async () => {
    const reg = registry({ list: mod("list", async () => { throw new AxiError("late", "wait"); }) });
    capture();
    expect(await dispatch(reg, ["list"])).toBe(1);
  });
});
