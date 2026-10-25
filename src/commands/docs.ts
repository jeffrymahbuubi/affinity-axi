import type { CommandModule } from "../cli/router.js";
import type { FlagSpec } from "../cli/spec.js";
import { classify, resultText } from "../affinity/result.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, print } from "../output/toon.js";
import { truncate, truncationNote } from "../output/truncate.js";
import { McpError, type AffinityClient, type ConnectFn } from "../mcp/types.js";

export const TEXT_LIMIT = 1500;

export const URL_FLAG: FlagSpec = {
  name: "url",
  type: "string",
  description: "Affinity MCP endpoint (AFFINITY_MCP_URL wins)",
};

/** Connects, runs `fn`, and always closes the client. */
export async function withClient<T>(
  connect: ConnectFn,
  parsedFlags: Record<string, string | boolean>,
  fn: (client: AffinityClient) => Promise<T>,
): Promise<T> {
  const url = parsedFlags["url"];
  const client = await connect(typeof url === "string" ? { url } : {});
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/** Calls a documentation or hint tool; tool-level errors become exit-1 errors. */
export async function toolText(
  client: AffinityClient,
  name: string,
  args: Record<string, unknown>,
  suggestion: string,
): Promise<string> {
  const r = await client.callTool(name, args);
  const text = resultText(r);
  const kind = classify(r).kind;
  if (r.isError || kind === "sdk-error" || kind === "not-allowed") {
    const msg = text.replace(/^ERROR:\s*/, "").trim().split("\n")[0] || `${name} failed`;
    throw new McpError(msg, suggestion);
  }
  return text.replace(/\r\n/g, "\n");
}

/** Indented, truncated text block with the exact `--full` command when cut. */
export function cutBlock(label: string, text: string, full: boolean, fullCommand: string): string[] {
  const t = full ? { text, truncated: false, totalChars: text.length } : truncate(text, TEXT_LIMIT);
  const out = [`${label}:`, ...t.text.split("\n").map((l) => "  " + l)];
  if (t.truncated) {
    out.push(truncationNote(t));
    out.push(helpBlock([fullCommand]));
  }
  return out;
}

// --- docs (list) ---------------------------------------------------------

/**
 * list_sdk_documentation text -> topic names. Live Affinity returns every name in one
 * comma-separated string with a trailing comma; a JSON array or one name per line also work.
 */
export function parseTopicNames(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // fall through to delimiter parsing
    }
  }
  return text
    .split(/[,\r\n]+/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
}

export interface TopicGroups {
  modules: string[];
  examples: string[];
  tests: string[];
  data: string[];
}

export function groupTopics(names: string[]): TopicGroups {
  const g: TopicGroups = { modules: [], examples: [], tests: [], data: [] };
  for (const n of names) {
    if (n.startsWith("examples/")) g.examples.push(n);
    else if (n.startsWith("tests/")) g.tests.push(n);
    else if (n.endsWith(".json")) g.data.push(n);
    else g.modules.push(n);
  }
  return g;
}

function docsList(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "docs list",
      summary: "List SDK documentation topics grouped as modules, examples, tests and data",
      flags: [URL_FLAG],
      examples: ["affinity-axi docs", "affinity-axi docs list"],
    },
    async run(parsed) {
      const names = await withClient(connect, parsed.flags, (c) =>
        toolText(c, "list_sdk_documentation", {}, "check that Affinity is running with MCP enabled").then(parseTopicNames),
      );
      const g = groupTopics(names);
      const firstModule = g.modules.find((m) => m !== "preamble") ?? "document.js";
      print(
        [
          emitBlock("modules", g.modules),
          emitBlock("examples", g.examples),
          emitBlock("tests", g.tests),
          emitBlock("data", g.data),
          helpBlock([
            `affinity-axi docs read ${firstModule} --grep <regex>`,
            `affinity-axi docs read ${firstModule} --lines 1-40`,
            'affinity-axi hint search "<what you want to do>"',
          ]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

// --- docs read -----------------------------------------------------------

function parseRange(value: string): [number, number] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(value);
  const a = m ? Number(m[1]) : 0;
  const b = m ? Number(m[2] ?? m[1]) : 0;
  if (!m || a < 1 || b < a) {
    throw new UsageError(`invalid --lines '${value}'`, "use 1-based inclusive ranges, e.g. --lines 10-40");
  }
  return [a, b];
}

function compileGrep(value: string): RegExp {
  try {
    return new RegExp(value);
  } catch {
    throw new UsageError(`invalid --grep regex '${value}'`, "pass a JavaScript regular expression, e.g. --grep \"export\\(\"");
  }
}

function docsRead(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "docs read",
      summary: "Read an SDK documentation topic, narrowed by --grep or --lines (truncated at 1500 chars)",
      args: [{ name: "file", required: true, description: "topic name from 'affinity-axi docs'" }],
      flags: [
        { name: "grep", type: "string", description: "keep only lines matching this regex, prefixed L<n>:" },
        { name: "lines", type: "string", description: "keep only this 1-based inclusive range, e.g. 10-40" },
        { name: "full", type: "boolean", description: "print everything instead of truncating at 1500 chars" },
        URL_FLAG,
      ],
      examples: [
        "affinity-axi docs read preamble",
        'affinity-axi docs read document.js --grep "export\\("',
        "affinity-axi docs read nodes.js --lines 1-60",
      ],
    },
    async run(parsed) {
      const file = parsed.positionals[0]!;
      const grepFlag = parsed.flags["grep"];
      const linesFlag = parsed.flags["lines"];
      const grep = typeof grepFlag === "string" ? compileGrep(grepFlag) : null;
      const range = typeof linesFlag === "string" ? parseRange(linesFlag) : null;

      const text = await withClient(connect, parsed.flags, (c) =>
        toolText(c, "read_sdk_documentation_topic", { filename: file }, "run 'affinity-axi docs' to list valid topic names"),
      );
      const all = text.split("\n");
      const meta = [`topic: ${file}`, `size: ${text.length} chars, ${all.length} lines`];

      let picked: Array<[number, string]> = all.map((l, i) => [i + 1, l]);
      if (range) {
        picked = picked.filter(([n]) => n >= range[0] && n <= range[1]);
        meta.push(`lines: ${range[0]}-${range[1]}`);
      }
      if (grep) {
        picked = picked.filter(([, l]) => grep.test(l));
        meta.push(`grep: ${grepFlag as string}`, `matches: ${picked.length}`);
      }
      const view = picked.map(([n, l]) => (grep ? `L${n}: ${l}` : l)).join("\n");

      const fullCommand = [
        "affinity-axi docs read",
        file.includes(" ") ? JSON.stringify(file) : file,
        ...(typeof grepFlag === "string" ? ["--grep", JSON.stringify(grepFlag)] : []),
        ...(typeof linesFlag === "string" ? ["--lines", linesFlag] : []),
        "--full",
      ].join(" ");
      const body = grep && picked.length === 0 ? [] : cutBlock("content", view, parsed.flags["full"] === true, fullCommand);
      print([...meta, ...body].join("\n"));
      return 0;
    },
  };
}

/** Command modules keyed by registry path; alias "docs" -> "docs list" lives in the registry. */
export function make(connect: ConnectFn): Record<string, CommandModule> {
  return { "docs list": docsList(connect), "docs read": docsRead(connect) };
}
