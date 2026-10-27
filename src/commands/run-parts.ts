// Pieces of `run` that keep run.ts small: the generative-call shim and its
// marker handling, and the "left open" comparison for failed runs.

import type { DocListing } from "./run.js";

export const GENERATIVE_CALLED = "axi:generative-called";
export const GENERATIVE_SHIM_UNAVAILABLE = "axi:generative-shim-unavailable";

/** Whether the generative API really ran: true, false, or "unknown" when the run cannot say. */
export type Called = boolean | "unknown";

/**
 * One line, prepended to the script: wraps the generative entry points so each
 * call prints a marker first. Everything is inside try/catch, so a runtime that
 * refuses the patch only costs the confirmation (it logs the unavailable line).
 */
const SHIM_BODY = [
  "try {",
  "const { Document } = require('/document.js');",
  "const { DocumentCommand } = require('/commands.js');",
  "let patched = 0;",
  "const wrap = (target, name) => {",
  "const orig = target && target[name];",
  "if (typeof orig !== 'function') return;",
  "const wrapper = function (...args) { console.log('" + GENERATIVE_CALLED + "'); return orig.apply(this, args); };",
  "try { target[name] = wrapper; } catch (e) { return; }",
  "if (target[name] === wrapper) patched++;",
  "};",
  "for (const n of ['generativeEditImage', 'generateImage']) wrap(Document.prototype, n);",
  "for (const n of ['createGenerativeEditImage', 'createGenerateImage']) wrap(DocumentCommand, n);",
  "if (patched === 0) console.log('" + GENERATIVE_SHIM_UNAVAILABLE + "');",
  "} catch (e) { console.log('" + GENERATIVE_SHIM_UNAVAILABLE + "'); }",
].join(" ");

const GENERATIVE_SHIM = `(() => { ${SHIM_BODY} })();`;

/** Prepends the shim on line 1 (no newline), so user line numbers hold. */
export function withGenerativeShim(source: string): string {
  return `${GENERATIVE_SHIM} ${source}`;
}

export interface MarkerScan {
  /** The output with the marker lines removed. */
  text: string;
  called: Called;
}

/** Reads the shim's marker lines out of a run's output and strips them. */
export function scanMarkers(text: string): MarkerScan {
  let seen = false;
  let unavailable = false;
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === GENERATIVE_CALLED) seen = true;
    else if (t === GENERATIVE_SHIM_UNAVAILABLE) unavailable = true;
    else kept.push(line);
  }
  return { text: kept.join("\n"), called: seen ? true : unavailable ? "unknown" : false };
}

/** The provenance label `run` prints after "provenance: " for a logged record. */
export function provenanceLabel(called: Called): string {
  return called === false ? "logged (generative identifier found; the call did not run)" : "logged (ai-generated)";
}

/** Documents listed after the call that were not listed before it. */
export function openedDocs(before: DocListing | null, after: DocListing | null): DocListing["documents"] {
  if (!before || !after) return [];
  const known = new Set(before.documents.map((d) => d.uuid.toUpperCase()));
  return after.documents.filter((d) => !known.has(d.uuid.toUpperCase()));
}
