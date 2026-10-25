// Commands: library list, library read, library save.
// The Affinity library cannot overwrite: save is idempotent for identical code
// and an error for different code under an existing title.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import type { CommandSpec } from "../cli/spec.js";
import { refusalMessage, refusalSuggestion, scanForAi } from "../affinity/guard.js";
import { classify, resultText } from "../affinity/result.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, emitKV, emitList, print } from "../output/toon.js";
import { truncate, truncationNote } from "../output/truncate.js";
import type { AffinityClient, ConnectFn, ToolResult } from "../mcp/types.js";

const BIN = "affinity-axi";
const CODE_LIMIT = 1500;

const URL_FLAG = { name: "url", type: "string", description: "MCP server URL (default: AFFINITY_MCP_URL, else http://[::1]:6767)" } as const;

const LIST_SPEC: CommandSpec = {
  name: "library list",
  summary: "List titles in Affinity's script library",
  flags: [
    { name: "full", type: "boolean", description: "also print the raw server text" },
    URL_FLAG,
  ],
  examples: [`${BIN} library`, `${BIN} library list --full`],
};

const READ_SPEC: CommandSpec = {
  name: "library read",
  summary: "Read a library script; --out writes it to disk so the code stays out of context",
  args: [{ name: "title", required: true, description: "exact script title from 'library list'" }],
  flags: [
    { name: "out", type: "string", description: "write the code to this file and print only file, bytes, lines" },
    { name: "full", type: "boolean", description: "print the whole code instead of truncating" },
    URL_FLAG,
  ],
  examples: [`${BIN} library read "My script" --out scripts/my-script.js`, `${BIN} library read "My script" --full`],
};

const SAVE_SPEC: CommandSpec = {
  name: "library save",
  summary: "Save a script file into Affinity's library (identical title and code is a no-op; no overwrite)",
  args: [{ name: "file", required: true, description: "path to the script file" }],
  flags: [
    { name: "title", type: "string", description: "library title (required)" },
    { name: "description", type: "string", description: "library description (required)" },
    { name: "allow-generative", type: "boolean", description: "allow saving a script that references generative Canva AI APIs (nothing runs, nothing is logged)" },
    URL_FLAG,
  ],
  examples: [`${BIN} library save scripts/logo.js --title "Logo" --description "Draws the logo mark"`],
};

