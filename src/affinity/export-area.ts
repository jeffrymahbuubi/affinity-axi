// Export area and size support for `export`: SDK snippets, flag validation,
// artboard file naming and image header readers.
//
// Real SDK facts (probed live on Affinity 3.3.1):
//   Document.export(path, FileExportOptions, FileExportArea|null, size|null)
//   `size` is a plain Size {width, height} in output pixels (anything else:
//   "expected Size or null"). ExportSize/ExportScale are for ExportConfig
//   slices and make Document.export throw INVALID_OP. A Size is applied as
//   given (it stretches), so aspect-preserving sizes are computed here from
//   the natural export dimensions.
//   FileExportArea.createForArtboard(ArtboardInterface), createForSelection(selection),
//   createForSpreads("1") is 1-based. Artboard names are ArtboardInterface.description.
//
// The console.log calls inside the script strings are required output.

import { UsageError } from "../output/errors.js";
import type { Parsed } from "../cli/args.js";
import { jpegSize } from "./jpeg.js";

export type AreaSpec =
  | { kind: "artboard"; spread: number; index: number }
  | { kind: "selection" }
  | { kind: "spread"; spread: number };

export interface SizeSpec {
  width?: number;
  height?: number;
  scale?: number;
  square?: number;
}

export interface Dim {
  width: number;
  height: number;
}

export const MAX_SIDE = 16384;
const MAX_SCALE = 16;

const DOC_REQUIRE = "const { Document, FileExportOptions, FileExportArea } = require('/document.js');";
const FIND_DOC = [
  "const doc = Document.all.find((d) => String(d.sessionUuid) === targetUuid);",
  "if (!doc) { throw new Error('No document with that Uuid exists.'); }",
];

/** Logs {"spreads": n, "artboards": [{"index","name"}]} for one spread (0-based). */
export function LIST_ARTBOARDS(docUuid: string, spread: number): string {
  return [
    "/* affinity-axi:list-artboards */",
    DOC_REQUIRE,
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    `const spreadIndex = ${JSON.stringify(spread)};`,
    ...FIND_DOC,
    "const spreads = Array.from(doc.spreads);",
    "const sp = spreads[spreadIndex];",
    "if (!sp) { throw new Error('No spread ' + spreadIndex + '; the document has ' + spreads.length + ' spread(s).'); }",
    "console.log(JSON.stringify({ spreads: spreads.length, artboards: sp.artboards.map((a, i) => ({ index: i, name: String(a.description) })) }));",
  ].join("\n");
}

/** Exports one area (and optionally a pixel size) of a document. Logs {"exported": path}. */
export function EXPORT_AREA(docUuid: string, preset: string, path: string, area: AreaSpec | null, size: Dim | null): string {
  return [
    "/* affinity-axi:area-export */",
    DOC_REQUIRE,
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    `const presetName = ${JSON.stringify(preset)};`,
    `const outPath = ${JSON.stringify(path)};`,
    `const area = ${JSON.stringify(area)};`,
    `const outSize = ${JSON.stringify(size)};`,
    ...FIND_DOC,
    "let exportArea = null;",
    "if (area && area.kind === 'artboard') {",
    "  const sp = Array.from(doc.spreads)[area.spread];",
    "  if (!sp) { throw new Error('No spread ' + area.spread + '.'); }",
    "  const ab = sp.artboards[area.index];",
    "  if (!ab) { throw new Error('No artboard at index ' + area.index + ' on spread ' + area.spread + '.'); }",
    "  exportArea = FileExportArea.createForArtboard(ab);",
    "} else if (area && area.kind === 'selection') {",
    "  if (doc.selection.length === 0) { throw new Error('Nothing is selected in the document.'); }",
    "  exportArea = FileExportArea.createForSelection(doc.selection);",
    "} else if (area && area.kind === 'spread') {",
    "  exportArea = FileExportArea.createForSpreads(String(area.spread + 1));",
    "}",
    "doc.export(outPath, FileExportOptions.createWithPresetName(presetName), exportArea, outSize);",
    "console.log(JSON.stringify({ exported: outPath }));",
  ].join("\n");
}

function intFlag(parsed: Parsed, name: string, max: number): number | undefined {
  const raw = parsed.flags[name];
  if (raw === undefined) return undefined;
  const s = String(raw);
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > max) {
    throw new UsageError(`invalid --${name} '${s}'`, `use a whole number of pixels from 1 to ${max}`);
  }
  return Number(s);
}

