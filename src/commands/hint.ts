import type { CommandModule } from "../cli/router.js";
import { print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { URL_FLAG, cutBlock, toolText, withClient } from "./docs.js";

function hintSearch(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "hint search",
      summary: "Search Affinity's SDK hints for a task (truncated at 1500 chars)",
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
      const head = `prompt: ${prompt}`;
      if (!text.trim()) {
        print([head, "hints: 0 results (no SDK hint matches this prompt)"].join("\n"));
        return 0;
      }
      const fullCommand = `affinity-axi hint search ${JSON.stringify(prompt)} --full`;
      print([head, ...cutBlock("hints", text.trimEnd(), parsed.flags["full"] === true, fullCommand)].join("\n"));
      return 0;
    },
  };
}

function hintAdd(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "hint add",
      summary: "Record a new SDK hint in Affinity (a mutation)",
      args: [{ name: "text", required: true, description: "the hint to record" }],
      flags: [URL_FLAG],
      examples: ['affinity-axi hint add "Set the current spread before editing nodes"'],
    },
    async run(parsed) {
      const hint = parsed.positionals.join(" ");
      await withClient(connect, parsed.flags, (c) =>
        toolText(c, "add_sdk_hint", { hint }, "check that Affinity is running with MCP enabled"),
      );
      print("hint: added");
      return 0;
    },
  };
}

/** Command modules keyed by registry path; alias "hint" -> "hint search" lives in the registry. */
export function make(connect: ConnectFn): Record<string, CommandModule> {
  return { "hint search": hintSearch(connect), "hint add": hintAdd(connect) };
}
