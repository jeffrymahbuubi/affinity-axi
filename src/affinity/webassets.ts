// Pure planning for `webassets`: which artboard plays which role, the export
// jobs, the favicon.ico container, head.html, site.webmanifest and the
// webassets.json record. Nothing here connects to Affinity or touches disk.

import { safeName, targetSize, type AreaSpec, type Dim } from "./export-area.js";
import { UsageError } from "../output/errors.js";

export const PRESET_PNG = "PNG";
export const PRESET_SVG = "SVG (for export)";
export const PRESET_WEBP = "WebP (High Quality)";

export const DEFAULT_MARK = "mark";
export const DEFAULT_OG = "og";
export const DEFAULT_X = "x-card";

export interface BoardRef {
  index: number;
  name: string;
}

export interface WebFlags {
  /** Artboard names for the three fixed roles. */
  mark: string;
  og: string;
  x: string;
  /** True when the user passed the flag, so a missing board is an error rather than a skip. */
  explicit: { mark: boolean; og: boolean; x: boolean };
  responsive: string[];
  noFavicons: boolean;
  spread: number;
}

export interface Job {
  role: string;
  /** Output file name, relative to the out dir. */
  file: string;
  /** Artboard name the job exports (for messages and the manifest). */
  artboard: string;
  preset: string;
  area: AreaSpec;
  size: Dim | null;
}

/** One file the command wrote, as listed in the output and in webassets.json. */
export interface Written {
  role: string;
  file: string;
  /** "WxH" for raster files, "vector" for SVG, "" for text files. */
  size: string;
  bytes: number;
  artboard?: string;
  /** Alt-text stub for raster files (empty when the artboard has no text); absent with --no-alt. */
  alt?: string;
}

export interface Pick {
  kind: "mark" | "og" | "x" | "responsive";
  board: BoardRef;
}

/** Favicon-set PNG sizes: file name, edge in px, role. */
export const FAVICON_PNGS: Array<{ file: string; edge: number; role: string }> = [
  { file: "favicon-16.png", edge: 16, role: "favicon" },
  { file: "favicon-32.png", edge: 32, role: "favicon" },
  { file: "favicon-48.png", edge: 48, role: "favicon" },
  { file: "apple-touch-icon.png", edge: 180, role: "apple-touch-icon" },
  { file: "icon-192.png", edge: 192, role: "icon" },
  { file: "icon-512.png", edge: 512, role: "icon" },
];

/** Edges packed into favicon.ico, in this order. */
export const ICO_EDGES = [16, 32, 48];

/** File stems the fixed outputs use; a responsive name may not collide with them. */
const RESERVED_STEMS = new Set([
  "favicon",
  "favicon-16",
  "favicon-32",
  "favicon-48",
  "apple-touch-icon",
  "icon",
  "icon-192",
  "icon-512",
  "site",
  "head",
  "webassets",
  "og",
  "x-card",
]);

/** Case-sensitive match first, then case-insensitive, as `export --artboard` does. */
function findBoard(boards: BoardRef[], want: string): BoardRef[] {
  const exact = boards.filter((b) => b.name === want);
  if (exact.length > 0) return exact;
  return boards.filter((b) => b.name.toLowerCase() === want.toLowerCase());
}

/** Validates --responsive names offline: non-empty, unique, no clash with a role or a fixed file stem. */
export function checkResponsive(names: string[], roleNames: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (n.trim() === "") throw new UsageError("--responsive has an empty name", "use a comma list of artboard names, e.g. --responsive hero,banner");
    const stem = safeName(n).toLowerCase();
    if (seen.has(stem)) throw new UsageError(`--responsive names '${n}' twice`, "list each artboard once");
    seen.add(stem);
    if (RESERVED_STEMS.has(stem)) {
      throw new UsageError(`--responsive name '${n}' would overwrite a fixed output file (${stem})`, "rename the artboard, or export it with 'export --artboard' instead");
    }
    if (roleNames.some((r) => r.toLowerCase() === n.toLowerCase())) {
      throw new UsageError(`--responsive name '${n}' is already a role artboard (${roleNames.join(", ")})`, "list only artboards that are not mark, og or x-card");
    }
  }
}

/**
 * Maps roles to artboards. A missing role that was only a default lands in
 * `skipped`; a name the user typed that matches nothing, an ambiguous name, or
 * a missing mark (without --no-favicons) is a usage error.
 */
