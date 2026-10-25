// `webassets <doc> --out-dir <dir>`: the launch files of a website from named
// artboards (favicons, apple-touch-icon, site icons, OG and X cards, @1x/@2x
// responsive sets) plus head.html, site.webmanifest and webassets.json.
// Planning is pure (affinity/webassets.ts); this module runs the exports.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { ALT_TEXT_CHARS, NO_ALT_FLAG, altFor } from "../affinity/alt-text.js";
import { EXPORT_AREA, LIST_ARTBOARDS, imageSize, type Dim } from "../affinity/export-area.js";
import { INSPECT } from "../affinity/inspect-script.js";
import { finalizeFile, metadataNote, type MetaOutcome } from "../affinity/metadata.js";
import { readManifest, writeManifest } from "../affinity/manifest.js";
import type { Inventory } from "../affinity/manifest-types.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { recordsFor } from "../affinity/provenance.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, LIST_DOCUMENTS, LIST_PRESETS } from "../affinity/scripts.js";
import {
  DEFAULT_MARK,
  DEFAULT_OG,
  DEFAULT_X,
  FAVICON_PNGS,
  ICO_EDGES,
  PRESET_PNG,
  checkHref,
  checkResponsive,
  headHtml,
  icoFromPngs,
  normaliseTheme,
  planJobs,
  presetsNeeded,
  recordJson,
  selectBoards,
  webManifestJson,
  type BoardRef,
  type Job,
  type WebFlags,
  type Written,
} from "../affinity/webassets.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { AffinityClient, ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";

interface Options {
  outDir: string;
  href: string;
  theme: string;
  flags: WebFlags;
  noAlt: boolean;
  url: string | undefined;
}

function str(parsed: Parsed, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Validates every flag before any connection. */
function parseOptions(parsed: Parsed): Options {
  const outRaw = str(parsed, "out-dir");
  if (outRaw === undefined || outRaw.trim() === "") {
    throw new UsageError("--out-dir is required", "e.g. webassets <doc> --out-dir ~/Desktop/site --responsive hero");
  }
  const themeRaw = str(parsed, "theme") ?? "#ffffff";
  const theme = normaliseTheme(themeRaw);
  if (theme === null) throw new UsageError(`invalid --theme '${themeRaw}'`, "use a hex colour such as #1f2a44");
  const spreadRaw = str(parsed, "spread");
  if (spreadRaw !== undefined && !/^\d+$/.test(spreadRaw)) {
    throw new UsageError(`invalid --spread '${spreadRaw}'`, "use a spread index starting at 0, e.g. --spread 0");
  }
  const noFavicons = parsed.flags["no-favicons"] === true;
  const markFlag = str(parsed, "mark");
  const ogFlag = str(parsed, "og");
  const xFlag = str(parsed, "x");
  for (const [flag, v] of [["mark", markFlag], ["og", ogFlag], ["x", xFlag]] as const) {
    if (v !== undefined && v.trim() === "") throw new UsageError(`--${flag} needs an artboard name`, "pass the artboard name");
  }
  const mark = markFlag ?? DEFAULT_MARK;
  const og = ogFlag ?? DEFAULT_OG;
  const x = xFlag ?? DEFAULT_X;
  const roles = noFavicons ? [og, x] : [mark, og, x];
  if (new Set(roles.map((r) => r.toLowerCase())).size !== roles.length) {
    throw new UsageError("--mark, --og and --x name the same artboard twice", "give each role its own artboard");
  }
  const respRaw = str(parsed, "responsive");
  const responsive = respRaw === undefined ? [] : respRaw.split(",").map((s) => s.trim());
  checkResponsive(responsive, roles);
  const href = checkHref(str(parsed, "href") ?? "/");
  return {
    outDir: userPath(outRaw),
    href,
    theme,
    noAlt: parsed.flags["no-alt"] === true,
    url: str(parsed, "url"),
    flags: {
      mark,
      og,
      x,
      explicit: { mark: markFlag !== undefined, og: ogFlag !== undefined, x: xFlag !== undefined },
      responsive,
      noFavicons,
      spread: spreadRaw === undefined ? 0 : Number(spreadRaw),
    },
  };
}

async function runScript(client: AffinityClient, script: string, what: string): Promise<string> {
  const result = await client.callTool("execute_script", { script });
  if (classify(result).kind !== "ok") {
    const first = resultText(result).split("\n").find((l) => l.trim() !== "") ?? "unknown failure";
    throw new AxiError(`${what}: ${first}`, `check the out dir is writable and the preset suits this document; list presets with '${BIN} presets'`);
  }
  return resultText(result);
}

function readBytes(path: string, what: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new AxiError(`${what}: the export reported success but ${path} was not written`, "check the folder exists and retry");
  }
}

