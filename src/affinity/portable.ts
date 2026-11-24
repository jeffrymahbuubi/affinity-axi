// Paths that are safe to store in files an agent or another machine will read:
// no home-folder name, "/" between segments on every OS, and a form that decodes
// back to the same file. Manifests, the run log and provenance all encode through
// here, so the rule exists once.
//
// Pure except realish() (it asks the filesystem which symlinks a path crosses).
// No process.platform and no sep: a drive-letter path is recognised by pattern, so
// a value written on Windows reads the same on macOS and Linux.

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { realish, toPosix } from "./paths.js";

/** Environment variable that moves the state folder (run log and the like). */
export const STATE_ENV = "AFFINITY_AXI_HOME";

const DRIVE = /^[A-Za-z]:[\\/]/;

/** resolve(env[STATE_ENV]) when it is a non-empty string, else join(home, ".affinity-axi"). */
export function stateDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const v = env[STATE_ENV];
  return typeof v === "string" && v !== "" ? resolve(v) : resolve(home, ".affinity-axi");
}

/** "~" and "~/x" (also "~\\x") against `home`; anything else unchanged. */
export function expandTilde(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  return p.startsWith("~/") || p.startsWith("~\\") ? resolve(home, p.slice(2)) : p;
}

/** A path of either OS: native absolute, a leading "/", or a drive letter. */
function absoluteAnyOs(p: string): boolean {
  return isAbsolute(p) || p.startsWith("/") || DRIVE.test(p);
}

/** The relative path from `dir` to `abs` when abs is dir or below it, else null. */
function below(dir: string, abs: string): string | null {
  const rel = relative(realish(dir), realish(abs));
  if (rel === "") return "";
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) return null;
  return rel;
}

/** How a target is written into a file that lives in baseDir: relative, "~/", or absolute, always with "/". */
export function storedPath(target: string, baseDir: string, home: string = homedir()): string {
  if (target === "") return "";
  // A drive-letter path met on a POSIX machine cannot be resolved here; keep its text.
  if (DRIVE.test(target) && !isAbsolute(target)) return target.replace(/\\/g, "/");
  const abs = resolve(baseDir, expandTilde(target, home));
  const inBase = below(baseDir, abs);
  if (inBase !== null) return inBase === "" ? "." : toPosix(inBase);
  const rel = relative(realish(baseDir), realish(abs));
  const absHome = below(home, abs);
  if (!isAbsolute(rel) && (below(home, baseDir) !== null) === (absHome !== null)) return toPosix(rel);
  if (absHome !== null) return absHome === "" ? "~" : "~/" + toPosix(absHome);
  if (absoluteAnyOs(target)) return DRIVE.test(target) ? target.replace(/\\/g, "/") : toPosix(target);
  return toPosix(abs);
}

/** The inverse of storedPath: an absolute path of either OS comes back unchanged, the rest resolves against baseDir. */
export function resolveStored(stored: string, baseDir: string, home: string = homedir()): string {
  if (stored === "") return "";
  const t = expandTilde(stored, home);
  return absoluteAnyOs(t) ? t : resolve(baseDir, t);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function plain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

/** A deep copy with the home folder, in each spelling, replaced by "~". */
export function scrubHome<T>(value: T, home: string = homedir()): T {
  const h = home.replace(/[\\/]+$/, "");
  let fix = (s: string): string => s;
  if (h.length >= 2) {
    const spellings = new Set<string>([h, toPosix(h), h.replace(/\\/g, "/")]);
    const drive = DRIVE.test(h + "/");
    if (drive) spellings.add(`/${h.charAt(0).toLowerCase()}${h.slice(2).replace(/\\/g, "/")}`);
    const alt = [...spellings].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
    const flags = drive ? "i" : "";
    const start = new RegExp(`^(?:${alt})(?=$|[/\\\\])`, flags);
    const anywhere = new RegExp(`(?<![A-Za-z0-9_])(?:${alt})(?=$|[/\\\\])`, `${flags}g`);
    fix = (s) => {
      const m = start.exec(s);
      return m ? "~" + s.slice(m[0].length).replace(/\\/g, "/") : s.replace(anywhere, "~");
    };
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (plain(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
