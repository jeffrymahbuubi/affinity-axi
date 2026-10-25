// `batch` data handling: JSON/CSV record loading and key derivation. Pure and
// offline (no Affinity), so every error here surfaces before a connection.

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { UsageError } from "../output/errors.js";

export type DataRecord = Record<string, unknown>;

/**
 * RFC 4180 parser: comma separated, double-quote quoting with "" as an
 * escaped quote, CRLF/LF/CR record breaks (also inside quotes, kept verbatim).
 * Returns rows of fields; a trailing line break does not produce an empty row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // anything seen on the current row (distinguishes "" row from no row)
  let afterQuote = false; // a quoted field just closed: only a separator may follow
  const endField = (): void => {
    row.push(field);
    field = "";
    afterQuote = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (afterQuote && c !== "," && c !== "\r" && c !== "\n") {
      throw new UsageError("malformed CSV: text follows a closing quote", "quote the whole field and double any inner quotes (\"\")");
    }
    if (c === '"') {
      if (field !== "") throw new UsageError("malformed CSV: a quote in the middle of an unquoted field", "quote the whole field and double any inner quotes (\"\")");
      inQuotes = true;
      started = true;
    } else if (c === ",") {
      endField();
      started = true;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
    } else {
      field += c;
      started = true;
    }
  }
  if (inQuotes) throw new UsageError("malformed CSV: unterminated quoted field", "close the quote or double any inner quotes (\"\")");
  if (started || field !== "") endRow();
  return rows;
}

function csvRecords(text: string, file: string): DataRecord[] {
  const rows = parseCsv(text.replace(/^﻿/, "")).filter((r) => !(r.length === 1 && r[0] === ""));
  if (rows.length === 0) return [];
  const header = rows[0]!.map((h) => h.trim());
  if (header.some((h) => h === "")) throw new UsageError(`${file}: CSV header has an empty column name`, "name every column in the first row");
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) throw new UsageError(`${file}: CSV header repeats column '${dup}'`, "column names must be unique");
  return rows.slice(1).map((r, i) => {
    if (r.length !== header.length) {
      throw new UsageError(`${file}: CSV row ${i + 2} has ${r.length} fields, expected ${header.length}`, "quote fields that contain commas or line breaks");
    }
    const rec: DataRecord = {};
    header.forEach((h, j) => (rec[h] = r[j]));
    return rec;
  });
}

function jsonRecords(text: string, file: string): DataRecord[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (err) {
    throw new UsageError(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, "the file must be a JSON array of objects");
  }
  if (!Array.isArray(v)) throw new UsageError(`${file}: JSON data must be an array of objects`, `wrap the records in [ ... ]`);
  v.forEach((r, i) => {
    if (r === null || typeof r !== "object" || Array.isArray(r)) {
      throw new UsageError(`${file}: record ${i} is not an object`, "every element of the array must be an object like {\"slug\":\"a\"}");
    }
  });
  return v as DataRecord[];
}

/** Reads a .json (array of objects) or .csv (header row + records) file. */
export function loadRecords(file: string): DataRecord[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`cannot read data file '${file}'`, "usage: affinity-axi batch <template.js> --data <file.json|file.csv>");
  }
  const ext = extname(file).toLowerCase();
  if (ext === ".json") return jsonRecords(text, file);
  if (ext === ".csv") return csvRecords(text, file);
  throw new UsageError(`unsupported data file type '${ext || file}'`, "use a .json (array of objects) or .csv file");
}

/**
 * Filesystem-safe name: letters and digits of any script, dot, underscore, dash;
 * Latin diacritics are dropped (Ärger -> Arger); never leading dot/dash, never empty.
 */
export function sanitizeKey(raw: string, fallback: string): string {
  const s = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return s === "" ? fallback : s;
}

/**
 * One key per record (same order). Without keyField the key is the record
 * index. A missing/empty/non-scalar keyField value or two records that
 * sanitize to the same key is a usage error (exit 2): files would collide.
 */
export function deriveKeys(records: DataRecord[], keyField: string | undefined): string[] {
  const seen = new Map<string, number>();
  return records.map((rec, i) => {
    let key: string;
    if (keyField === undefined) {
      key = String(i);
    } else {
      const v = rec[keyField];
      if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
        throw new UsageError(`record ${i} has no '${keyField}' field for --key`, `add '${keyField}' to every record or pick another --key field`);
      }
      if (typeof v === "object") throw new UsageError(`record ${i}: --key field '${keyField}' must be a string or number`, "use a scalar field");
      key = sanitizeKey(String(v), `record-${i}`);
    }
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new UsageError(`records ${prev} and ${i} both map to the key '${key}'`, "keys must be unique (they name the output files); pick a unique --key field");
    }
    seen.set(key, i);
    return key;
  });
}

/** Record fields that `batch` replaces in ARGS with its own values. */
export const BATCH_RESERVED: readonly string[] = ["key", "index", "outDir", "outBase"];

/** Reserved names present in any record, in BATCH_RESERVED order, each once; [] when none. */
export function reservedFields(records: DataRecord[]): string[] {
  return BATCH_RESERVED.filter((name) => records.some((rec) => Object.prototype.hasOwnProperty.call(rec, name)));
}
