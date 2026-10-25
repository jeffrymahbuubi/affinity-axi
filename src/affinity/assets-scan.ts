// Finds asset manifests (*.af.axi.json) under a directory for `assets` and
// the home view. Pure filesystem, no connection to Affinity.

import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { freshness, readManifest } from "./manifest.js";
import type { AssetRow } from "./manifest-types.js";

const SKIP = new Set(["node_modules", ".git", "dist", ".affinity-axi"]);
const SUFFIX = ".af.axi.json";

/**
 * Every manifest under `dir` down to `maxDepth` directory levels, newest
 * `savedAt` first. `file` is the .af path relative to `dir`; `dir` of a row is
 * the absolute directory holding it.
 */
export function scanManifests(dir: string, maxDepth = 6): AssetRow[] {
  const root = resolve(dir);
  const rows: AssetRow[] = [];

  const walk = (current: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(current, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith(SUFFIX)) {
        const af = full.slice(0, -".axi.json".length);
        const m = readManifest(af);
        if (!m) continue;
        rows.push({
          file: relative(root, af),
          dir: current,
          madeBy: m.madeBy?.script ?? "",
          savedAt: m.af?.savedAt ?? "",
          fresh: freshness(af).state,
        });
      }
    }
  };

  walk(root, 0);
  rows.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.file.localeCompare(b.file)));
  return rows;
}
