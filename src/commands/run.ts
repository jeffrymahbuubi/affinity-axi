// `run <file.js>`: execute a script by path through execute_script.

import { readFileSync } from "node:fs";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { BRAND_FLAG, injectBrand, loadBrand, resolveBrandRef } from "../affinity/brand.js";
import { refusalMessage, refusalSuggestion, scanForAi, scanForBlocking } from "../affinity/guard.js";
import { withHelpers } from "../affinity/helpers.js";
import { appendProvenance, extractUuids, sha256 } from "../affinity/provenance.js";
import { appendRun } from "../affinity/runlog.js";
import type { BrandRef, RunRecord } from "../affinity/manifest-types.js";
import { classify, resultText } from "../affinity/result.js";
import { LIST_DOCUMENTS, injectArgs } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitBlock, emitKV, print } from "../output/toon.js";
import { truncate, truncationNote } from "../output/truncate.js";
import type { AffinityClient, ConnectFn } from "../mcp/types.js";

const OUTPUT_LIMIT = 1500;
const DEFAULT_TIMEOUT_MS = 60000;
const BIN = "affinity-axi";

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "") ?? "";
}

/**
 * Runs a helper script and parses the JSON it logged (the last non-empty
 * line). Any non-ok outcome or unparsable output becomes an AxiError.
 */
export async function callJson<T>(
  client: AffinityClient,
  script: string,
  what: string,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const result = await client.callTool("execute_script", { script }, opts);
  const outcome = classify(result);
  if (outcome.kind !== "ok") {
    throw new AxiError(`${what} failed: ${firstLine(resultText(result))}`, "check that Affinity is responsive and a document is open");
  }
  const lines = outcome.text.split("\n").filter((l) => l.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last) as T;
  } catch {
    throw new AxiError(`${what} returned unreadable output`, "re-run; if it persists report it with 'affinity-axi hint add'");
  }
}

export interface DocListing {
  current: string | null;
  documents: Array<{ uuid: string; path: string }>;
}

/** The open documents and the current one, or null when they cannot be read (best effort). */
export async function listDocs(client: AffinityClient): Promise<DocListing | null> {
  try {
    const r = await client.callTool("execute_script", { script: LIST_DOCUMENTS });
    const lines = resultText(r).split("\n").filter((l) => l.trim() !== "");
    const v = JSON.parse(lines[lines.length - 1] ?? "") as { current: string | null; documents?: Array<{ uuid: string; path?: string }> };
    return {
      current: v.current ?? null,
      documents: (v.documents ?? []).map((d) => ({ uuid: String(d.uuid), path: d.path ?? "" })),
    };
  } catch {
    return null;
  }
}

/**
 * The documents a run touched: UUIDs in its output plus the current document
 * (as provenance does), each with the saved path from the listing ("" when unsaved).
 */
export function runDocuments(text: string, listing: DocListing | null): Array<{ uuid: string; path: string }> {
  const uuids = extractUuids(text);
  const cur = listing?.current?.toUpperCase();
  if (cur && !uuids.includes(cur)) uuids.push(cur);
  return uuids.map((uuid) => ({
    uuid,
    path: listing?.documents.find((d) => d.uuid.toUpperCase() === uuid)?.path ?? "",
  }));
}

/** Appends one run-log record. Best effort: the run log must never fail a command. */
export function logRun(r: Omit<RunRecord, "time" | "cwd" | "scriptSha256"> & { source: string }): void {
  try {
    const { source, ...rest } = r;
    appendRun({ time: new Date().toISOString(), cwd: process.cwd(), scriptSha256: sha256(source), ...rest });
  } catch {
    // unwritable log directory: the run itself already happened
  }
}

/** Flags worth replaying, as the user typed them. */
export function replayFlags(parsed: Parsed): string[] {
  return ["with-helpers", "allow-generative", "allow-blocking"].filter((f) => parsed.flags[f] === true).map((f) => `--${f}`);
}

interface GenerativeRun {
  file: string;
  source: string;
  hits: ReturnType<typeof scanForAi>;
  argsJson: string | undefined;
  outcome: string;
  text: string;
  current?: string | undefined;
}