async function listBoards(client: AffinityClient, doc: DocInfo, spread: number): Promise<BoardRef[]> {
  const out = await runScript(client, LIST_ARTBOARDS(doc.uuid, spread), "listing artboards failed");
  try {
    const boards = (JSON.parse(out.trim().split("\n").pop() ?? "") as { artboards: BoardRef[] }).artboards;
    if (Array.isArray(boards)) return boards;
  } catch {
    // fall through to the error below
  }
  throw new AxiError("could not read the artboard list from Affinity", "retry; check the document with 'affinity-axi render'");
}

/** Alt-text stubs keyed by artboard name; best effort, so an unreadable inventory yields no stubs and a note. */
async function altStubs(client: AffinityClient, doc: DocInfo, boards: string[], notes: string[]): Promise<Map<string, string>> {
  const alts = new Map<string, string>();
  try {
    const inv = await callJson<Inventory>(client, INSPECT(doc.uuid, { textChars: ALT_TEXT_CHARS }), "reading the document text for alt text");
    if (!Array.isArray(inv.nodes)) throw new Error("no nodes");
    for (const name of boards) alts.set(name, altFor(inv, { kind: "artboard", name }));
  } catch {
    notes.push("alt text skipped: could not read the document text (retry, or pass --no-alt)");
  }
  return alts;
}

const isRaster = (file: string): boolean => /\.(png|webp)$/i.test(file);

const dimText = (d: Dim): string => `${d.width}x${d.height}`;

/** Natural-size probe of each picked artboard; the probe files are removed. */
async function probe(client: AffinityClient, doc: DocInfo, boards: BoardRef[], spread: number, dir: string): Promise<Map<number, Dim>> {
  const natural = new Map<number, Dim>();
  for (const b of boards) {
    const file = join(dir, `probe-${b.index}.png`);
    try {
      await runScript(client, EXPORT_AREA(doc.uuid, PRESET_PNG, file, { kind: "artboard", spread, index: b.index }, null), `export of artboard '${b.name}' failed`);
      const dim = imageSize(readBytes(file, `probe of artboard '${b.name}'`));
      if (!dim) throw new AxiError(`cannot read the pixel size of artboard '${b.name}'`, "the PNG preset should produce a PNG; check 'presets'");
      natural.set(b.index, dim);
    } finally {
      rmSync(file, { force: true });
    }
  }
  return natural;
}

