// Lenient reader of `ai.uuids` from <file>.af.axi.json, the manifest beside a
// saved document. The manifest remembers every session UUID that had AI records
// when the file was saved, so a reopened document (new session UUID) still finds
// its provenance records. Kept apart from manifest.ts, which imports provenance.ts.
// Anything unreadable or in an old shape reads as no uuids; this never throws.

import { readFileSync } from "node:fs";

const SUFFIX = ".axi.json";

/** `<afPath>.axi.json` (a path already ending in it is returned unchanged). */
function manifestFile(afPath: string): string {
  return afPath.endsWith(SUFFIX) ? afPath : afPath + SUFFIX;
}

/** Uppercased session UUIDs listed in `ai.uuids` of the manifest beside `afPath`; [] when absent, old or malformed. */
export function readAiUuids(afPath: string): string[] {
  try {
    const m = JSON.parse(readFileSync(manifestFile(afPath), "utf8")) as { ai?: { uuids?: unknown } } | null;
    const u = m?.ai?.uuids;
    if (!Array.isArray(u)) return [];
    return [...new Set(u.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.toUpperCase()))];
  } catch {
    return [];
  }
}
