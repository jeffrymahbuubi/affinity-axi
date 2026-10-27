// AI guard: best-effort textual scan for SDK generative-AI APIs.
//
// Matches whole identifiers only (so `generateImageX` is not a hit) and does
// not look at comment/string context: a mention in a comment is still refused.
// It cannot see dynamically built property names; Affinity's own "Use Canva AI
// Studio features" setting is the enforcement of last resort.
//
// Policy: generative
// APIs are refused by default and allowed for one run with --allow-generative,
// which also writes a provenance record (see provenance.ts). The ML-assisted
// ones (background removal, subject selection, depth detection, colourise)
// are not listed here and are always allowed.

import type { AiHit } from "../mcp/types.js";

export const AI_IDENTIFIERS: readonly string[] = [
  "generateImage",
  "generativeEditImage",
  "createGenerateImage",
  "createGenerativeEditImage",
  "createGenerateImageCommand",
  "createGenerativeEditImageCommand",
  // The safe wrapper (helpers-patch.ts) calls the generative edit, so it is generative too.
  "axiGenerativePatch",
];

// A helper's own `function axi...(` declaration is a definition, not a call: the
// helper block (HELPERS_SOURCE) must stay free of hits, so declarations are skipped.
const PATTERNS: Array<{ identifier: string; re: RegExp }> = AI_IDENTIFIERS.map((identifier) => ({
  identifier,
  // JS identifier characters are [A-Za-z0-9_$]; \b would treat `$` as a boundary.
  re: new RegExp(`${identifier.startsWith("axi") ? "(?<!function\\s+)" : ""}(?<![\\w$])${identifier}(?![\\w$])`, "g"),
}));

/** The one-line refusal reason shared by `run` and `library save`. */
export function refusalMessage(hit: AiHit): string {
  return `script references SDK AI API ${hit.identifier} at line ${hit.line}`;
}

/** Suggestion for a refusal; `cmd` is the command line to re-run with the flag. */
export function refusalSuggestion(cmd: string): string {
  return `generative AI is opt-in per run: re-run with --allow-generative (${cmd}), which logs provenance; or remove the call. ML features (removeBackground, selectSubject, detectDepth, colourise) need no flag`;
}

/** Returns every occurrence with its 1-based line, sorted by line (then column). */
export function scanForAi(source: string): AiHit[] {
  const hits: Array<AiHit & { col: number }> = [];
  const lines = source.split(/\r\n|\r|\n/);
  lines.forEach((text, i) => {
    for (const { identifier, re } of PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        hits.push({ identifier, line: i + 1, col: m.index });
      }
    }
  });
  hits.sort((a, b) => a.line - b.line || a.col - b.col);
  return hits.map(({ identifier, line }) => ({ identifier, line }));
}

// Blocking-call guard: calls that can open a modal prompt in Affinity. Scripts
// run on Affinity's UI thread, so a prompt nobody answers blocks the call until
// it times out and can leave the app hung (2026-10-24: Document.close() on an
// unsaved document had to be force-quit). Same textual best-effort as above.
const BLOCKING: Array<{ identifier: string; re: RegExp }> = [
  { identifier: "close()", re: /\.close\s*\(/g },
  { identifier: "closeAsync()", re: /\.closeAsync\s*\(/g },
  { identifier: "/dialog.js", re: /require\(\s*['"`]\/dialog\.js['"`]\s*\)/g },
];

/** Calls that may open a modal prompt, with their 1-based line, sorted by line. */
export function scanForBlocking(source: string): AiHit[] {
  const hits: AiHit[] = [];
  source.split(/\r\n|\r|\n/).forEach((text, i) => {
    for (const { identifier, re } of BLOCKING) {
      re.lastIndex = 0;
      if (re.test(text)) hits.push({ identifier, line: i + 1 });
    }
  });
  return hits;
}
