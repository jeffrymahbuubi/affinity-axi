// The one place that decides whether a .af may be replaced. Pure: it reads the
// filesystem (existsSync, the manifest through freshness) and returns a
// verdict; the commands throw or record from it so the messages, the --force
// semantics and the `forced` flag in the manifest agree everywhere.
//
//   missing target            -> ok
//   fresh manifest            -> ok (the tool saved it and nobody edited it)
//   stale manifest            -> refused, --force overrides (forced: true)
//   no manifest, not own path -> refused ("unmanaged"), --force overrides
//   no manifest, own path     -> ok (open, run a script, save back)

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { freshness } from "./manifest.js";
import { realish } from "./paths.js";

export type OverwriteReason = "stale" | "unmanaged";

export type OverwriteVerdict =
  | { ok: true; forced: boolean }
  | { ok: false; reason: OverwriteReason; message: string; suggestion: string };

export interface OverwriteOptions {
  /** --force was passed. */
  force: boolean;
  /** The document's current saved path ("" when unsaved); equal to target => allowed. */
  ownPath?: string;
  /** Command line to show in the suggestion, e.g. "affinity-axi doc save 70E876CB out/x.af". */
  cmd: string;
}

/** Shared --force flag spec for every command that can replace a .af. */
export const FORCE_FLAG = {
  name: "force" as const,
  type: "boolean" as const,
  description: "overwrite a .af that was changed outside affinity-axi (stale manifest) or that affinity-axi never saved (no manifest)",
};

/** Verdict for writing a .af at `target` (absolute). Missing target => ok, forced false. */
export function checkOverwrite(target: string, opts: OverwriteOptions): OverwriteVerdict {
  if (!existsSync(target)) return { ok: true, forced: false };
  const fresh = freshness(target);
  if (fresh.state === "fresh") return { ok: true, forced: false };
  if (fresh.state === "stale") {
    if (opts.force) return { ok: true, forced: true };
    return {
      ok: false,
      reason: "stale",
      message: `${basename(target)} was changed outside affinity-axi after ${fresh.savedAt || "the last save"}; refusing to overwrite`,
      suggestion: `${opts.cmd} --force to overwrite anyway; or affinity-axi doc open ${target} to work on that file`,
    };
  }
  // No manifest (or one that never recorded a hash).
  if (opts.ownPath && realish(opts.ownPath) === realish(target)) return { ok: true, forced: false };
  if (opts.force) return { ok: true, forced: true };
  return {
    ok: false,
    reason: "unmanaged",
    message: `${basename(target)} exists and was not saved by affinity-axi (no manifest); refusing to overwrite`,
    suggestion: `pick another path, or ${opts.cmd} --force to replace it; affinity-axi doc open ${target} opens the existing file instead`,
  };
}
