// The strict flag parser: every UsageError branch plus defaults, `--flag=value` and help short-circuits.

import { describe, expect, it } from "vitest";
import { parseArgs, positiveFlag, validFlagsHint } from "../src/cli/args.js";
import type { CommandSpec } from "../src/cli/spec.js";
import { UsageError } from "../src/output/errors.js";

const SPEC: CommandSpec = {
  name: "demo go",
  summary: "demo",
  args: [
    { name: "file", required: true, description: "input" },
    { name: "extra", required: false, description: "optional" },
  ],
  flags: [
    { name: "out", type: "string", description: "output" },
    { name: "mode", type: "string", values: ["fast", "slow"], default: "fast", description: "mode" },
    { name: "force", type: "boolean", description: "force" },
    { name: "keep", type: "boolean", default: false, description: "keep" },
  ],
  examples: ["demo go in.txt --force"],
};

const ROOT: CommandSpec = {
  name: "",
  summary: "root",
  flags: [{ name: "brief", type: "boolean", description: "b" }],
  examples: [],
};

function usage(argv: string[], spec: CommandSpec = SPEC): UsageError {
  try {
    parseArgs(argv, spec);
  } catch (err) {
    expect(err).toBeInstanceOf(UsageError);
    return err as UsageError;
  }
  throw new Error("expected a UsageError");
}

describe("parseArgs: success paths", () => {
  it("applies defaults, collects positionals and sets booleans", () => {
    const p = parseArgs(["in.txt", "--force"], SPEC);
    expect(p.positionals).toEqual(["in.txt"]);
    expect(p.flags).toEqual({ mode: "fast", keep: false, force: true });
    expect(p.help).toBe(false);
  });

  it("accepts both `--flag value` and `--flag=value`, including empty and embedded `=`", () => {
    expect(parseArgs(["a", "--out", "x.png"], SPEC).flags["out"]).toBe("x.png");
    expect(parseArgs(["a", "--out=y.png"], SPEC).flags["out"]).toBe("y.png");
    expect(parseArgs(["a", "--out="], SPEC).flags["out"]).toBe("");
    expect(parseArgs(["a", "--out=k=v"], SPEC).flags["out"]).toBe("k=v");
  });

  it("validates enumerated values in both forms", () => {
    expect(parseArgs(["a", "--mode", "slow"], SPEC).flags["mode"]).toBe("slow");
    expect(parseArgs(["a", "--mode=slow"], SPEC).flags["mode"]).toBe("slow");
  });

  it("treats a lone dash as a positional and keeps extra positionals", () => {
    expect(parseArgs(["a", "-", "b", "c"], SPEC).positionals).toEqual(["a", "-", "b", "c"]);
  });

  it("returns help without enforcing required arguments", () => {
    const p = parseArgs(["--help"], SPEC);
    expect(p.help).toBe(true);
    expect(p.positionals).toEqual([]);
  });

  it("works for a root spec without args or a name", () => {
    expect(parseArgs(["--brief"], ROOT).flags["brief"]).toBe(true);
  });
});

