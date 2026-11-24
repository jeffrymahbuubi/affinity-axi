// --brief / --quiet: one line per written file for loops that only need the numbers.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Parsed } from "../cli/args.js";
import type { FlagSpec } from "../cli/spec.js";
import { shown } from "../affinity/paths.js";
import { emitList } from "../output/toon.js";

export function briefFlags(description: string): FlagSpec[] {
  return [
    { name: "brief", type: "boolean", description },
    { name: "quiet", type: "boolean", description: "same as --brief" },
  ];
}

export function isBrief(parsed: Parsed): boolean {
  return parsed.flags["brief"] === true || parsed.flags["quiet"] === true;
}

/** First 16 hex characters of the file's sha256; "" when unreadable. */
export function digest16(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

export interface BriefFile {
  path: string;
  bytes: number;
  size?: string;
}

export function briefLine(key: string, f: BriefFile, extra: Array<[string, string | number | boolean]> = []): string {
  const more = extra.map(([k, v]) => ` ${k}=${v}`).join("");
  return `${key}: bytes=${f.bytes}${f.size ? ` size=${f.size}` : ""} sha256=${digest16(f.path)}${more} path=${shown(f.path)}`;
}

export function briefList(name: string, files: BriefFile[]): string {
  const rows = files.map((f) => ({ path: shown(f.path), bytes: f.bytes, size: f.size ?? "", sha256: digest16(f.path) }));
  return emitList(name, rows, ["path", "bytes", "size", "sha256"]);
}
