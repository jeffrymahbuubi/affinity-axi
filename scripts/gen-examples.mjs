#!/usr/bin/env node
// Regenerates the examples gallery live against a running Affinity, in one
// process: each non-pending example runs through src/examples/runner.ts (via
// the built dist/), its demo document is saved under examples/<id>/ and
// closed again, and example.json, command.sh, output.txt and examples/README.md
// are written. Also captures `--help` per command into examples/_help/.
//
//   node scripts/gen-examples.mjs [--only <id>] [--include-side-effects]
//
// Stops at the first failure or timeout and names the example. Examples that
// change Affinity's stored state (hint add, library save/read) are skipped
// unless --include-side-effects is given. Run `npm run build` first.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(toolDir, "bin", "affinity-axi.js");
const galleryDir = join(toolDir, "examples");

let runner;
let registry;
try {
  runner = await import(new URL("../dist/examples/runner.js", import.meta.url).href);
  registry = await import(new URL("../dist/examples/registry.js", import.meta.url).href);
} catch {
  console.log("error: dist/ not found. Run 'npm run build' first");
  process.exit(1);
}
const { EXAMPLES } = registry;
const { runExample, renderCommandSh, renderReadme, parseCommandPaths, isSideEffect } = runner;

const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? argv[onlyAt + 1] : undefined;
const includeSideEffects = argv.includes("--include-side-effects");
for (const a of argv) {
  if (a.startsWith("--") && !["--only", "--include-side-effects"].includes(a)) {
    console.log(`error: unknown flag ${a}`);
    console.log("suggestion: valid flags: --only <id>, --include-side-effects");
    process.exit(2);
  }
}
if (onlyAt >= 0 && (!only || only.startsWith("--"))) {
  console.log("error: --only needs an example id");
  process.exit(2);
}
if (only && !EXAMPLES.some((e) => e.id === only)) {
  console.log(`error: unknown example '${only}'`);
  console.log(`suggestion: ids: ${EXAMPLES.map((e) => e.id).join(", ")}`);
  process.exit(2);
}

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const selected = EXAMPLES.filter((e) => (only ? e.id === only : true));
const todo = [];
const skipped = [];
for (const ex of selected) {
  if (ex.pending) skipped.push(`${ex.id} (pending)`);
  else if (isSideEffect(ex) && !includeSideEffects) skipped.push(`${ex.id} (side effects)`);
  else todo.push(ex);
}

if (todo.some((e) => e.needs.includes("affinity"))) {
  const home = spawnSync(process.execPath, [bin], { cwd: toolDir, encoding: "utf8", timeout: 60_000 });
  if (!(home.stdout ?? "").includes("affinity: connected")) {
    console.log("error: Affinity is not reachable");
    console.log("suggestion: start Affinity and enable its MCP server, then check 'affinity-axi'");
    process.exit(1);
  }
}

// Affinity writes exports only into non-hidden folders under the Desktop.
if (toolDir.split("/").some((part) => part.startsWith(".") && part.length > 1)) {
  console.log(`warning: ${toolDir} has a hidden folder in its path; Affinity may refuse to export there`);
}

let generated = 0;
for (const ex of todo) {
  const outDir = join(galleryDir, ex.id);
  const result = runExample(ex, { bin, cwd: toolDir, outDir });
  if (!result.ok) {
    const f = result.failed;
    console.log(`error: example '${ex.id}' stopped at '${f.command}' (${f.kind}): ${f.message}`);
    if (f.leftOpen) console.log(`warning: demo document ${f.leftOpen} may still be open; save it with 'doc save' then 'doc close'`);
    console.log(`suggestion: fix it, then 'npm run examples:gen -- --only ${ex.id}'`);
    process.exit(1);
  }
  write(join(outDir, "example.json"), JSON.stringify(ex, null, 2) + "\n");
  write(join(outDir, "command.sh"), renderCommandSh(ex));
  write(join(outDir, "output.txt"), result.normalised);
  generated++;
  console.log(`  ${ex.id},ok,${result.images.length}`);
}

if (!only) {
  const root = spawnSync(process.execPath, [bin, "--help"], { cwd: toolDir, encoding: "utf8" });
  const paths = parseCommandPaths(root.stdout ?? "");
  for (const path of paths) {
    const help = spawnSync(process.execPath, [bin, ...path.split(" "), "--help"], { cwd: toolDir, encoding: "utf8" });
    write(join(galleryDir, "_help", `${path.replaceAll(" ", "-")}.txt`), help.stdout ?? "");
  }
  console.log(`help: captured ${paths.length} commands into examples/_help/`);
}

write(join(galleryDir, "README.md"), renderReadme(EXAMPLES, galleryDir));
console.log(`examples: generated ${generated}, skipped ${skipped.length}${skipped.length ? ` (${skipped.join(", ")})` : ""}`);
console.log("help[1]:\n  npm run examples:check");
