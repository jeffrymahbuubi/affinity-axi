// The `examples` command: offline list and detail, and the --run refusals that
// happen before any Affinity call.

import { describe, expect, it } from "vitest";
import { make } from "../src/commands/examples.js";
import { EXAMPLES } from "../src/examples/registry.js";
import { ConnectError, type ConnectFn } from "../src/mcp/types.js";
import { runCommand } from "./fake-mcp/client.js";

let connections = 0;
const noConnect: ConnectFn = async () => {
  connections++;
  throw new ConnectError("the examples command must not connect", "none");
};

const run = (argv: string[]) => runCommand(make(noConnect), argv);

describe("examples (offline)", () => {
  it("lists every registered example as examples[N]{id,feature,summary,needs}", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`examples[${EXAMPLES.length}]{id,feature,summary,needs}:`);
    expect(r.stdout).toContain("  render,render,Preview the current spread as a JPEG on disk,affinity;document");
    expect(r.stdout).not.toContain("(pending)");
    expect(r.stdout).toContain("help[2]:");
    expect(connections).toBe(0);
  });

  it("covers at least one row per command feature in the registry", async () => {
    const r = await run([]);
    for (const e of EXAMPLES) expect(r.stdout, e.id).toContain(`  ${e.id},`);
  });

  it("filters by feature, matching a command and its subcommands", async () => {
    const exp = await run(["--feature", "export"]);
    expect(exp.stdout).toContain(`examples[5 of ${EXAMPLES.length} total]`);
    const helpers = await run(["--feature", "helpers"]);
    expect(helpers.stdout).toContain("helpers:text");
    expect(helpers.stdout).toContain("  helpers,helpers,");
    const none = await run(["--feature", "zzz"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("examples: 0 matching 'zzz'");
  });

  it("shows one example's commands, sample output and image paths", async () => {
    const r = await run(["render"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("id: render");
    expect(r.stdout).toContain("feature: render");
    expect(r.stdout).toContain("commands[2]:");
    expect(r.stdout).toContain("  affinity-axi render $DOC --out examples/render/render.jpg");
    expect(r.stdout).toContain("sample[6]:");
    expect(r.stdout).toContain("  render: .affinity-axi/renders/<uuid8>-s0.jpg");
    expect(r.stdout).toContain("images[1]:\n  examples/render/render.jpg");
    expect(r.stdout).toContain("affinity-axi examples render --run");
    expect(connections).toBe(0);
  });

  it("flags side-effect examples in the detail view; merged features are not pending", async () => {
    expect((await run(["inspect"])).stdout).not.toContain("status: pending");
    expect((await run(["hint-add"])).stdout).toContain("--include-side-effects");
  });

  it("exits 2 for an unknown example and for --run without an id", async () => {
    const unknown = await run(["nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toContain("unknown example 'nope'");
    expect((await run(["--run"])).code).toBe(2);
  });

  it("refuses --run for side effects without the opt-in, before any call", async () => {
    const side = await run(["hint-add", "--run"]);
    expect(side.code).toBe(1);
    expect(side.stdout).toContain("--include-side-effects");
    expect(connections).toBe(0);
  });
});