/** Appends the provenance record; returns the text `run` prints after "provenance: ". */
function logGenerative(g: GenerativeRun): string {
  const documents = extractUuids(g.text);
  if (g.current && !documents.includes(g.current.toUpperCase())) documents.push(g.current.toUpperCase());
  try {
    appendProvenance({
      time: new Date().toISOString(),
      script: g.file,
      sha256: sha256(g.source),
      identifiers: g.hits,
      args: g.argsJson === undefined ? null : (JSON.parse(g.argsJson) as unknown),
      outcome: g.outcome,
      documents,
    });
    return "logged (ai-generated)";
  } catch (err) {
    return `NOT LOGGED (${err instanceof Error ? err.message : String(err)}); record this run by hand`;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "run",
      summary: "Run a script file in Affinity and print its console output",
      args: [{ name: "file", required: true, description: "path to the .js script" }],
      flags: [
        { name: "args", type: "string", description: "JSON injected as `const ARGS = <json>;` on line 1" },
        { name: "timeout", type: "string", default: String(DEFAULT_TIMEOUT_MS), description: "script timeout in milliseconds" },
        { name: "full", type: "boolean", description: "print the whole output instead of 1500 characters" },
        { name: "with-helpers", type: "boolean", description: "append the axi* SDK helpers after the script (see: affinity-axi helpers)" },
        BRAND_FLAG,
        { name: "allow-generative", type: "boolean", description: "allow this one run to call generative Canva AI APIs (uses AI credits; logs provenance)" },
        { name: "allow-blocking", type: "boolean", description: "run even if the script calls close()/closeAsync() or loads /dialog.js" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi run scripts/smoke-test.js",
        `affinity-axi run scripts/logo.js --args '{"size":512}'`,
        "affinity-axi run scripts/hero.js --allow-generative   # generative AI, logged as provenance",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const file = parsed.positionals[0]!;
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        throw new UsageError(`cannot read script file '${file}'`, `usage: ${BIN} run <file.js>`);
      }

      const hits = scanForAi(source);
      const generative = hits.length > 0;
      if (generative && parsed.flags["allow-generative"] !== true) {
        throw new AxiError(refusalMessage(hits[0]!), refusalSuggestion(`${BIN} run ${file} --allow-generative`));
      }
      const userSource = source;

      const blocking = scanForBlocking(source);
      if (blocking.length > 0 && !parsed.flags["allow-blocking"]) {
        const hit = blocking[0]!;
        throw new AxiError(
          `script calls ${hit.identifier} at line ${hit.line}, which can open a modal prompt and hang Affinity`,
          `closing an unsaved document has no discard option and prompts; saveAs() first and check isDirty === false, then rerun with --allow-blocking`,
        );
      }

      const timeoutMs = Number(parsed.flags["timeout"]);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new UsageError(`invalid --timeout '${String(parsed.flags["timeout"])}'`, "use a positive number of milliseconds, e.g. --timeout 60000");
      }

      let argsJson: string | undefined;
      const rawArgs = parsed.flags["args"];
      if (typeof rawArgs === "string") {
        try {
          // Re-stringify so the injected text is guaranteed single-line.
          argsJson = JSON.stringify(JSON.parse(rawArgs));
        } catch {
          throw new UsageError("--args is not valid JSON", `example: --args '{"size":512}'`);
        }
        source = injectArgs(source, argsJson);
      }
      // The kit is validated before any connection and injected on line 1 too, so user line numbers hold.
      let brand: BrandRef | undefined;
      const brandPath = resolveBrandRef(typeof parsed.flags["brand"] === "string" ? parsed.flags["brand"] : undefined, process.env, process.cwd());
      if (brandPath) {
        const loaded = loadBrand(brandPath);
        source = injectBrand(source, loaded.kit);
        brand = loaded.ref;
      }
      // After the guard scan (user source only) and args: appended, so user line numbers hold.
      if (parsed.flags["with-helpers"] === true) source = withHelpers(source);

      const url = typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined;
      const client = await connect({ url });
      let text: string;
      let outcome: ReturnType<typeof classify>;
      const started = Date.now();
      let provenance: string | undefined;
      let ms = 0;
      const logged = (outcomeKind: string, output: string, listing: DocListing | null): void =>
        logRun({
          cmd: "run",
          script: file,
          source: userSource,
          args: argsJson === undefined ? null : (JSON.parse(argsJson) as unknown),
          flags: replayFlags(parsed),
          outcome: outcomeKind,
          ms,
          documents: runDocuments(output, listing),
          ...(brand ? { brand } : {}),
        });
      try {
        try {
          const result = await client.callTool("execute_script", { script: source }, { timeoutMs });
          outcome = classify(result);
          text = resultText(result);
        } catch (err) {
          // The call may have reached Canva AI before failing: log it anyway.
          if (generative) logGenerative({ file, source: userSource, hits, argsJson, outcome: "error", text: "" });
          ms = Date.now() - started;
          logged("error", "", null);
          throw err;
        }
        ms = Date.now() - started;
        // One listing serves provenance (current document) and the run log (saved paths).
        const listing = await listDocs(client);
        if (generative) {
          // A script that never prints its document UUID still touched the current one.
          const current = extractUuids(text).length === 0 ? (listing?.current ?? undefined) : undefined;
          provenance = logGenerative({ file, source: userSource, hits, argsJson, outcome: outcome.kind, text, current });
        }
        logged(outcome.kind, text, listing);
      } finally {
        client.close();
      }

      const out: string[] = [
        emitKV([
          ["script", file],
          ["status", outcome.kind],
          ["ms", ms],
        ]),
      ];
      if (provenance) out.push(`provenance: ${provenance}`);

      if (outcome.kind === "exception") {
        out.push(emitKV([["error", outcome.error]]));
        if (outcome.at) out.push(emitKV([["at", outcome.at]]));
      }

      const all = parsed.flags["full"] === true;
      const t = all ? { text, truncated: false, totalChars: text.length } : truncate(text, OUTPUT_LIMIT);
      const lines = t.text.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      const block = emitBlock("output", lines);
      const helps: string[] = [];
      if (t.truncated) {
        out.push(block + "\n" + truncationNote(t));
        const extra =
          (argsJson !== undefined ? ` --args ${shellQuote(argsJson)}` : "") +
          (timeoutMs !== DEFAULT_TIMEOUT_MS ? ` --timeout ${timeoutMs}` : "") +
          (brand ? ` --brand ${shellQuote(brand.path)}` : "");
        helps.push(`${BIN} run ${file}${extra} --full`);
      } else {
        out.push(block);
      }

      if (outcome.kind === "ok") {
        const uuid = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/.exec(text)?.[0];
        const ref = uuid ? uuid.slice(0, 8).toUpperCase() : "current";
        helps.push(`${BIN} render ${ref}`, `${BIN} export ${ref} PNG <path-under-Desktop>`);
      } else if (outcome.kind === "not-allowed") {
        helps.push(
          generative
            ? "turn ON Affinity > Settings > Use Canva AI Studio features (and sign in to Canva AI), then re-run"
            : "enable the matching permission in Affinity > Settings, then re-run",
        );
      }
      if (helps.length > 0) out.push(helpBlock(helps));
      print(out.join("\n"));
      return outcome.kind === "ok" ? 0 : 1;
    },
  };
}