export function selectBoards(boards: BoardRef[], flags: WebFlags): { picks: Pick[]; skipped: string[] } {
  const listing = `artboards: ${boards.map((b) => b.name).join(", ") || "(none)"}`;
  const picks: Pick[] = [];
  const skipped: string[] = [];
  const one = (name: string, label: string): BoardRef | null => {
    const hits = findBoard(boards, name);
    if (hits.length > 1) throw new UsageError(`${label} artboard '${name}' is ambiguous (${hits.length} matches)`, listing);
    return hits[0] ?? null;
  };
  const roles: Array<{ kind: "mark" | "og" | "x"; name: string; flag: string }> = [];
  if (!flags.noFavicons) roles.push({ kind: "mark", name: flags.mark, flag: "--mark" });
  roles.push({ kind: "og", name: flags.og, flag: "--og" }, { kind: "x", name: flags.x, flag: "--x" });
  for (const r of roles) {
    const b = one(r.name, r.kind);
    if (b) picks.push({ kind: r.kind, board: b });
    else if (r.kind === "mark") {
      throw new UsageError(`no artboard named '${r.name}' for the favicon set`, `${listing}; name the square mark artboard '${DEFAULT_MARK}', pass ${r.flag} <name>, or use --no-favicons`);
    } else if (flags.explicit[r.kind]) {
      throw new UsageError(`no artboard named '${r.name}' for ${r.flag}`, listing);
    } else skipped.push(`${r.kind === "x" ? DEFAULT_X : r.kind} (no artboard named '${r.name}')`);
  }
  for (const name of flags.responsive) {
    const b = one(name, "responsive");
    if (!b) throw new UsageError(`no artboard named '${name}' for --responsive`, listing);
    picks.push({ kind: "responsive", board: b });
  }
  return { picks, skipped };
}

const areaOf = (spread: number, b: BoardRef): AreaSpec => ({ kind: "artboard", spread, index: b.index });

/**
 * The export jobs for the picked boards. `natural` maps a board index to its
 * natural pixel size (from the probe export); @2x sizes are computed from it.
 */
export function planJobs(
  boards: BoardRef[],
  flags: WebFlags,
  natural: ReadonlyMap<number, Dim> = new Map(),
): { jobs: Job[]; skipped: string[] } {
  const { picks, skipped } = selectBoards(boards, flags);
  const jobs: Job[] = [];
  for (const p of picks) {
    const area = areaOf(flags.spread, p.board);
    const art = p.board.name;
    if (p.kind === "mark") {
      for (const f of FAVICON_PNGS) {
        jobs.push({ role: f.role, file: f.file, artboard: art, preset: PRESET_PNG, area, size: { width: f.edge, height: f.edge } });
      }
      jobs.push({ role: "icon", file: "icon.svg", artboard: art, preset: PRESET_SVG, area, size: null });
    } else if (p.kind === "og") {
      jobs.push({ role: "og", file: "og.png", artboard: art, preset: PRESET_PNG, area, size: null });
    } else if (p.kind === "x") {
      jobs.push({ role: "x-card", file: "x-card.png", artboard: art, preset: PRESET_PNG, area, size: null });
    } else {
      const stem = safeName(art);
      const nat = natural.get(p.board.index);
      const x2 = nat ? targetSize(nat, { scale: 2 }) : null;
      jobs.push({ role: "responsive", file: `${stem}.png`, artboard: art, preset: PRESET_PNG, area, size: null });
      jobs.push({ role: "responsive", file: `${stem}@2x.png`, artboard: art, preset: PRESET_PNG, area, size: x2 });
      jobs.push({ role: "responsive", file: `${stem}.webp`, artboard: art, preset: PRESET_WEBP, area, size: null });
      jobs.push({ role: "responsive", file: `${stem}@2x.webp`, artboard: art, preset: PRESET_WEBP, area, size: x2 });
    }
  }
  return { jobs, skipped };
}

/** The presets a run needs, so a missing one fails before any export. */
export function presetsNeeded(flags: WebFlags): string[] {
  const need = [PRESET_PNG];
  if (!flags.noFavicons) need.push(PRESET_SVG);
  if (flags.responsive.length > 0) need.push(PRESET_WEBP);
  return need;
}

/**
 * An ICO container holding PNG-compressed images (valid since Windows Vista and
 * read by every browser): ICONDIR, one ICONDIRENTRY per image, then the PNG
 * files verbatim. An edge of 256 or more is written as 0, as the format asks.
 */
export function icoFromPngs(entries: Array<{ size: number; png: Buffer }>): Buffer {
  if (entries.length === 0) throw new Error("icoFromPngs: no images");
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type 1 = icon
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const at = 6 + 16 * i;
    const edge = e.size >= 256 ? 0 : e.size;
    head.writeUInt8(edge, at); // width
    head.writeUInt8(edge, at + 1); // height
    head.writeUInt8(0, at + 2); // palette colours
    head.writeUInt8(0, at + 3); // reserved
    head.writeUInt16LE(1, at + 4); // colour planes
    head.writeUInt16LE(32, at + 6); // bits per pixel
    head.writeUInt32LE(e.png.length, at + 8);
    head.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.png)]);
}

