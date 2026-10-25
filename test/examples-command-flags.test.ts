// `examples`: the flag and refusal paths that examples-command.test.ts leaves out
// (pending entries, --include-side-effects, --url, --run end to end with an offline command).
//
// The registry arrays are mutated in place for the duration of one test and restored afterwards;
// vitest gives each test file its own module instances, so no other file sees the change.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { make } from "../src/commands/examples.js";
import { EXAMPLES } from "../src/examples/registry.js";
import { SIDE_EFFECT_IDS } from "../src/examples/runner.js";
import type { Example } from "../src/examples/types.js";
import { ConnectError, type ConnectFn } from "../src/mcp/types.js";
import { runCommand } from "./fake-mcp/client.js";

const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(TOOL_DIR, "examples", "_run");
const noConnect: ConnectFn = async () => {
  throw new ConnectError("the examples command must not connect", "none");
};
const run = (argv: string[]) => runCommand(make(noConnect), argv);

/** An offline example: `platforms` needs no Affinity. */
function offline(over: Partial<Example> = {}): Example {
  return {
    id: "zz-f5-offline",
    feature: "platforms",
    title: "Offline demo",
    summary: "Runs an offline command",
    commands: ["$BIN platforms"],
    output: ["platforms[29]{key,size,ratio,notes}:"],
    images: [],
    needs: [],
    ...over,
  };
}

const mutable = EXAMPLES as Example[];
const added: string[] = [];
const replaced: Array<[number, Example]> = [];

/** Adds an example to the registry for the current test. */
function addExample(ex: Example): void {
  mutable.push(ex);
  added.push(ex.id);
}

/** Replaces the registry entry with the same id (so its gallery folder is real) for the current test. */
function replaceExample(ex: Example): void {
  const at = mutable.findIndex((e) => e.id === ex.id);
  expect(at).toBeGreaterThanOrEqual(0);
  replaced.push([at, mutable[at]!]);
  mutable[at] = ex;
}

afterEach(() => {
  for (const id of added.splice(0)) {
    const at = mutable.findIndex((e) => e.id === id);
    if (at >= 0) mutable.splice(at, 1);
  }
  for (const [at, original] of replaced.splice(0).reverse()) mutable[at] = original;
  const sideAt = SIDE_EFFECT_IDS.indexOf("zz-f5-offline");
  if (sideAt >= 0) (SIDE_EFFECT_IDS as string[]).splice(sideAt, 1);
  rmSync(join(SCRATCH, "zz-f5-offline"), { recursive: true, force: true });
  rmSync(join(SCRATCH, "batch"), { recursive: true, force: true });
});

describe("examples: pending entries", () => {
  it("marks a pending example in the list and the detail view, and refuses to run it", async () => {
    addExample(offline({ pending: true }));
    const list = await run([]);
    expect(list.stdout).toContain("  zz-f5-offline,platforms,Runs an offline command (pending),");
    const detail = await run(["zz-f5-offline"]);
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain("status: pending (the feature is not merged yet; there is nothing to run)");
    const live = await run(["zz-f5-offline", "--run"]);
    expect(live.code).toBe(1);
    expect(live.stdout).toContain("example 'zz-f5-offline' is pending: its feature is not merged yet");
  });

  it("shows `nothing (offline)` and no images block for an example with no needs and no images", async () => {
    addExample(offline());
    const detail = await run(["zz-f5-offline"]);
    expect(detail.stdout).toContain("needs: nothing (offline)");
    expect(detail.stdout).not.toContain("images[");
    expect(detail.stdout).toContain("affinity-axi examples --feature platforms");
  });
});

