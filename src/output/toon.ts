// TOON (Token-Oriented Object Notation) emitter. All stdout flows through
// this module so every command stays consistent (AXI principle 1).

export function print(text: string): void {
  process.stdout.write(text + "\n");
}

export function toonValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export interface ListOptions {
  /** Total collection size when rows are a subset; renders "N of M total". */
  total?: number;
}

/** `name[count]{f1,f2}:` header line of a list; the caller formats `count`. */
export function listHeader(name: string, count: number | string, fields: string[]): string {
  return `${name}[${count}]{${fields.join(",")}}:`;
}

/** One indented row of a list: the cells of `fields`, comma separated and quoted as needed. */
export function listRow(row: Record<string, unknown>, fields: string[]): string {
  return "  " + fields.map((f) => toonValue(row[f])).join(",");
}

export function emitList(
  name: string,
  rows: Array<Record<string, unknown>>,
  fields: string[],
  opts: ListOptions = {},
): string {
  const count =
    opts.total !== undefined && opts.total !== rows.length
      ? `${rows.length} of ${opts.total} total`
      : String(rows.length);
  return [listHeader(name, count, fields), ...rows.map((row) => listRow(row, fields))].join("\n");
}

/** A named block of pre-formatted lines, e.g. help[2]: or next[3]:. */
export function emitBlock(name: string, lines: string[]): string {
  return [`${name}[${lines.length}]:`, ...lines.map((l) => "  " + l)].join("\n");
}

export function emitKV(pairs: Array<[string, unknown]>): string {
  return pairs.map(([k, v]) => `${k}: ${toonValue(v) === "" ? "" : String(v)}`.trimEnd()).join("\n");
}

/**
 * Tolerant TOON parser used by the validator: checks that text is shaped
 * like TOON (top-level `key: value` / `name[N]{f,..}:` headers with indented
 * rows) without enforcing a strict grammar.
 */
export function parseToon(text: string): { ok: boolean; errorLine?: number } {
  const lines = text.split("\n");
  let allowIndent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    if (/^\s/.test(line)) {
      if (!allowIndent) return { ok: false, errorLine: i + 1 };
      continue;
    }
    const header = /^[A-Za-z][\w.-]*(\[[^\]]*\])?(\{[^}]*\})?:(\s.*|)$/.test(line);
    if (!header) return { ok: false, errorLine: i + 1 };
    allowIndent = true;
  }
  return { ok: true };
}
