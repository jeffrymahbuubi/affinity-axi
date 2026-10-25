// `helpers`: list the axi* SDK helpers that `run --with-helpers` appends to a
// script. Offline: never connects to Affinity.

import type { CommandModule } from "../cli/router.js";
import { HELPERS_SOURCE, HELPER_INDEX } from "../affinity/helpers.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";

const BIN = "affinity-axi";

// `_connect` is unused on purpose: the registry builds every module the same way.
export function make(_connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "helpers",
      summary: "List the SDK helper functions that run --with-helpers adds to a script (offline)",
      flags: [
        { name: "source", type: "boolean", description: "print the full helper source instead of the index" },
        { name: "grep", type: "string", description: "case-insensitive regex matched against helper name, signature or summary" },
      ],
      examples: [`${BIN} helpers`, `${BIN} helpers --grep artboard`, `${BIN} helpers --source`, `${BIN} run scripts/card.js --with-helpers`],
    },
    run(parsed) {
      if (parsed.flags["source"] === true) {
        print(HELPERS_SOURCE.trim());
        return 0;
      }
      const grep = parsed.flags["grep"];
      let re: RegExp | undefined;
      if (typeof grep === "string") {
        try {
          re = new RegExp(grep, "i");
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new UsageError(`invalid --grep regex '${grep}': ${why}`, "pass a valid regex; plain words like 'image' always work");
        }
      }
      const all = HELPER_INDEX.map((h) => ({ ...h }));
      const rows = re ? all.filter((h) => re.test(h.name) || re.test(h.signature) || re.test(h.summary)) : all;
      if (rows.length === 0) {
        print([`helpers: 0 matching '${String(grep)}' (${all.length} known)`, helpBlock([`${BIN} helpers   # list every helper`])].join("\n"));
        return 0;
      }
      print([emitList("helpers", rows, ["name", "signature", "summary"], { total: all.length }), helpBlock([`${BIN} run <file> --with-helpers`, `${BIN} platforms   # sizes behind axiPlatform(key)`])].join("\n"));
      return 0;
    },
  };
}
