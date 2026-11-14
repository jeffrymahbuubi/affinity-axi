// A fake exiftool for tests.
//
// POSIX: a `#!/bin/sh` script named `exiftool` in `binDir`, found through PATH (so PATH lookup stays covered).
// win32: a `.cmd` file cannot be spawned without a shell, so the options go to a JSON file and
// AFFINITY_AXI_EXIFTOOL_CMD points at `node fake-exiftool.mjs <options file>` (see src/affinity/exif.ts).
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FakeExiftoolOptions {
  /** Append one argument per line per call to this file. */
  log?: string;
  /** With `log`: a `--` line after each call. */
  separator?: boolean;
  /** Exit code (default 0). */
  exit?: number;
  /** Text printed to stdout, then a newline. */
  stdout?: string;
  /** Answer `-ver` with 13.55, exit 0, without logging (default true). */
  ver?: boolean;
  /** Overwritten on each call with the arguments joined by a space. */
  argsFile?: string;
}

const VAR = "AFFINITY_AXI_EXIFTOOL_CMD";
const FAKE = fileURLToPath(new URL("./fake-exiftool.mjs", import.meta.url));
let installedAt: string | undefined;

const sq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

function script(o: FakeExiftoolOptions): string {
  const lines = ["#!/bin/sh"];
  if (o.ver !== false) lines.push('if [ "$1" = "-ver" ]; then echo 13.55; exit 0; fi');
  if (o.log !== undefined) lines.push(`printf '%s\\n' "$@" >> ${sq(o.log)}`);
  if (o.log !== undefined && o.separator === true) lines.push(`echo "--" >> ${sq(o.log)}`);
  if (o.argsFile !== undefined) lines.push(`echo "$@" > ${sq(o.argsFile)}`);
  if (o.stdout !== undefined) lines.push(`printf '%s\\n' ${sq(o.stdout)}`);
  lines.push(`exit ${o.exit ?? 0}`);
  return `${lines.join("\n")}\n`;
}

/** Installs the fake in `binDir` (which must exist), replacing an earlier one. */
export function installFakeExiftool(binDir: string, o: FakeExiftoolOptions = {}): void {
  removeFakeExiftool();
  if (process.platform === "win32") {
    const options = join(binDir, "fake-exiftool.json");
    writeFileSync(options, JSON.stringify(o));
    process.env[VAR] = JSON.stringify([process.execPath, FAKE, options]);
    return;
  }
  const file = join(binDir, "exiftool");
  writeFileSync(file, script(o));
  chmodSync(file, 0o755);
  installedAt = file;
}

/** The PATH value that finds the fake: `binDir` on win32 (the variable does the work), plus system dirs on POSIX. */
export function shimPath(binDir: string): string {
  return process.platform === "win32" ? binDir : `${binDir}:/usr/bin:/bin`;
}

/** Forgets the fake: unsets the variable and deletes a POSIX shim written earlier. Call it in afterEach. */
export function removeFakeExiftool(): void {
  delete process.env[VAR];
  if (installedAt !== undefined) {
    rmSync(installedAt, { force: true });
    installedAt = undefined;
  }
}
