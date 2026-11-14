// The one place that turns a path typed by the user into something Affinity may
// touch. It exists once because the same three helpers (expandHome, realish,
// isInside) used to be copied into six modules, and a fix to one copy had to be
// made five more times (review finding R18).
//
// The hidden-folder check is offline on purpose (review finding R14): Affinity
// refuses dot-prefixed paths such as .affinity-axi/ with PERMISSION_DENIED, so
// the command refuses first, before it connects, and the user gets a usage
// error that says what to change instead of the SDK's failure text.
//
// It also decides how a path is printed: shown() and shownRel() put "/" between
// segments on every OS, so agent-facing text reads the same on Windows and macOS.
//
// Pure: node:fs realpathSync, node:os homedir, node:path and UsageError only.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "../output/errors.js";

/**
 * A path as it is stored in a manifest or kit: "/" between segments on every OS,
 * so a file written on Windows reads back on macOS and Linux (and the reverse;
 * resolve() takes "/" on Windows). Unchanged when the separator is already "/",
 * because there a backslash is a legal file-name character.
 */
export function toPosix(p: string, separator: string = sep): string {
  return separator === "/" ? p : p.split(separator).join("/");
}

/**
 * A path as it is printed (key/value lines, tables, help lines, errors): the same
 * transformation as toPosix, under its own name so `grep "shown("` lists the
 * display sites. Paths handed to the filesystem or to Affinity stay native.
 * Idempotent; the identity when the separator is already "/".
 */
export function shown(p: string, separator: string = sep): string {
  return toPosix(p, separator);
}

/** A target relative to cwd (absolute when it is on another drive), printed with "/". */
export function shownRel(target: string, cwd: string = process.cwd()): string {
  const abs = resolve(cwd, target);
  return shown(relative(cwd, abs) || abs);
}

/** "~" and "~/x" become absolute; anything else is returned unchanged. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

/** resolve(expandHome(raw)): the absolute form of a path typed by the user. */
export function userPath(raw: string): string {
  return resolve(expandHome(raw));
}

/** realpath of the deepest existing ancestor plus the not-yet-existing rest. */
export function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realish(parent), basename(p));
  }
}

/** true when target is dir or below it, comparing realish() forms (symlinks and .. cannot escape). */
export function isInside(dir: string, target: string): boolean {
  const rel = relative(realish(dir), realish(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** First dot-prefixed segment of the resolved path (".cache", ".x.af"), or null. "." and ".." never count. */
export function hiddenSegment(p: string): string | null {
  for (const part of resolve(p).split(sep)) {
    if (part.startsWith(".") && part.length > 1) return part;
  }
  return null;
}

/** Throws UsageError (exit 2) when hiddenSegment(p) is not null. `label` names the input ("save path", "--out-dir", "image"). */
export function requireVisible(p: string, label: string): void {
  const seg = hiddenSegment(p);
  if (seg === null) return;
  throw new UsageError(
    `${label} is inside a hidden folder or file ('${seg}'): ${shown(p)}`,
    "Affinity refuses dot-prefixed paths such as .affinity-axi/; choose a path whose folders and file name do not start with a dot",
  );
}

export type DesktopAccess = "write-file" | "write-folder" | "read-image" | "open";

/** Throws UsageError (exit 2) when !isInside(resolve(desktop), p). `desktop` is Application.userDesktopPath as reported. */
export function requireUnderDesktop(desktop: string, p: string, label: string, access: DesktopAccess): void {
  if (isInside(resolve(desktop), p)) return;
  const at = shown(desktop);
  const suggestion =
    access === "write-file"
      ? `Affinity can only write under ${at}; choose a path inside it`
      : access === "write-folder"
        ? `Affinity can only write under ${at}; choose a folder inside it`
        : access === "read-image"
          ? `Affinity can only read images under ${at}; copy it there`
          : `Affinity can only open files under ${at}`;
  throw new UsageError(`${label} is outside the Desktop folder: ${shown(p)}`, suggestion);
}