/** Validates --width/--height/--scale/--square (no connection needed). Null when none was given. */
export function parseSizeFlags(parsed: Parsed): SizeSpec | null {
  const spec: SizeSpec = {};
  const width = intFlag(parsed, "width", MAX_SIDE);
  const height = intFlag(parsed, "height", MAX_SIDE);
  const square = intFlag(parsed, "square", MAX_SIDE);
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;
  if (square !== undefined) spec.square = square;
  const rawScale = parsed.flags["scale"];
  if (rawScale !== undefined) {
    const s = String(rawScale);
    const n = Number(s);
    if (!/^\d+(\.\d+)?$/.test(s) || !(n > 0) || n > MAX_SCALE) {
      throw new UsageError(`invalid --scale '${s}'`, `use a positive number up to ${MAX_SCALE}, e.g. --scale 2 for @2x`);
    }
    spec.scale = n;
  }
  const given = Object.keys(spec);
  if (given.length === 0) return null;
  if (spec.square !== undefined && given.length > 1) {
    throw new UsageError("--square cannot be combined with --width, --height or --scale", "use --square <px> alone");
  }
  if (spec.scale !== undefined && given.length > 1) {
    throw new UsageError("--scale cannot be combined with --width, --height or --square", "use --scale <n> alone");
  }
  return spec;
}

/** Target pixel size for a natural export size. --width/--height alone keep the aspect ratio; both together stretch. */
export function targetSize(natural: Dim, spec: SizeSpec): Dim {
  const r = (n: number): number => Math.max(1, Math.round(n));
  let out: Dim;
  if (spec.scale !== undefined) out = { width: r(natural.width * spec.scale), height: r(natural.height * spec.scale) };
  else if (spec.square !== undefined) {
    const f = spec.square / Math.max(natural.width, natural.height);
    out = { width: r(natural.width * f), height: r(natural.height * f) };
  } else if (spec.width !== undefined && spec.height !== undefined) out = { width: spec.width, height: spec.height };
  else if (spec.width !== undefined) out = { width: spec.width, height: r((natural.height * spec.width) / natural.width) };
  else out = { width: r((natural.width * (spec.height ?? natural.height)) / natural.height), height: spec.height ?? natural.height };
  if (out.width > MAX_SIDE || out.height > MAX_SIDE) {
    throw new UsageError(`requested size ${out.width}x${out.height} exceeds ${MAX_SIDE} px`, "choose a smaller --width, --height, --scale or --square");
  }
  return out;
}

/** Filesystem-safe form of an artboard name: no separators or reserved characters, no leading dot. */
export function safeName(name: string): string {
  const s = name
    .normalize("NFKC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.\-]+/, "")
    .replace(/[.\-]+$/, "")
    .slice(0, 80);
  return s === "" ? "artboard" : s;
}

/** Safe names for a list of artboards; duplicates get -2, -3 ... so no file is overwritten. */
export function uniqueSafeNames(names: string[]): string[] {
  const used = new Map<string, number>();
  return names.map((n) => {
    const base = safeName(n);
    const key = base.toLowerCase(); // case-insensitive filesystems
    const count = (used.get(key) ?? 0) + 1;
    used.set(key, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export type ImageKind = "png" | "jpeg" | "webp";

export function imageKind(buf: Buffer): ImageKind | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

/** Width and height from the PNG IHDR chunk. */
export function pngSize(buf: Buffer): Dim | null {
  if (imageKind(buf) !== "png" || buf.length < 24 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Width and height from a WebP VP8, VP8L or VP8X header. */
export function webpSize(buf: Buffer): Dim | null {
  if (imageKind(buf) !== "webp" || buf.length < 30) return null;
  const fourcc = buf.toString("ascii", 12, 16);
  let dim: Dim | null = null;
  if (fourcc === "VP8 ") dim = { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  else if (fourcc === "VP8L") {
    const bits = buf.readUInt32LE(21);
    dim = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  } else if (fourcc === "VP8X") {
    dim = { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  return dim && dim.width > 0 && dim.height > 0 ? dim : null;
}

/** Pixel size of a PNG, JPEG or WebP file's bytes; null for anything else (SVG, PDF ...). */
export function imageSize(buf: Buffer): Dim | null {
  switch (imageKind(buf)) {
    case "png":
      return pngSize(buf);
    case "jpeg":
      return jpegSize(buf);
    case "webp":
      return webpSize(buf);
    default:
      return null;
  }
}
