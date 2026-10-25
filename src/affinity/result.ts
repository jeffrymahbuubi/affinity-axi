// Script outcome classification.
//
// execute_script reports uncaught exceptions with isError:false and the stack
// as plain text, so classification is text-based. Order:
//   1. a line ^NOT_ALLOWED                       -> not-allowed
//   2. isError:true from the server             -> sdk-error
//   3. a line ^ERROR:                           -> sdk-error
//   4. a line ^\w*Error: followed by "    at ..." -> exception
//   5. everything else                          -> ok
// Every line is scanned, not just the first: scripts usually log progress
// before they fail, and the failure text comes after that output.

import type { ScriptOutcome, ToolResult } from "../mcp/types.js";

/** Text contents of a tool result joined with newlines (images are skipped). */
export function resultText(r: ToolResult): string {
  return r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function classify(r: ToolResult): ScriptOutcome {
  const text = resultText(r);
  const lines = text.split(/\r?\n/);

  if (lines.some((l) => /^NOT_ALLOWED/.test(l))) return { kind: "not-allowed", text };
  if (r.isError) return { kind: "sdk-error", text };
  if (lines.some((l) => /^ERROR:/.test(l))) return { kind: "sdk-error", text };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!/^\w*Error: /.test(line)) continue;
    const m = /^ {4}at (.*)$/.exec(lines[i + 1] ?? "");
    if (m) return { kind: "exception", error: line, at: (m[1] ?? "").trim(), text };
  }
  return { kind: "ok", text };
}