function quote(s: string): string {
  return /^[\w./:-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`;
}

function urlOf(parsed: Parsed): string | undefined {
  const v = parsed.flags["url"];
  return typeof v === "string" ? v : undefined;
}

function lineCount(code: string): number {
  if (code === "") return 0;
  return code.split("\n").length - (code.endsWith("\n") ? 1 : 0);
}

function norm(code: string): string {
  return code.replace(/\r\n/g, "\n").trimEnd();
}

/** Titles from list_library_scripts text: JSON array (strings or {title}), else one per line. */
export function parseTitles(text: string): string[] {
  const t = text.trim();
  if (t === "") return [];
  if (t.startsWith("[")) {
    try {
      const arr: unknown = JSON.parse(t);
      if (Array.isArray(arr)) {
        const titles: string[] = [];
        for (const item of arr) {
          if (typeof item === "string") titles.push(item);
          else if (item && typeof item === "object" && typeof (item as { title?: unknown }).title === "string") {
            titles.push((item as { title: string }).title);
          }
        }
        return titles;
      }
    } catch {
      // fall through to line parsing
    }
  }
  // Affinity 3.3 replies with one comma-separated line and a trailing comma
  // ("Title A, Title B, "). One title per line is also accepted. A title that
  // itself contains a comma can't be told apart in the comma form.
  return t
    .split(/\r?\n|,/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

function failIfError(r: ToolResult, what: string, suggestion: string): void {
  if (!r.isError) return;
  const msg = resultText(r).split("\n")[0]?.trim() || "no detail from server";
  throw new AxiError(`${what}: ${msg}`, suggestion);
}

async function withClient<T>(connect: ConnectFn, parsed: Parsed, fn: (c: AffinityClient) => Promise<T>): Promise<T> {
  const url = urlOf(parsed);
  const client = await connect(url ? { url } : {});
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function listTitles(client: AffinityClient): Promise<{ titles: string[]; raw: string }> {
  const r = await client.callTool("list_library_scripts", {});
  failIfError(r, "cannot list the library", `check Affinity is running; run '${BIN}' for status`);
  const raw = resultText(r);
  return { titles: parseTitles(raw), raw };
}

export function makeList(connect: ConnectFn): CommandModule {
  return {
    spec: LIST_SPEC,
    async run(parsed) {
      const { titles, raw } = await withClient(connect, parsed, listTitles);
      const out: string[] = [];
      if (titles.length === 0) {
        out.push("scripts: 0 results (Affinity script library)");
        out.push(helpBlock([`${BIN} library save <file> --title <t> --description <d>`]));
      } else {
        out.push(emitList("scripts", titles.map((title) => ({ title })), ["title"]));
        out.push(helpBlock([`${BIN} library read ${quote(titles[0]!)} --out <file>`]));
      }
      if (parsed.flags["full"]) out.push(emitBlock("raw", raw.split(/\r?\n/)));
      print(out.join("\n"));
      return 0;
    },
  };
}

export function makeRead(connect: ConnectFn): CommandModule {
  return {
    spec: READ_SPEC,
    async run(parsed) {
      const title = parsed.positionals[0]!;
      const code = await withClient(connect, parsed, async (client) => {
        const r = await client.callTool("read_library_script", { title });
        failIfError(r, `cannot read '${title}'`, `run '${BIN} library' to see the exact titles`);
        return resultText(r);
      });

      const out = parsed.flags["out"];
      if (typeof out === "string") {
        try {
          mkdirSync(dirname(out), { recursive: true });
          writeFileSync(out, code);
        } catch (err) {
          throw new AxiError(`cannot write ${out}: ${err instanceof Error ? err.message : String(err)}`, "choose a writable --out path");
        }
        print(
          [
            emitKV([
              ["file", out],
              ["bytes", Buffer.byteLength(code)],
              ["lines", lineCount(code)],
            ]),
            helpBlock([`${BIN} run ${quote(out)}`]),
          ].join("\n"),
        );
        return 0;
      }

      const t = parsed.flags["full"] ? { text: code, truncated: false, totalChars: code.length } : truncate(code, CODE_LIMIT);
      const lines = [emitKV([["title", title], ["lines", lineCount(code)]]), emitBlock("code", t.text.split("\n"))];
      if (t.truncated) lines.push(truncationNote(t));
      lines.push(
        helpBlock(
          t.truncated
            ? [`${BIN} library read ${quote(title)} --full`, `${BIN} library read ${quote(title)} --out <file>`]
            : [`${BIN} library read ${quote(title)} --out <file>`],
        ),
      );
      print(lines.join("\n"));
      return 0;
    },
  };
}

function requireString(parsed: Parsed, name: string): string {
  const v = parsed.flags[name];
  if (typeof v !== "string" || v.trim() === "") {
    throw new UsageError(`missing required flag --${name}`, SAVE_SPEC.examples[0]);
  }
  return v;
}

export function makeSave(connect: ConnectFn): CommandModule {
  return {
    spec: SAVE_SPEC,
    async run(parsed) {
      const file = parsed.positionals[0]!;
      const title = requireString(parsed, "title");
      const description = requireString(parsed, "description");

      let code: string;
      try {
        code = readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`cannot read file ${file}`, "pass the path of an existing script file");
      }

      // Guard first: refuse before any connection is opened.
      const hits = scanForAi(code);
      if (hits.length > 0 && parsed.flags["allow-generative"] !== true) {
        throw new AxiError(refusalMessage(hits[0]!), refusalSuggestion(`${BIN} library save ${quote(file)} --allow-generative ...`));
      }

      const result = await withClient(connect, parsed, async (client) => {
        const { titles } = await listTitles(client);
        if (titles.includes(title)) {
          const r = await client.callTool("read_library_script", { title });
          failIfError(r, `cannot read existing '${title}'`, `run '${BIN} library' to see the exact titles`);
          if (norm(resultText(r)) === norm(code)) return "noop" as const;
          throw new AxiError(
            `a different script is already saved as '${title}'`,
            "the Affinity library cannot overwrite; choose a new --title",
          );
        }
        const r = await client.callTool("save_script_to_library", { title, description, code });
        const outcome = classify(r);
        if (outcome.kind !== "ok") {
          const msg = outcome.text.split("\n")[0]?.trim() || "no detail from server";
          throw new AxiError(`save failed: ${msg}`, "the Affinity library cannot overwrite; choose a new --title");
        }
        return "saved" as const;
      });

      print(
        [
          emitKV([
            ["library", result === "noop" ? "already saved (no-op)" : "saved"],
            ["title", title],
          ]),
          helpBlock([`${BIN} library read ${quote(title)} --out <file>`]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

/** Command modules keyed by registry path; the registry also aliases "library" to "library list". */
export function make(connect: ConnectFn): Record<"library list" | "library read" | "library save", CommandModule> {
  return {
    "library list": makeList(connect),
    "library read": makeRead(connect),
    "library save": makeSave(connect),
  };
}
