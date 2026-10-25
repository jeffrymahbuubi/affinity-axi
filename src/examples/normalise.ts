// Turns live CLI output into the stable text that gallery files and registry
// samples are compared on: session UUIDs, timings, byte counts and the home
// directory differ on every run and every machine.

import { homedir } from "node:os";

export interface NormaliseOptions {
  /** Home directory to collapse to "~" (default: the current user's). */
  home?: string;
}

const UUID_RE = /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/g;
const HEADER_RE = /^[A-Za-z][\w.-]*\[[^\]]*\]\{([^}]*)\}:\s*$/;
const COUNT_FIELDS = new Set(["ms", "bytes"]);

/** Splits one TOON row on commas outside double quotes; cells stay raw. */
function splitCells(row: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of row) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** In table rows, replaces the ms and bytes columns (named by the header) with <n>. */
function normaliseTables(text: string): string {
  const lines = text.split("\n");
  let columns: number[] = [];
  return lines
    .map((line) => {
      const header = HEADER_RE.exec(line);
      if (header) {
        const fields = header[1]!.split(",");
        columns = fields.flatMap((f, i) => (COUNT_FIELDS.has(f) ? [i] : []));
        return line;
      }
      if (!/^\s/.test(line)) {
        columns = [];
        return line;
      }
      if (columns.length === 0) return line;
      const indent = /^\s*/.exec(line)![0];
      const cells = splitCells(line.slice(indent.length));
      for (const i of columns) if (/^\d+$/.test(cells[i] ?? "")) cells[i] = "<n>";
      return indent + cells.join(",");
    })
    .join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalise(text: string, opts: NormaliseOptions = {}): string {
  let out = text;

  const home = opts.home ?? homedir();
  if (home.length > 1) out = out.replace(new RegExp(`${escapeRe(home)}(?![\\w-])`, "g"), "~");

  // Short ids are the first 8 characters of a UUID printed in the same text,
  // plus the ones the CLI puts in render paths and in its own next-step lines.
  const short = new Set<string>();
  for (const m of out.matchAll(UUID_RE)) short.add(m[0].slice(0, 8).toLowerCase());
  for (const m of out.matchAll(/\/renders\/([0-9A-Fa-f]{8})-/g)) short.add(m[1]!.toLowerCase());
  const next = /\baffinity-axi (?:render|export|inspect|doc (?:save|close|open|info)) ([0-9A-Fa-f]{8})(?=\s|$)/g;
  for (const m of out.matchAll(next)) short.add(m[1]!.toLowerCase());

  out = out.replace(UUID_RE, "<uuid>");
  for (const id of short) {
    out = out.replace(new RegExp(`(?<![0-9A-Za-z])${escapeRe(id)}(?![0-9A-Za-z])`, "gi"), "<uuid8>");
  }

  out = out.replace(/^(\s*)(ms|bytes): \d+/gm, "$1$2: <n>");
  out = out.replace(/\b(ms|bytes)=\d+/g, "$1=<n>");
  return normaliseTables(out);
}
