// The examples registry: every entry from registry-core.ts, registry-core2.ts and the later
// rounds, plus the lookups --help and the gallery use. See registry-core.ts for
// the entry conventions.

import type { Example } from "./types.js";
import { CORE_EXAMPLES } from "./registry-core.js";
import { CORE2_EXAMPLES } from "./registry-core2.js";
import { ROUND3_EXAMPLES } from "./registry-round3.js";
import { ROUND4_EXAMPLES } from "./registry-round4.js";

export const EXAMPLES: readonly Example[] = [...CORE_EXAMPLES, ...CORE2_EXAMPLES, ...ROUND3_EXAMPLES, ...ROUND4_EXAMPLES];

/** Examples whose feature is exactly `command` (a command path or `helpers:<family>`). */
export function examplesFor(command: string): Example[] {
  return EXAMPLES.filter((e) => e.feature === command);
}

/**
 * Sample output lines for a command's --help: the first six lines of its
 * first example, preferring one that is not pending. Empty when none.
 */
export function outputSample(command: string, max = 6): string[] {
  const list = examplesFor(command).filter((e) => e.output.length > 0);
  const first = list.find((e) => !e.pending) ?? list[0];
  return first ? first.output.slice(0, max) : [];
}