describe("examples: --feature", () => {
  it("matches a command and its sub-features written with a space or a colon", async () => {
    addExample(offline({ id: "zz-f5-offline", feature: "doc open" }));
    const doc = await run(["--feature", "DOC"]);
    expect(doc.stdout).toContain("  zz-f5-offline,doc open,");
    const exact = await run(["--feature", "doc open"]);
    expect(exact.stdout).toContain("  zz-f5-offline,doc open,");
    const colon = await run(["--feature", "helpers"]);
    expect(colon.stdout).not.toContain("zz-f5-offline");
    expect(colon.stdout).toContain("helpers:");
  });

  it("reports a zero-match feature with the total and a pointer back to the full list", async () => {
    const r = await run(["--feature", "no-such-feature"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`examples: 0 matching 'no-such-feature' (${EXAMPLES.length} known)`);
    expect(r.stdout).toContain("affinity-axi examples   # list every example");
  });

  it("rejects --run without an id before listing anything", async () => {
    const r = await run(["--run", "--feature", "export"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("--run needs an example id");
    expect(r.stdout).toContain("affinity-axi examples render --run");
  });
});

describe("examples --run: refusals before any spawn", () => {
  it("refuses a side-effect example without --include-side-effects and names the fix", async () => {
    addExample(offline());
    (SIDE_EFFECT_IDS as string[]).push("zz-f5-offline");
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("changes Affinity's stored state, so it is skipped by default");
    expect(r.stdout).toContain("affinity-axi examples zz-f5-offline --run --include-side-effects");
    const detail = await run(["zz-f5-offline"]);
    expect(detail.stdout).toContain("side-effects: changes Affinity's stored state");
  });

  it("refuses an example whose script folder is not in this install", async () => {
    addExample(offline({ script: "script.js" }));
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("has no script folder at examples/zz-f5-offline/ in this install");
    expect(r.stdout).toContain("run it from a checkout of the repository");
  });
});

describe("examples --run: end to end with an offline command", () => {
  it("runs the command through the built bin in the scratch folder and prints the real output", async () => {
    addExample(offline());
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$ affinity-axi platforms");
    expect(r.stdout).toContain("platforms[");
    expect(r.stdout).not.toContain("images[");
    expect(existsSync(join(SCRATCH, "zz-f5-offline"))).toBe(true);
  });

  it("runs a side-effect example once --include-side-effects is given", async () => {
    addExample(offline());
    (SIDE_EFFECT_IDS as string[]).push("zz-f5-offline");
    const r = await run(["zz-f5-offline", "--run", "--include-side-effects"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("platforms[");
  });

  it("passes --url to the spawned bin as AFFINITY_MCP_URL", async () => {
    addExample(offline({ commands: ["$BIN"] }));
    const r = await run(["zz-f5-offline", "--run", "--url", "http://127.0.0.1:1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("http://127.0.0.1:1");
  });

  it("lists the images that exist after the run, as absolute scratch paths", async () => {
    addExample(offline({ images: ["pic.png"] }));
    mkdirSync(join(SCRATCH, "zz-f5-offline"), { recursive: true });
    writeFileSync(join(SCRATCH, "zz-f5-offline", "pic.png"), "x");
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("images[1]:");
    expect(r.stdout).toContain(join(SCRATCH, "zz-f5-offline", "pic.png"));
  });

  it("stages the gallery folder's input files into the scratch folder before running", async () => {
    replaceExample(offline({ id: "batch", feature: "batch", script: "script.js" }));
    const r = await run(["batch", "--run"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(SCRATCH, "batch", "script.js"))).toBe(true);
    expect(existsSync(join(TOOL_DIR, "examples", "batch", "script.js"))).toBe(true);
  });

  it("fails with the stopped command, its kind and the pointer to the expected output", async () => {
    addExample(offline({ commands: ["$BIN platforms", "$BIN no-such-command"] }));
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("$ affinity-axi no-such-command");
    expect(r.stdout).toContain("error: example 'zz-f5-offline' stopped at 'affinity-axi no-such-command' (command): exit 2");
    expect(r.stdout).toContain("affinity-axi examples zz-f5-offline   # shows the expected commands and output");
    expect(r.stdout).not.toContain("may still be open");
  });

  it("fails when a declared image was not produced", async () => {
    addExample(offline({ images: ["missing.png"] }));
    const r = await run(["zz-f5-offline", "--run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("(images): missing image missing.png");
  });
});
