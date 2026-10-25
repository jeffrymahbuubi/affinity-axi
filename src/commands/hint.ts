import type { CommandModule } from "../cli/router.js";
import { print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { URL_FLAG, cutBlock, toolText, withClient } from "./docs.js";

const PREAMBLE_CMD = "affinity-axi docs read preamble";
const SOURCE_LINE = "source: global pool (the answer is reworded on each call; hints you add are in the preamble, not here)";

function hintSearch(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "hint search",
      summary: "Ask Affinity's global SDK hint pool (other sessions' hints; a written answer, truncated at 1500 chars)",
      args: [{ name: "prompt", required: true, description: "what you are trying to do" }],
      flags: [
        { name: "full", type: "boolean", description: "print everything instead of truncating at 1500 chars" },
        URL_FLAG,
      ],
      examples: [
        'affinity-axi hint search "rounded rectangle with gradient fill"',
        'affinity-axi hint search "export preset names" --full',
      ],
    },
    async run(parsed) {
      const prompt = parsed.positionals.join(" ");
      const text = await withClient(connect, parsed.flags, (c) =>
        toolText(c, "search_sdk_hints", { prompt }, "check that Affinity is running with MCP enabled"),
      );
      const head = [`prompt: ${prompt}`, SOURCE_LINE];
      if (!text.trim()) {
        print([...head, "hints: 0 results (no SDK hint matches this prompt)", helpBlock([PREAMBLE_CMD])].join("\n"));
        return 0;
      }
      const fullCommand = `affinity-axi hint search ${JSON.stringify(prompt)} --full`;
      const body = cutBlock("hints", text.trimEnd(), parsed.flags["full"] === true, fullCommand);
      // A truncated block already ends with its own help block; fold the preamble line into it.
      const cutHelp = helpBlock([fullCommand]);
      const truncated = body[body.length - 1] === cutHelp;
      if (truncated) body.pop();
      print([...head, ...body, helpBlock(truncated ? [fullCommand, PREAMBLE_CMD] : [PREAMBLE_CMD])].join("\n"));
      return 0;
    },
  };
}

function hintAdd(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "hint add",
      summary: "Append a hint to this install's preamble (every new session reads it; hint search does not)",
      args: [{ name: "text", required: true, description: "the hint to record" }],
      flags: [URL_FLAG],
      examples: ['affinity-axi hint add "Set the current spread before editing nodes"'],
    },
    async run(parsed) {
      const text = parsed.positionals.join(" ").trimEnd();
      if (text.trim() === "") {
        throw new UsageError("hint text is empty", 'pass the hint as text: affinity-axi hint add "Set the current spread before editing nodes"');
      }
      // Affinity joins stored hints with no separator; start each one on its own line.
      const hint = text.startsWith("\n") ? text : "\n" + text;
      await withClient(connect, parsed.flags, (c) =>
        toolText(c, "add_sdk_hint", { hint }, "check that Affinity is running with MCP enabled"),
      );
      print(["hint: added", "stored: preamble (this install)", helpBlock([PREAMBLE_CMD])].join("\n"));
      return 0;
    },
  };
}

/** Command modules keyed by registry path; alias "hint" -> "hint search" lives in the registry. */
export function make(connect: ConnectFn): Record<string, CommandModule> {
  return { "hint search": hintSearch(connect), "hint add": hintAdd(connect) };
}
