// Generates docs/agent-guide.md from src/guide/content.ts (via the built
// dist/). Run `npm run build` first. `--check` exits 1 if the committed file
// is stale; CI runs it so the guide cannot drift from the code.
// `--file <path>` checks or writes another file (default docs/agent-guide.md).
// A file with CRLF line endings counts as current.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const fileAt = argv.indexOf("--file");
const outPath = fileAt >= 0 && argv[fileAt + 1] ? resolve(argv[fileAt + 1]) : join(root, "docs", "agent-guide.md");

let renderGuide;
try {
  ({ renderGuide } = await import(new URL("../dist/guide/content.js", import.meta.url).href));
} catch {
  console.log("error: dist/ not found — run 'npm run build' first");
  process.exit(1);
}

const content = renderGuide();
const check = argv.includes("--check");
const isCurrent = (text) => text.replace(/\r\n/g, "\n") === content;

if (check) {
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  if (existing === null || !isCurrent(existing)) {
    console.log("error: docs/agent-guide.md is stale or missing");
    console.log("suggestion: run 'npm run guide:gen' and commit the result");
    process.exit(1);
  }
  console.log("guide: agent-guide.md up to date");
  process.exit(0);
}

if (existsSync(outPath) && isCurrent(readFileSync(outPath, "utf8"))) {
  console.log("guide: agent-guide.md already up to date (no-op)");
  process.exit(0);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content);
console.log(`guide: wrote docs/agent-guide.md (${content.length} chars)`);
