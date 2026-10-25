#!/usr/bin/env node
// Offline gallery check: every non-pending example has examples/<id>/ with an
// output.txt that holds the registry's sample lines in order, plus its images
// and script. Pending examples are skipped, and so are examples with side
// effects until they have an output.txt. A gallery image above 500 KB prints a
// `warning:` and still exits 0. Run `npm run build` first.
//
//   node scripts/check-examples.mjs [--dir <gallery folder>]

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const dirAt = argv.indexOf("--dir");
const galleryDir = dirAt >= 0 && argv[dirAt + 1] ? resolve(argv[dirAt + 1]) : join(toolDir, "examples");

let runner;
let registry;
try {
  runner = await import(new URL("../dist/examples/runner.js", import.meta.url).href);
  registry = await import(new URL("../dist/examples/registry.js", import.meta.url).href);
} catch {
  console.log("error: dist/ not found. Run 'npm run build' first");
  process.exit(1);
}

const report = runner.checkGallery(registry.EXAMPLES, galleryDir);
for (const w of report.warnings) console.log(`warning: ${w}`);
for (const e of report.errors) console.log(`error: ${e}`);
console.log(`examples: checked ${report.checked.length}, skipped ${report.skipped.length}${report.skipped.length ? ` (${report.skipped.join(", ")})` : ""}`);

if (report.errors.length > 0) {
  const first = report.errors[0].split(":")[0];
  console.log(`suggestion: regenerate with Affinity open: npm run examples:gen -- --only ${first}`);
  process.exit(1);
}
console.log("examples: gallery matches the registry");