/** Entries of an ICO built by icoFromPngs: edge, byte length, offset. Used by tests and checks. */
export function parseIco(buf: Buffer): Array<{ edge: number; bytes: number; offset: number }> {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const n = buf.readUInt16LE(4);
  const out: Array<{ edge: number; bytes: number; offset: number }> = [];
  for (let i = 0; i < n; i++) {
    const at = 6 + 16 * i;
    out.push({ edge: buf.readUInt8(at) || 256, bytes: buf.readUInt32LE(at + 8), offset: buf.readUInt32LE(at + 12) });
  }
  return out;
}

/** "/" -> "/", "/static" -> "/static/", "https://x.test/a/" unchanged. */
export function normaliseHref(href: string): string {
  return href.endsWith("/") ? href : `${href}/`;
}

/** Checks --href before any connection: no whitespace, quotes or angle brackets in an attribute value. */
export function checkHref(href: string): string {
  if (href === "" || /[\s"'<>]/.test(href)) {
    throw new UsageError(`invalid --href '${href}'`, "use a URL prefix without spaces or quotes, e.g. --href / or --href https://example.com/");
  }
  return normaliseHref(href);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const has = (files: Written[], name: string): boolean => files.some((f) => f.file === name);

/** The head tags for the files that exist; `href` must already end with a slash. */
export function headHtml(files: Written[], href: string): string {
  const url = (f: string): string => esc(href + f);
  const lines: string[] = [];
  if (has(files, "icon.svg")) lines.push(`<link rel="icon" type="image/svg+xml" href="${url("icon.svg")}">`);
  if (has(files, "favicon-32.png")) lines.push(`<link rel="icon" type="image/png" sizes="32x32" href="${url("favicon-32.png")}">`);
  if (has(files, "favicon-16.png")) lines.push(`<link rel="icon" type="image/png" sizes="16x16" href="${url("favicon-16.png")}">`);
  if (has(files, "apple-touch-icon.png")) lines.push(`<link rel="apple-touch-icon" href="${url("apple-touch-icon.png")}">`);
  if (has(files, "site.webmanifest")) lines.push(`<link rel="manifest" href="${url("site.webmanifest")}">`);
  const og = files.find((f) => f.file === "og.png");
  if (og) {
    lines.push(`<meta property="og:image" content="${url("og.png")}">`);
    const m = /^(\d+)x(\d+)$/.exec(og.size);
    if (m) {
      lines.push(`<meta property="og:image:width" content="${m[1]}">`);
      lines.push(`<meta property="og:image:height" content="${m[2]}">`);
    }
    if (og.alt) lines.push(`<meta property="og:image:alt" content="${esc(og.alt)}">`);
  }
  const card = has(files, "x-card.png") ? "x-card.png" : og ? "og.png" : null;
  if (card) {
    lines.push('<meta name="twitter:card" content="summary_large_image">');
    lines.push(`<meta name="twitter:image" content="${url(card)}">`);
    const cardAlt = files.find((f) => f.file === card)?.alt;
    if (cardAlt) lines.push(`<meta name="twitter:image:alt" content="${esc(cardAlt)}">`);
  }
  return lines.join("\n") + "\n";
}

/** site.webmanifest: the 192 and 512 icons plus the theme colour. */
export function webManifestJson(files: Written[], href: string, theme: string, name?: string): string {
  const icons = [192, 512]
    .filter((e) => has(files, `icon-${e}.png`))
    .map((e) => ({ src: href + `icon-${e}.png`, sizes: `${e}x${e}`, type: "image/png" }));
  const body: Record<string, unknown> = {};
  if (name) {
    body["name"] = name;
    body["short_name"] = name;
  }
  body["icons"] = icons;
  body["theme_color"] = theme;
  body["background_color"] = theme;
  body["display"] = "standalone";
  return JSON.stringify(body, null, 2) + "\n";
}

/** The webassets.json record. `files` should not list webassets.json itself. */
export function recordJson(doc: string, at: string, files: Written[], skipped: string[], notes: string[]): string {
  return (
    JSON.stringify({ schema: "affinity-axi/webassets/1", doc, at, files, skipped, notes }, null, 2) + "\n"
  );
}

/** #RGB or #RRGGBB to lower-case #rrggbb; null when it is neither. */
export function normaliseTheme(raw: string): string | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(raw);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return "#" + (h.length === 3 ? h.split("").map((c) => c + c).join("") : h);
}