/** Appends the written files to `exports` in the saved document's manifest; best effort and silent. */
function recordExports(doc: DocInfo, jobs: Job[], written: Written[], dir: string, generated: boolean): void {
  if (!doc.path) return;
  try {
    const m = readManifest(doc.path);
    if (!m) return;
    const now = new Date().toISOString();
    const byFile = new Map(jobs.map((j) => [j.file, j]));
    m.exports = [
      ...(m.exports ?? []),
      ...written.flatMap((w) => {
        const j = byFile.get(w.file);
        if (!j) return [];
        return [{ time: now, path: join(dir, w.file), preset: j.preset, area: `artboard:${j.artboard}`, size: w.size, bytes: w.bytes, aiGenerated: generated }];
      }),
    ];
    writeManifest(doc.path, m);
  } catch {
    // the exports succeeded; a manifest problem must not fail them
  }
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "webassets",
      summary: "Export website launch files from named artboards: favicons, OG and X cards, @1x/@2x sets, head.html",
      args: [{ name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" }],
      flags: [
        { name: "out-dir", type: "string", description: "folder for the files; must be inside the Desktop folder (created if missing, files overwritten)" },
        { name: "mark", type: "string", description: `square mark artboard for the favicon set (default '${DEFAULT_MARK}')` },
        { name: "og", type: "string", description: `Open Graph card artboard (default '${DEFAULT_OG}')` },
        { name: "x", type: "string", description: `X card artboard (default '${DEFAULT_X}')` },
        { name: "responsive", type: "string", description: "comma list of artboards exported as name.png, name@2x.png, name.webp, name@2x.webp" },
        { name: "href", type: "string", description: "URL prefix written into head.html and site.webmanifest (default /)" },
        { name: "theme", type: "string", description: "theme colour for site.webmanifest, hex (default #ffffff)" },
        { name: "no-favicons", type: "boolean", description: "skip the favicon set (cards and responsive sets only)" },
        { name: "spread", type: "string", description: "spread index from 0 that holds the artboards (default 0)" },
        NO_ALT_FLAG,
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        `${BIN} webassets current --out-dir ~/Desktop/site`,
        `${BIN} webassets 70E876CB --out-dir ~/Desktop/site --responsive hero --href https://example.com/`,
        `${BIN} webassets current --out-dir ~/Desktop/site --no-favicons --og social`,
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const [ref] = parsed.positionals as [string];
      const opts = parseOptions(parsed);
      requireVisible(opts.outDir, "--out-dir");
      const { flags } = opts;

      const client = await connect({ url: opts.url });
      let doc: DocInfo;
      let jobs: Job[];
      let skipped: string[];
      const written: Written[] = [];
      const notes: string[] = [];
      const bytesOf = new Map<string, Buffer>();
      const outcomes: MetaOutcome[] = [];
      try {
        const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
        for (const need of presetsNeeded(flags)) {
          if (!presets.includes(need)) {
            throw new AxiError(`export preset '${need}' is not installed`, `webassets needs ${presetsNeeded(flags).join(", ")}; list presets with '${BIN} presets'`);
          }
        }
        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, opts.outDir, "--out-dir", "write-folder");
        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(client, LIST_DOCUMENTS, "listing documents");
        doc = resolveDocRef(ref, listing.documents, listing.current);
        const boards = await listBoards(client, doc, flags.spread);
        const picked = selectBoards(boards, flags).picks;

        mkdirSync(opts.outDir, { recursive: true });
        const unique = [...new Map(picked.map((p) => [p.board.index, p.board])).values()];
        const natural = await probe(client, doc, unique, flags.spread, opts.outDir);
        for (const p of picked) {
          const dim = natural.get(p.board.index)!;
          if (p.kind === "mark" && dim.width !== dim.height) {
            throw new UsageError(`mark artboard '${p.board.name}' is ${dimText(dim)}, not square`, "resize the artboard to a square (e.g. 512x512) or pass --mark <name> for another one");
          }
          if (p.kind === "og" && (dim.width !== 1200 || dim.height !== 630)) notes.push(`og artboard '${p.board.name}' is ${dimText(dim)}; Open Graph cards are 1200x630`);
          if (p.kind === "x" && (dim.width !== 1200 || (dim.height !== 600 && dim.height !== 630))) {
            notes.push(`x-card artboard '${p.board.name}' is ${dimText(dim)}; X cards are 1200x600 or 1200x630`);
          }
        }

        ({ jobs, skipped } = planJobs(boards, flags, natural));
        if (jobs.length === 0) throw new UsageError("nothing to export: no mark, og, x-card or responsive artboard found", "name artboards mark, og and x-card, or pass --responsive <name>");
        const alts = opts.noAlt ? new Map<string, string>() : await altStubs(client, doc, [...new Set(jobs.map((j) => j.artboard))], notes);
        for (const j of jobs) {
          const file = join(opts.outDir, j.file);
          await runScript(client, EXPORT_AREA(doc.uuid, j.preset, file, j.area, j.size), `export of ${j.file} (artboard '${j.artboard}') failed`);
          outcomes.push(finalizeFile(file, {})); // strip Affinity's XMP; webassets embeds no credit
          const buf = readBytes(file, `export of ${j.file}`);
          bytesOf.set(j.file, buf);
          const dim = imageSize(buf);
          if (j.size && (!dim || dim.width !== j.size.width || dim.height !== j.size.height)) {
            throw new AxiError(
              `${j.file} came out ${dim ? dimText(dim) : "unreadable"}, expected ${dimText(j.size)}`,
              "the export size argument was not honoured for this preset; export it with 'export --artboard … --width/--height' instead",
            );
          }
          const alt = isRaster(j.file) ? alts.get(j.artboard) : undefined;
          written.push({
            role: j.role,
            file: j.file,
            size: dim ? dimText(dim) : j.file.endsWith(".svg") ? "vector" : "",
            bytes: buf.length,
            artboard: j.artboard,
            ...(alt !== undefined ? { alt } : {}),
          });
        }
      } finally {
        client.close();
      }

      const put = (role: string, file: string, text: string | Buffer): void => {
        writeFileSync(join(opts.outDir, file), text);
        written.push({ role, file, size: "", bytes: Buffer.byteLength(text) });
      };
      if (!flags.noFavicons) {
        const ico = icoFromPngs(ICO_EDGES.map((edge) => ({ size: edge, png: bytesOf.get(FAVICON_PNGS.find((f) => f.edge === edge)!.file)! })));
        writeFileSync(join(opts.outDir, "favicon.ico"), ico);
        written.push({ role: "favicon", file: "favicon.ico", size: ICO_EDGES.join("+"), bytes: ico.length });
        put("webmanifest", "site.webmanifest", webManifestJson(written, opts.href, opts.theme, siteName(doc.title)));
        notes.push("apple-touch-icon uses the artboard fill as its ground; give the mark artboard a fill");
      }
      put("head", "head.html", headHtml(written, opts.href));
      const metaNote = metadataNote(outcomes);
      if (metaNote !== null) notes.push(`metadata: ${metaNote}`);
      const generated = recordsFor(doc.uuid).length > 0;
      if (generated) notes.push("document has generative provenance; webassets writes no metadata or sidecars, use 'export' for tagged files");
      const jsonPath = join(opts.outDir, "webassets.json");
      writeFileSync(jsonPath, recordJson(doc.uuid, new Date().toISOString(), written, skipped, notes));
      const files = [...written, { role: "record", file: "webassets.json", size: "", bytes: statBytes(jsonPath) }];

      recordExports(doc, jobs, written, opts.outDir, generated);

      const parts = [
        emitKV([["doc", doc.uuid]]),
        emitList("files", files.map((f) => ({ ...f })), ["role", "file", "size", "bytes"]),
        emitKV([["manifest", jsonPath], ["head", join(opts.outDir, "head.html")]]),
      ];
      if (skipped.length > 0) parts.push(`skipped[${skipped.length}]: ${skipped.join("; ")}`);
      for (const n of notes) parts.push(`note: ${n}`);
      const card = jobs.find((j) => j.role === "og");
      const help = [`open ${join(opts.outDir, "head.html")}`];
      if (written.some((w) => w.alt)) help.push("edit the alt text in webassets.json and head.html before publishing");
      if (card) help.push(`${BIN} export ${doc.uuid.slice(0, 8)} PNG ${join(opts.outDir, "og@2x.png")} --artboard ${card.artboard} --scale 2`);
      parts.push(helpBlock(help));
      print(parts.join("\n"));
      return 0;
    },
  };
}

/** Document title without the .af suffix; empty for an untitled document ("<Untitled>"). */
function siteName(title: string): string {
  const t = title.replace(/\.af$/i, "").trim();
  return /^<.*>$/.test(t) ? "" : t;
}

function statBytes(path: string): number {
  return readFileSync(path).length;
}
