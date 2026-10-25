// `platforms`: list web and social image sizes (Oct 2026) from the table that
// also feeds axiPlatform(key) in the script helpers. Offline: never connects.

import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import type { CommandSpec } from "../cli/spec.js";
import { PLATFORMS, ratioOf, safeText } from "../affinity/platforms.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";

const BIN = "affinity-axi";

const SPEC: CommandSpec = {
  name: "platforms",
  summary: "List web and social image sizes with ratio, safe insets and notes (offline; axiPlatform(key) in --with-helpers scripts returns the same rows)",
  flags: [{ name: "grep", type: "string", description: "case-insensitive regex matched against key, size, ratio, safe insets or notes" }],
  examples: [`${BIN} platforms`, `${BIN} platforms --grep story`, `${BIN} platforms --grep "1.91|16:9"`],
};

function str(parsed: Parsed, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Compiles --grep before listing; an invalid regex is a usage error (exit 2). */
function compileGrep(grep: string): RegExp {
  try {
    return new RegExp(grep, "i");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new UsageError(`invalid --grep regex '${grep}': ${why}`, "pass a valid regex; plain words like 'story' always work");
  }
}

// `_connect` is unused on purpose: the registry builds every module the same way.
export function make(_connect: ConnectFn): CommandModule {
  return {
    spec: SPEC,
    run(parsed) {
      const grep = str(parsed, "grep");
      const re = grep !== undefined ? compileGrep(grep) : undefined;
      const rows = PLATFORMS.map((p) => ({ key: p.key, size: `${p.w}x${p.h}`, ratio: ratioOf(p.w, p.h), safe: safeText(p), notes: p.notes }));
      const shown = re ? rows.filter((r) => re.test(r.key) || re.test(r.size) || re.test(r.ratio) || re.test(r.safe) || re.test(r.notes)) : rows;

      if (shown.length === 0) {
        print([`platforms: 0 matching '${grep}' (${rows.length} known)`, helpBlock([`${BIN} platforms   # list every size`])].join("\n"));
        return 0;
      }
      const help = [`in a script: axiArtboards(doc, [{ platform: '${shown[0]!.key}' }])   # run with --with-helpers`];
      print([emitList("platforms", shown, ["key", "size", "ratio", "safe", "notes"], { total: rows.length }), helpBlock(help)].join("\n"));
      return 0;
    },
  };
}