describe("parseArgs: usage errors", () => {
  it("rejects an unknown flag and names the command's valid flags", () => {
    const e = usage(["a", "--nope"]);
    expect(e.exitCode).toBe(2);
    expect(e.message).toBe("unknown flag --nope for 'demo go'");
    expect(e.suggestion).toBe("valid flags for 'demo go': --out, --mode, --force, --keep, --help");
  });

  it("reports an unknown flag without its inline value, and omits the scope for the root", () => {
    expect(usage(["--zip=1"], ROOT).message).toBe("unknown flag --zip");
    expect(usage(["--zip=1"], ROOT).suggestion).toBe("valid flags: --brief, --help");
    expect(usage(["a", "--zip=1"]).message).toBe("unknown flag --zip for 'demo go'");
  });

  it("rejects a value on a boolean flag", () => {
    const e = usage(["a", "--force=yes"]);
    expect(e.message).toBe("flag --force does not take a value");
    expect(e.suggestion).toContain("valid flags");
  });

  it("rejects a string flag with no value at the end or before another flag", () => {
    expect(usage(["a", "--out"]).message).toBe("flag --out requires a value");
    expect(usage(["a", "--out"]).suggestion).toBe("usage: --out <value> or --out=<value> (use the = form when the value starts with --)");
    expect(usage(["a", "--out", "--force"]).message).toBe("flag --out requires a value");
  });

  it("rejects a value outside the allowed list in both forms", () => {
    const e = usage(["a", "--mode", "warp"]);
    expect(e.message).toBe("invalid value 'warp' for --mode");
    expect(e.suggestion).toBe("valid values: fast, slow");
    expect(usage(["a", "--mode=warp"]).message).toBe("invalid value 'warp' for --mode");
  });

  it("rejects short flags with a note, with and without a scope", () => {
    const e = usage(["a", "-f"]);
    expect(e.message).toBe("unknown flag -f for 'demo go'");
    expect(e.suggestion).toContain("(short flags are not supported)");
    expect(usage(["-f"], ROOT).message).toBe("unknown flag -f");
  });

  it("names the first missing required argument with the first example", () => {
    const e = usage([]);
    expect(e.message).toBe("missing required argument <file> for 'demo go'");
    expect(e.suggestion).toBe("demo go in.txt --force");
  });

  it("falls back to a --help hint when the spec has no examples", () => {
    const bare: CommandSpec = { ...SPEC, examples: [] };
    expect(usage([], bare).suggestion).toBe("run 'demo go --help'");
  });
});

describe("validFlagsHint", () => {
  it("lists every flag plus --help, scoped to the command name", () => {
    expect(validFlagsHint(SPEC)).toBe("valid flags for 'demo go': --out, --mode, --force, --keep, --help");
    expect(validFlagsHint(ROOT)).toBe("valid flags: --brief, --help");
  });
});

describe("positiveFlag", () => {
  const flagsOf = (raw?: string) => ({ positionals: [], help: false, flags: raw === undefined ? {} : { x: raw } });
  const fail = (raw: string, opts: Parameters<typeof positiveFlag>[2]): UsageError => {
    try {
      positiveFlag(flagsOf(raw), "x", opts);
    } catch (e) {
      return e as UsageError;
    }
    throw new Error("expected a UsageError");
  };

  it("returns the fallback or undefined for an absent flag", () => {
    expect(positiveFlag(flagsOf(), "x", { fallback: 7, example: "7" })).toBe(7);
    expect(positiveFlag(flagsOf(), "x", { example: "7" })).toBeUndefined();
  });

  it("accepts digits with an optional fraction, whole only with integer", () => {
    expect(positiveFlag(flagsOf("3"), "x", { example: "3" })).toBe(3);
    expect(positiveFlag(flagsOf("8.5"), "x", { example: "3" })).toBe(8.5);
    expect(positiveFlag(flagsOf("3"), "x", { integer: true, example: "3" })).toBe(3);
    const e = fail("8.5", { integer: true, example: "3" });
    expect(e.exitCode).toBe(2);
    expect(e.message).toBe("invalid --x '8.5'");
    expect(e.suggestion).toBe("use a positive whole number, e.g. --x 3");
  });

  it.each(["0", "-3", "abc", "0x10", "1e3", " 5", "", "0.0"])("rejects %j", (raw) => {
    const e = fail(raw, { example: "3" });
    expect(e.exitCode).toBe(2);
    expect(e.message).toBe(`invalid --x '${raw}'`);
    expect(e.suggestion).toBe("use a positive number, e.g. --x 3");
  });

  it("rejects a boolean flag value", () => {
    expect(() => positiveFlag({ positionals: [], help: false, flags: { x: true } }, "x", { example: "3" })).toThrow(/invalid --x 'true'/);
  });
});
