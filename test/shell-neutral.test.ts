// Guard for the shell-neutral rule: nothing the tool prints as a thing to type is a command of
// one particular shell. Help lines are `affinity-axi` commands or plain instructions; they have no
// `rm`, `open`, `xdg-open`, no `&&` (Windows PowerShell 5.1 has no such operator), no `/tmp/`.
// There is no platform branch: the checks read source text and the built CLI's help text.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCommandPaths } from "../src/examples/runner.js";
import { renderGuide } from "../src/guide/content.js";

const toolDir = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(toolDir, "src");
const bin = join(toolDir, "bin", "affinity-axi.js");

// A string literal that starts with a foreign shell command: a quote, then the command word.
// `open ` counts only when an argument that is a path or a variable follows (`open ~/a`, `open ./a`,
// `open ${x}`), so prose such as "open Affinity" and the tool's own `doc open` pass.
const FOREIGN = /[`"'](?:rm -|rmdir |del |xdg-open |start |open [$<~./]|mv |cp |cat |mkdir )/;

/** Lines of `text` that open a string literal with a command of another shell, as "line: text". */
function foreignCommands(text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (FOREIGN.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  });
  return hits;
}

/** Every .ts file below `dir`. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The lines of the `examples[n]:` block of a command's --help. */
function exampleLines(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.startsWith("examples["));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^\S/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((l) => l.trim() !== "");
}

describe("source scan: no string in src starts with another shell's command", () => {
  it("finds no offender", () => {
    const files = tsFiles(srcDir);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const f of files) {
      for (const hit of foreignCommands(readFileSync(f, "utf8"))) {
        offenders.push(`${f.slice(toolDir.length).replace(/\\/g, "/")}:${hit}`);
      }
    }
    expect(offenders, `foreign shell commands in printed strings:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("is not vacuous: it flags planted commands and passes the legitimate lookalikes", () => {
    // Built from pieces so this file would pass its own scan if the scan were widened to test/.
    const q = '"';
    const planted = [
      "`" + "rm" + " -r ${x}`",
      q + "open" + " ~/a.html" + q,
      "'" + "xdg" + "-open x'",
      q + "mk" + "dir out" + q,
    ];
    for (const p of planted) expect(foreignCommands(p), p).toHaveLength(1);
    const fine = [
      q + "open Affinity, enable Settings" + q,
      q + "open documents: " + q,
      "`${BIN} doc " + "open ${p}`",
    ];
    for (const f of fine) expect(foreignCommands(f), f).toEqual([]);
  });
});

describe("--help examples are plain affinity-axi lines", () => {
  const offline = { ...process.env, AFFINITY_MCP_URL: "http://127.0.0.1:1" };
  const cli = (...args: string[]): string =>
    spawnSync("node", [bin, ...args], { cwd: toolDir, encoding: "utf8", env: offline }).stdout;

  it("every example line starts with affinity-axi and has no /tmp/ or &&", () => {
    const paths = parseCommandPaths(cli("--help"));
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      const examples = exampleLines(cli(...p.split(" "), "--help"));
      for (const line of examples) {
        const l = line.trim();
        expect(l.startsWith("affinity-axi "), `${p}: ${l}`).toBe(true);
        expect(l, `${p}: ${l}`).not.toContain("/tmp/");
        expect(l, `${p}: ${l}`).not.toContain(" && ");
      }
    }
  });
});

describe("agent guide", () => {
  it("has no foreign shell command and no POSIX temp path", () => {
    expect(renderGuide()).not.toMatch(/\brm -r|\bxdg-open\b|\/tmp\//);
  });
});
