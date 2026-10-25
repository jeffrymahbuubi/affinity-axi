// Document reference resolution: `current`, a full session UUID, or a
// unique UUID prefix of at least 8 characters. Matching is case-insensitive.
// No match, ambiguity, or `current` with nothing focused is a usage error
// (exit 2) whose suggestion lists the candidates.

import { AxiError, UsageError } from "../output/errors.js";
import type { DocInfo } from "../mcp/types.js";

export const MIN_PREFIX = 8;

function candidates(docs: DocInfo[]): string {
  if (docs.length === 0) return "no documents are open in Affinity";
  return "open documents: " + docs.map((d) => `${d.uuid} (${d.title})`).join("; ");
}

export function resolveDocRef(ref: string, docs: DocInfo[], current: string | null): DocInfo {
  const want = ref.trim().toLowerCase();

  if (want === "current") {
    if (current === null) {
      throw new UsageError(
        "no current document: Affinity reports no document with focus",
        `pass a UUID or a unique prefix of at least ${MIN_PREFIX} characters; ${candidates(docs)}`,
      );
    }
    const doc = docs.find((d) => d.uuid.toLowerCase() === current.toLowerCase());
    if (!doc) {
      throw new AxiError(
        `current document ${current} is not in the open documents list`,
        `${candidates(docs)}; retry the command`,
      );
    }
    return doc;
  }

  if (want.length < MIN_PREFIX) {
    throw new UsageError(
      `document reference "${ref}" is too short: use "current", a full UUID or at least ${MIN_PREFIX} characters of one`,
      candidates(docs),
    );
  }

  const exact = docs.find((d) => d.uuid.toLowerCase() === want);
  if (exact) return exact;

  const matches = docs.filter((d) => d.uuid.toLowerCase().startsWith(want));
  const only = matches[0];
  if (matches.length === 1 && only) return only;
  if (matches.length === 0) {
    throw new UsageError(`no open document matches "${ref}"`, candidates(docs));
  }
  throw new UsageError(
    `document reference "${ref}" is ambiguous (${matches.length} matches)`,
    `use a longer prefix; ${candidates(matches)}`,
  );
}
