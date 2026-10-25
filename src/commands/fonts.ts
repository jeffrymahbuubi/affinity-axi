// `fonts`: list installed fonts with their exact postscript names. SDK
// FontFamily.name / traitsName / weight are unreliable for variable fonts;
// postscriptName is the stable key.

import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import type { CommandSpec } from "../cli/spec.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const ROW_LIMIT = 40;
const TIMEOUT_MS = 60000;

/**
 * Logs a JSON array of [family, postscriptName, style] for every installed font.
 * Read-only: touches no document. The console.log is the only channel back from Affinity.
 */
export const LIST_FONTS = [
  "/* affinity-axi:list-fonts */",
  "const { FontFamily } = require('/fonts.js');",
  "const rows = [];",
  "for (const fam of FontFamily.all) {",
  "  let famName = '';",
  "  try { famName = String(fam.name || ''); } catch (e) { famName = ''; }",
  "  let fonts = [];",
  "  try { fonts = fam.fonts; } catch (e) { fonts = []; }",
  "  for (const f of fonts) {",
  "    try {",
  "      const ps = String(f.postscriptName || '');",
  "      if (ps === '') continue;",
  "      rows.push([String(f.familyName || famName), ps, String(f.traitsName || '')]);",
  "    } catch (e) { /* skip unreadable font */ }",
  "  }",
  "}",
  "console.log(JSON.stringify(rows));",
].join("\n");

const SPEC: CommandSpec = {
  name: "fonts",
  summary: "List installed fonts with exact postscript names (the reliable key for variable fonts)",
  flags: [
    { name: "grep", type: "string", description: "case-insensitive regex matched against family or postscript name" },
    { name: "family", type: "string", description: "exact family name (case-insensitive)" },
    { name: "full", type: "boolean", description: `print every matching row instead of the first ${ROW_LIMIT}` },
    { name: "url", type: "string", description: "MCP server URL (default: AFFINITY_MCP_URL, else http://[::1]:6767)" },
  ],
  examples: [`${BIN} fonts --grep fraunces`, `${BIN} fonts --family Nunito`, `${BIN} fonts --grep semibold --full`],
};

type FontRow = {
  family: string;
  postscript: string;
  style: string;
};

function shellQuote(s: string): string {
  return /^[\w./:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function str(parsed: Parsed, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Compiles --grep before any connection; an invalid regex is a usage error (exit 2). */
function compileGrep(grep: string): RegExp {
  try {
    return new RegExp(grep, "i");
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new UsageError(`invalid --grep regex '${grep}': ${why}`, `pass a valid regex, or escape characters such as ( [ with a backslash; plain words like 'source sans' always work`);
  }
}

function toRows(raw: unknown): FontRow[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rows: FontRow[] = [];
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    const [family, postscript, style] = item.map((v) => (typeof v === "string" ? v : ""));
    if (!postscript || seen.has(postscript)) continue;
    seen.add(postscript);
    // traitsName is often empty for variable fonts; fall back to the postscript suffix.
    const dash = postscript.indexOf("-");
    rows.push({ family: family ?? "", postscript, style: style || (dash >= 0 ? postscript.slice(dash + 1) : "") });
  }
  return rows.sort((a, b) => a.family.localeCompare(b.family) || a.postscript.localeCompare(b.postscript));
}

function describeFilter(grep: string | undefined, family: string | undefined): string {
  const parts: string[] = [];
  if (grep !== undefined) parts.push(`'${grep}'`);
  if (family !== undefined) parts.push(`family '${family}'`);
  return parts.join(" and ");
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: SPEC,
    async run(parsed) {
      const grep = str(parsed, "grep");
      const family = str(parsed, "family");
      const url = str(parsed, "url");
      const re = grep !== undefined ? compileGrep(grep) : undefined;

      const client = await connect(url ? { url } : {});
      let all: FontRow[];
      try {
        all = toRows(await callJson<unknown>(client, LIST_FONTS, "listing fonts", { timeoutMs: TIMEOUT_MS }));
      } finally {
        client.close();
      }

      const fam = family?.toLowerCase();
      const matches = all.filter(
        (r) => (fam === undefined || r.family.toLowerCase() === fam) && (re === undefined || re.test(r.family) || re.test(r.postscript)),
      );

      const flagBits = [
        grep !== undefined ? `--grep ${shellQuote(grep)}` : "",
        family !== undefined ? `--family ${shellQuote(family)}` : "",
        url ? `--url ${shellQuote(url)}` : "",
      ].filter((s) => s !== "");

      if (matches.length === 0) {
        const lines =
          grep === undefined && family === undefined
            ? [`fonts: 0 installed`]
            : [
                `fonts: 0 matching ${describeFilter(grep, family)} (${all.length} installed)`,
                helpBlock([`${BIN} fonts${url ? ` --url ${shellQuote(url)}` : ""} --full   # list every installed font`]),
              ];
        print(lines.join("\n"));
        return 0;
      }

      const full = parsed.flags["full"] === true;
      const shown = full ? matches : matches.slice(0, ROW_LIMIT);
      const help: string[] = [];
      if (shown.length < matches.length) {
        help.push(`${BIN} fonts ${[...flagBits, "--full"].join(" ")}   # all ${matches.length} rows`);
      }
      const ps = shown[0]!.postscript;
      help.push(
        `apply: const font = FontFamily.all.flatMap(f => f.fonts).find(f => f.postscriptName === '${ps}'); ` +
          `then StoryDelta.createFont(FontField.PostscriptName | FontField.FamilyName, font)`,
      );

      print(
        [
          emitList("fonts", shown, ["family", "postscript", "style"], { total: matches.length }),
          helpBlock(help),
        ].join("\n"),
      );
      return 0;
    },
  };
}
