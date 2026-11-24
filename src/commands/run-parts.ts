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

const FULL_UUID = /\b[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\b/;

/** The 8-character id the CLI accepts for a document. */
const shortId = (uuid: string): string => uuid.slice(0, 8).toUpperCase();

/**
 * The help lines a finished run adds about documents. A failed run names what it left open (at most 3);
 * an ok run points at the document it printed, or at the one it opened when the output names none.
 */
export function runDocHelp(bin: string, ok: boolean, text: string, opened: DocListing["documents"]): string[] {
  const out: string[] = [];
  if (!ok) {
    for (const d of opened.slice(0, 3)) {
      const id = shortId(d.uuid);
      if (d.dirty) {
        out.push(
          `${bin} doc save ${id} <path-under-Desktop>.af   # keep the half-built document`,
          `${bin} doc close ${id}   # then close it, or close it in Affinity with Don't Save`,
        );
      } else {
        out.push(`${bin} doc close ${id}   # left open by the failed run; it has no unsaved changes`);
      }
    }
    return out;
  }
  const uuid = FULL_UUID.exec(text)?.[0];
  const only = opened.length === 1 ? opened[0] : undefined;
  const ref = uuid ? shortId(uuid) : only ? shortId(only.uuid) : undefined;
  if (ref) {
    out.push(`${bin} render ${ref}`, `${bin} export ${ref} PNG <path-under-Desktop>`);
    if (only?.dirty) out.push(`${bin} doc save ${shortId(only.uuid)} <path-under-Desktop>.af   # this run left the document open and unsaved`);
  } else if (opened.length > 1) {
    const ids = opened.slice(0, 4).map((d) => shortId(d.uuid)).join(" ");
    out.push(`${bin} render <doc>   # this run opened ${opened.length} documents: ${ids}`, `${bin} export <doc> PNG <path-under-Desktop>`);
  } else {
    out.push(
      `${bin} render <doc>   # print doc.sessionUuid in the script to get the id`,
      `${bin} export <doc> PNG <path-under-Desktop>`,
    );
  }
  return out;
}

/** The help line for a run that hit PERMISSION_DENIED while the script or --args holds a ~/ or %USERPROFILE% path; else undefined. */
export function tildeHint(text: string, source: string, argsJson?: string): string | undefined {
  if (!/PERMISSION_DENIED/.test(text)) return undefined;
  if (!/["'`]~[/\\]|%USERPROFILE%/i.test(`${source}\n${argsJson ?? ""}`)) return undefined;
  return "use an absolute path: Affinity does not expand ~/ or %USERPROFILE% inside a script (axiImage and axiReplaceImage accept ~/Desktop/... with --with-helpers)";
}
