// Fake exiftool for Windows tests: `node fake-exiftool.mjs <options.json> <exiftool arguments...>`.
// Behaves like the POSIX shell shim written by test/helpers/exiftool-shim.ts. No dependencies.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const opts = JSON.parse(readFileSync(process.argv[2], "utf8"));
const args = process.argv.slice(3);

if (opts.ver !== false && args[0] === "-ver") {
  process.stdout.write("13.55\n");
  process.exit(0);
}
if (opts.log) {
  appendFileSync(opts.log, args.map((a) => `${a}\n`).join("") + (opts.separator ? "--\n" : ""));
}
if (opts.argsFile) writeFileSync(opts.argsFile, `${args.join(" ")}\n`);
if (opts.stdout !== undefined) process.stdout.write(`${opts.stdout}\n`);
process.exit(opts.exit ?? 0);
