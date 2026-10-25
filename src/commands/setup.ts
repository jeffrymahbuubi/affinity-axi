// `setup hook`: a generic session-start integration. By default it prints the
// command any coding agent can run at session start. With `--file` it keeps one
// `{hooks:[{type:"command",command}]}` entry in a JSON file idempotently
// (install, repair a moved bin path, check, remove). No agent-specific path is
// built in; the caller names the file and, optionally, the dotted key of the
// array that holds the entries (default `hooks.SessionStart`). Setup never
// connects to Affinity.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { ConnectFn } from "../mcp/types.js";
import { AxiError, UsageError } from "../output/errors.js";
import { emitKV, print } from "../output/toon.js";

type Json = Record<string, unknown>;

const DEFAULT_KEY = "hooks.SessionStart";

/** Matches a hook command that runs this tool with --brief. */
const OURS = /affinity-axi(\.js)?"?\s+--brief\s*$/;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isOurs(h: unknown): h is Json {
  return isObject(h) && typeof h["command"] === "string" && OURS.test(h["command"]);
}

function buildCommand(): string {
  const bin = resolve(process.argv[1] ?? "affinity-axi");
  return `${/\s/.test(bin) ? `"${bin}"` : bin} --brief`;
}

function loadJson(file: string): Json {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new AxiError(
      `cannot parse ${file}: ${e instanceof Error ? e.message : String(e)}`,
      "fix or remove the file, then re-run; the file was not modified",
    );
  }
  if (!isObject(parsed)) {
    throw new AxiError(`${file} is not a JSON object`, "fix the file, then re-run; it was not modified");
  }
  return parsed;
}

/** The array at the dotted key, or undefined when absent; errors on malformed shapes. */
function entries(root: Json, path: string[], key: string, file: string): unknown[] | undefined {
  let node: Json = root;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (next === undefined) return undefined;
    if (!isObject(next)) throw new AxiError(`'${key}' in ${file} crosses a value that is not an object`, "fix the file; it was not modified");
    node = next;
  }
  const last = node[path[path.length - 1]!];
  if (last === undefined) return undefined;
  if (!Array.isArray(last)) throw new AxiError(`'${key}' in ${file} is not an array`, "fix the file; it was not modified");
  return last;
}

/** Sets the array at the dotted key, creating the objects on the way. */
function setEntries(root: Json, path: string[], value: unknown[]): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    if (!isObject(node[part])) node[part] = {};
    node = node[part] as Json;
  }
  node[path[path.length - 1]!] = value;
}

/** Deletes the key and prunes the objects it leaves empty. */
function deleteEntries(root: Json, path: string[]): void {
  const chain: Json[] = [root];
  for (const part of path.slice(0, -1)) chain.push(chain[chain.length - 1]![part] as Json);
  delete chain[chain.length - 1]![path[path.length - 1]!];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length > 0) break;
    delete chain[i - 1]![path[i - 1]!];
  }
}

function findOurs(groups: unknown[] | undefined): Json[] {
  const found: Json[] = [];
  for (const g of groups ?? []) {
    if (isObject(g) && Array.isArray(g["hooks"])) {
      for (const h of g["hooks"]) if (isOurs(h)) found.push(h);
    }
  }
  return found;
}

function writeJson(file: string, data: Json): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function report(state: string, file: string, command: string): void {
  print(emitKV([["hook", state], ["file", file], ["command", command]]));
}

/** Drops our hook commands, pruning groups and containers left empty. */
function removeOurs(root: Json, path: string[], groups: unknown[]): void {
  const kept: unknown[] = [];
  for (const g of groups) {
    if (isObject(g) && Array.isArray(g["hooks"])) {
      const inner = g["hooks"].filter((h) => !isOurs(h));
      if (inner.length === 0) continue;
      kept.push({ ...g, hooks: inner });
    } else kept.push(g);
  }
  if (kept.length > 0) setEntries(root, path, kept);
  else deleteEntries(root, path);
}

export const setupHook: CommandModule = {
  spec: {
    name: "setup hook",
    summary: "Print the session-start hook command, or keep it in a JSON file with --file",
    flags: [
      { name: "file", type: "string", description: "JSON file to write the hook entry to (omit to just print the command)" },
      { name: "key", type: "string", default: DEFAULT_KEY, description: "dotted key of the array that holds the entries" },
      { name: "check", type: "boolean", description: "report hook state without writing (needs --file)" },
      { name: "remove", type: "boolean", description: "remove the hook entry (needs --file)" },
    ],
    examples: [
      "affinity-axi setup hook",
      "affinity-axi setup hook --file ./hooks.json",
      "affinity-axi setup hook --file ./hooks.json --check",
      "affinity-axi setup hook --file ./hooks.json --remove",
    ],
  },
  run(parsed) {
    const command = buildCommand();
    const fileFlag = parsed.flags["file"];
    const keyFlag = parsed.flags["key"];
    const key = typeof keyFlag === "string" && keyFlag !== "" ? keyFlag : DEFAULT_KEY;

    if (typeof fileFlag !== "string" || fileFlag === "") {
      for (const flag of ["check", "remove"]) {
        if (parsed.flags[flag]) {
          throw new UsageError(`--${flag} needs --file`, "pass --file <path>, or run with no flags to print the command");
        }
      }
      print(emitKV([
        ["hook", "session-start"],
        ["command", command],
        ["note", "add this command to your agent's session-start hook"],
      ]));
      return 0;
    }

    const path = key.split(".");
    if (path.some((p) => p === "")) throw new UsageError(`invalid --key '${key}'`, "use a dotted key such as hooks.SessionStart");
    const file = resolve(fileFlag);
    const root = loadJson(file);
    const groups = entries(root, path, key, file);
    const ours = findOurs(groups);
    const current = ours.some((h) => h["command"] === command);

    if (parsed.flags["check"]) {
      report(ours.length === 0 ? "not installed" : current ? "installed" : "stale bin path", file, command);
      return 0;
    }

    if (parsed.flags["remove"]) {
      if (groups === undefined || ours.length === 0) {
        report("not installed", file, command);
        return 0;
      }
      removeOurs(root, path, groups);
      writeJson(file, root);
      report("removed", file, command);
      return 0;
    }

    if (ours.length === 0) {
      setEntries(root, path, [...(groups ?? []), { hooks: [{ type: "command", command }] }]);
      writeJson(file, root);
      report("installed", file, command);
      return 0;
    }
    if (!current) {
      for (const h of ours) h["command"] = command;
      writeJson(file, root);
      report("repaired bin path", file, command);
      return 0;
    }
    report("already installed (no-op)", file, command);
    return 0;
  },
};

/** Registry-style factory; setup never connects, so the ConnectFn is unused. */
export function make(_connect: ConnectFn): CommandModule {
  return setupHook;
}
