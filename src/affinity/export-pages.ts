// Multi-page exports. On a document with more than one page, Affinity's
// whole-document and `--spread N` exports do not write the asked path; they
// write `<stem>_<k><ext>` (k from 1) next to it. This module finds those files
// after the export, so `export` can rename the single page of a spread export
// to the asked name, or keep and clean every page file of a whole-document
// export (the metadata strip must run on them too).

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { emitKV } from "../output/toon.js";
import { imageSize } from "./export-area.js";

/** Affinity numbers pages from 1; looking past this many is pointless. */
const MAX_PAGE = 999;
/** File times are compared with this much slack (coarse file systems). */
const SLACK_MS = 1000;

/** The export areas that can come back as page files. */
export type PageMode = "whole" | "spread";

/** A written page file as reported; shaped like the export command's Written row. */
export interface PageRow {
  name: string;
  path: string;
  area: null;
  bytes: number;
  size: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function modifiedSince(file: string, sinceMs: number): boolean {
  try {
    return statSync(file).mtimeMs >= sinceMs - SLACK_MS;
  } catch {
    return false;
  }
}

/** `<dir>/<stem>_<k><ext>` files (k = 1..999) next to `path` written at or after sinceMs - 1 s, in page order. */
export function pageFilesFor(path: string, sinceMs: number): string[] {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  const re = new RegExp(`^${escapeRe(stem)}_(\\d{1,3})${escapeRe(ext)}$`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const hits: Array<{ k: number; file: string }> = [];
  for (const n of names) {
    const m = re.exec(n);
    const k = m ? Number(m[1]) : 0;
    if (k >= 1 && k <= MAX_PAGE && modifiedSince(join(dir, n), sinceMs)) hits.push({ k, file: join(dir, n) });
  }
  return hits.sort((a, b) => a.k - b.k).map((h) => h.file);
}

/**
 * Call right after an export of the whole document or one spread. When `path` was not written by that
 * export (missing, or older than sinceMs) and page files were, then:
 * - a spread export with exactly one page file renames it onto `path` (the name the user asked for) and returns null;
 * - anything else returns the page files in page order (the caller finalizes each).
 * Returns null when `path` itself is fresh or no page file is.
 */
export function recoverPages(path: string, mode: PageMode, sinceMs: number): string[] | null {
  if (existsSync(path) && modifiedSince(path, sinceMs)) return null;
  const files = pageFilesFor(path, sinceMs);
  if (files.length === 0) return null;
  if (mode === "spread" && files.length === 1) {
    try {
      renameSync(files[0]!, path);
      return null;
    } catch {
      // cannot rename: keep the page file and report it as it is
    }
  }
  return files;
}

/** The `note:` value naming the page files. */
export function pagesNote(files: string[]): string {
  const first = basename(files[0]!);
  const last = basename(files[files.length - 1]!);
  return `pages: ${files.length} files (${first} … ${last}; Affinity names multi-page exports per page)`;
}

/** Bytes and pixel size read from disk, one row per page file. */
export function pageRows(files: string[]): PageRow[] {
  return files.map((path) => {
    let buf = Buffer.alloc(0);
    try {
      buf = readFileSync(path);
    } catch {
      // reported as 0 bytes
    }
    const dim = imageSize(buf);
    return { name: "", path, area: null, bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
  });
}

/** The TOON report of a multi-page export: one `export:` block per file, then the shared lines and the note. */
export function pagesReport(uuid: string, preset: string, rows: PageRow[], tags: Array<[string, string]>): string {
  const parts = rows.map((r) => emitKV([["export", r.path], ["bytes", r.bytes], ...(r.size !== "" ? ([["size", r.size]] as Array<[string, string]>) : [])]));
  parts.push(emitKV([["doc", uuid], ["preset", preset], ...tags, ["note", pagesNote(rows.map((r) => r.path))]]));
  return parts.join("\n");
}
