// `render --artboard`: one artboard at its own size, through a PNG export.
// Affinity exports to a temp file on the Desktop (the only place it may write);
// the file is copied to the output path and the temp file is always removed.

import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { imageSize, LIST_ARTBOARDS, EXPORT_AREA, safeName, targetSize, type Dim } from "../affinity/export-area.js";
import { extFor } from "../affinity/fill-script.js";
import { finalizeFile } from "../affinity/metadata.js";
import { requireUnderDesktop, shown } from "../affinity/paths.js";
import { APP_INFO, LIST_PRESETS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, print } from "../output/toon.js";
import type { AffinityClient, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";
import { EXPORT_TIMEOUT_MS, readBytes, runScript } from "./export-parts.js";

const BIN = "affinity-axi";
const CAP = 2048;

export interface ArtboardRender {
  name: string;
  spread: number;
  width?: number;
  out?: string;
}

interface Board {
  index: number;
  name: string;
}

function pickBoard(boards: Board[], want: string, spread: number): Board {
  let hits = boards.filter((b) => b.name === want);
  if (hits.length === 0) hits = boards.filter((b) => b.name.toLowerCase() === want.toLowerCase());
  if (hits.length === 0 && /^\d+$/.test(want)) hits = boards.filter((b) => b.index === Number(want));
  if (hits.length !== 1) {
    const why = hits.length === 0 ? `no artboard named '${want}'` : `artboard name '${want}' is ambiguous (${hits.length} matches)`;
    throw new UsageError(`${why} on spread ${spread}`, `artboards: ${boards.map((b) => `${b.index}:${b.name}`).join(", ")}`);
  }
  return hits[0]!;
}

async function listBoards(client: AffinityClient, doc: DocInfo, spread: number): Promise<Board[]> {
  const out = await runScript(client, LIST_ARTBOARDS(doc.uuid, spread), "listing artboards failed");
  let boards: Board[];
  try {
    boards = (JSON.parse(out.trim().split("\n").pop() ?? "") as { artboards: Board[] }).artboards;
  } catch {
    throw new AxiError("could not read the artboard list from Affinity", "retry; check the document with 'affinity-axi render'");
  }
  if (!Array.isArray(boards) || boards.length === 0) {
    throw new UsageError(
      `document ${doc.uuid} has no artboards on spread ${spread}`,
      "add artboards in the script (doc.addRectangularArtboard) or export without an artboard flag",
    );
  }
  return boards;
}

/** Renders one artboard to a PNG at `opts.out` (default under .affinity-axi/renders) and prints the result. */
export async function renderArtboard(client: AffinityClient, doc: DocInfo, opts: ArtboardRender): Promise<number> {
  const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
  const preset = presets.includes("PNG") ? "PNG" : presets.find((p) => extFor(p) === "png");
  if (preset === undefined) {
    throw new AxiError(
      "no PNG export preset in this Affinity install",
      "export the artboard yourself: affinity-axi export <doc> <preset> <path-under-Desktop> --artboard <name>",
    );
  }
  const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
  const id8 = doc.uuid.slice(0, 8);
  const tmp = join(app.desktop, `affinity-axi-render-${id8}-${randomBytes(3).toString("hex")}.png`);
  requireUnderDesktop(app.desktop, tmp, "render temp file", "write-file");
  const board = pickBoard(await listBoards(client, doc, opts.spread), opts.name, opts.spread);
  const out = opts.out ?? join(".affinity-axi", "renders", `${id8}-${safeName(board.name)}.png`);
  const area = { kind: "artboard" as const, spread: opts.spread, index: board.index };
  const what = `export of artboard '${board.name}' failed`;
  let natural: Dim;
  let final: Dim;
  try {
    await runScript(client, EXPORT_AREA(doc.uuid, preset, tmp, area, null), what, { timeoutMs: EXPORT_TIMEOUT_MS });
    const n = imageSize(readBytes(tmp));
    if (!n) throw new AxiError(`cannot read the pixel size of the rendered artboard '${board.name}'`, "retry; check the PNG preset with 'affinity-axi presets'");
    natural = n;
    final = natural;
    const want =
      opts.width !== undefined
        ? targetSize(natural, { width: opts.width })
        : Math.max(natural.width, natural.height) > CAP
          ? targetSize(natural, { square: CAP })
          : natural;
    if (want.width !== natural.width || want.height !== natural.height) {
      await runScript(client, EXPORT_AREA(doc.uuid, preset, tmp, area, want), what, { timeoutMs: EXPORT_TIMEOUT_MS });
      final = imageSize(readBytes(tmp)) ?? want;
    }
    mkdirSync(dirname(out), { recursive: true });
    copyFileSync(tmp, out); // a copy: the Desktop may be on another drive
  } finally {
    rmSync(tmp, { force: true });
  }
  finalizeFile(out, {});
  const bytes = readFileSync(out).length;
  const dims = (d: Dim): string => `${d.width}x${d.height}`;
  const how = final.width === natural.width && final.height === natural.height ? "its own size" : `${dims(final)}, scaled from ${dims(natural)}`;
  print(
    [
      emitKV([
        ["render", shown(out)],
        ["doc", doc.uuid],
        ["artboard", board.name],
        ["bytes", bytes],
        ["size", dims(final)],
        ["note", `artboard rendered through a PNG export at ${how}; a temp file on the Desktop was written and removed`],
      ]),
      helpBlock([`${BIN} render ${id8}   # the whole spread, 1024 px preview`, `${BIN} export ${id8} PNG <path-under-Desktop> --artboard ${board.name}`]),
    ].join("\n"),
  );
  return 0;
}
