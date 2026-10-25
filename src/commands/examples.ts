// `examples [id] [--run] [--feature f]`: browse the examples registry offline,
// or run one example live. Without --run nothing connects. --run spawns the
// built bin through the shared runner, in the scratch folder examples/_run/<id>
// inside the tool tree (the gallery is never written), and prints the real output.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import type { CommandSpec } from "../cli/spec.js";
import { EXAMPLES } from "../examples/registry.js";
import { displayCommand, inputFiles, isSideEffect, runExample, SIDE_EFFECT_IDS } from "../examples/runner.js";
import type { Example } from "../examples/types.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, emitKV, emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";

const BIN = "affinity-axi";
const TOOL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SPEC: CommandSpec = {
  name: "examples",
  summary: "List the examples, show one's commands and sample output, or run it live (--run)",
  args: [{ name: "id", required: false, description: "example id from the list; omit to list them all" }],
  flags: [
    { name: "run", type: "boolean", description: "run the example live in the scratch folder examples/_run/<id> and print the real output" },
    { name: "feature", type: "string", description: "list only examples of this feature: a command ('export', 'doc') or a helper family ('helpers')" },
    { name: "include-side-effects", type: "boolean", description: `allow --run for examples that change Affinity's stored state (${SIDE_EFFECT_IDS.join(", ")})` },
    { name: "url", type: "string", description: "Affinity MCP URL for --run (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
  ],
  examples: [`${BIN} examples`, `${BIN} examples --feature export`, `${BIN} examples render`, `${BIN} examples render --run`],
};

function str(parsed: Parsed, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

function matchesFeature(ex: Example, feature: string): boolean {
  const f = feature.toLowerCase();
  const own = ex.feature.toLowerCase();
  return own === f || own.startsWith(f + ":") || own.startsWith(f + " ");
}

function listView(feature: string | undefined): string {
  const rows = EXAMPLES.filter((e) => feature === undefined || matchesFeature(e, feature)).map((e) => ({
    id: e.id,
    feature: e.feature,
    summary: e.pending ? `${e.summary} (pending)` : e.summary,
    needs: e.needs.join(";"),
  }));
  if (rows.length === 0) {
    return [`examples: 0 matching '${feature ?? ""}' (${EXAMPLES.length} known)`, helpBlock([`${BIN} examples   # list every example`])].join("\n");
  }
  const help = [`${BIN} examples ${rows[0]!.id}`, `${BIN} examples ${rows[0]!.id} --run   # needs Affinity`];
  return [emitList("examples", rows, ["id", "feature", "summary", "needs"], { total: EXAMPLES.length }), helpBlock(help)].join("\n");
}

function detailView(ex: Example): string {
  const parts = [
    emitKV([
      ["id", ex.id],
      ["feature", ex.feature],
      ["title", ex.title],
      ["summary", ex.summary],
      ["needs", ex.needs.join(";") || "nothing (offline)"],
    ]),
  ];
  if (ex.pending) parts.push("status: pending (the feature is not merged yet; there is nothing to run)");
  if (isSideEffect(ex)) parts.push("side-effects: changes Affinity's stored state; --run needs --include-side-effects");
  parts.push(emitBlock("commands", ex.commands.map((c) => displayCommand(c, ex.id))));
  parts.push(emitBlock("sample", ex.output));
  if (ex.images.length > 0) parts.push(emitBlock("images", ex.images.map((f) => `examples/${ex.id}/${f}`)));
  parts.push(helpBlock([`${BIN} examples ${ex.id} --run`, `${BIN} examples --feature ${ex.feature.split(/[: ]/)[0]}`]));
  return parts.join("\n");
}

/** Copies the example's input files (scripts, data, photos) from the gallery into the scratch folder. */
function stageInputs(ex: Example, galleryDir: string, scratch: string): void {
  mkdirSync(scratch, { recursive: true });
  for (const name of inputFiles(ex, galleryDir)) copyFileSync(join(galleryDir, name), join(scratch, name));
}

async function runLive(ex: Example, parsed: Parsed): Promise<number> {
  if (ex.pending) throw new AxiError(`example '${ex.id}' is pending: its feature is not merged yet`, `${BIN} examples   # list runnable examples`);
  if (isSideEffect(ex) && parsed.flags["include-side-effects"] !== true) {
    throw new AxiError(
      `example '${ex.id}' changes Affinity's stored state, so it is skipped by default`,
      `${BIN} examples ${ex.id} --run --include-side-effects`,
    );
  }
  const galleryDir = join(TOOL_DIR, "examples", ex.id);
  if (ex.script && !existsSync(join(galleryDir, ex.script))) {
    throw new AxiError(`example '${ex.id}' has no script folder at examples/${ex.id}/ in this install`, "run it from a checkout of the repository");
  }
  const scratch = join(TOOL_DIR, "examples", "_run", ex.id);
  stageInputs(ex, galleryDir, scratch);
  const url = str(parsed, "url");
  const result = runExample(ex, {
    bin: join(TOOL_DIR, "bin", "affinity-axi.js"),
    cwd: TOOL_DIR,
    outDir: scratch,
    env: url ? { AFFINITY_MCP_URL: url } : undefined,
  });
  print(result.output.trimEnd());
  if (result.images.length > 0) print(emitBlock("images", result.images.map((f) => join(scratch, f))));
  if (result.failed) {
    const f = result.failed;
    const left = f.leftOpen ? `; demo document ${f.leftOpen} may still be open: save it with 'doc save' then 'doc close'` : "";
    throw new AxiError(`example '${ex.id}' stopped at '${f.command}' (${f.kind}): ${f.message}${left}`, `${BIN} examples ${ex.id}   # shows the expected commands and output`);
  }
  return 0;
}

// `_connect` is unused on purpose: --run goes through the spawned bin, so this
// command never opens its own connection.
export function make(_connect: ConnectFn): CommandModule {
  return {
    spec: SPEC,
    async run(parsed) {
      const id = parsed.positionals[0];
      const feature = str(parsed, "feature");
      if (id === undefined) {
        if (parsed.flags["run"] === true) throw new UsageError("--run needs an example id", `${BIN} examples render --run`);
        print(listView(feature));
        return 0;
      }
      const ex = EXAMPLES.find((e) => e.id === id);
      if (!ex) throw new UsageError(`unknown example '${id}'`, `${BIN} examples   # lists the ids`);
      if (parsed.flags["run"] === true) return runLive(ex, parsed);
      print(detailView(ex));
      return 0;
    },
  };
}
