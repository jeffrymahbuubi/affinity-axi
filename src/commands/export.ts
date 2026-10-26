// `export <doc> <preset> <path>` and `presets`, plus export area
// (artboard, all artboards, selection, spread), pixel size and embedded AI
// metadata for generative documents. The area, report and manifest helpers
// live in export-parts.ts.

import { extname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { NO_ALT_FLAG } from "../affinity/alt-text.js";
import { BRAND_FLAG, loadBrand, resolveBrandRef } from "../affinity/brand.js";
import { resolveDocRef } from "../affinity/docref.js";
import { EXPORT_AREA, imageSize, parseSizeFlags, targetSize } from "../affinity/export-area.js";
import {
  budgetFor,
  fitBudget,
  ladderFor,
  MAX_KB_FLAG,
  MIN_SCALE_FLAG,
  noFitMessage,
  NO_FIT_SUGGESTION,
  scaledDim,
  type Attempt,
} from "../affinity/export-budget.js";
import { pageRows, pagesReport, recoverPages } from "../affinity/export-pages.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { aiSpecFor, COPYRIGHT_FLAG, creditFor, CREATOR_FLAG, finalizeFile, KEEP_FLAG, tagExports, type MetaOutcome, type MetaSpec } from "../affinity/metadata.js";
import { APP_INFO, EXPORT, LIST_DOCUMENTS, LIST_PRESETS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";
import { altStubs, artboardTargets, BIN, planArea, readBytes, recordExports, report, runScript, type Target, type Written } from "./export-parts.js";

const SIZE_EXTS = [".png", ".jpg", ".jpeg", ".webp"];

function urlFlag(parsed: Parsed): string | undefined {
  const u = parsed.flags["url"];
  return typeof u === "string" ? u : undefined;
}

export function makePresets(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "presets",
      summary: "List the export preset names available in this Affinity install",
      flags: [{ name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" }],
      examples: ["affinity-axi presets", "affinity-axi presets --url http://127.0.0.1:6767"],
    },
    async run(parsed: Parsed): Promise<number> {
      const client = await connect({ url: urlFlag(parsed) });
      let names: string[];
      try {
        names = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
      } finally {
        client.close();
      }
      print(
        [
          emitList("presets", names.map((name) => ({ name })), ["name"]),
          helpBlock([`${BIN} export current <preset> <path-under-Desktop>`]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

export function makeExport(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "export",
      summary: "Export a document with a named preset to a path under the Desktop folder (Affinity's XMP is stripped; --creator embeds yours)",
      args: [
        { name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" },
        { name: "preset", required: true, description: "exact preset name (see 'affinity-axi presets')" },
        { name: "path", required: true, description: "output file path; must be inside the Desktop folder; {name} stands for the artboard name" },
      ],
      flags: [
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
        { name: "artboard", type: "string", description: "export one artboard by name" },
        { name: "all-artboards", type: "boolean", description: "one file per artboard; <path> must contain {name}" },
        { name: "selection", type: "boolean", description: "export the current selection" },
        { name: "spread", type: "string", description: "spread index from 0: the spread itself, or the spread holding the artboards" },
        { name: "width", type: "string", description: "output width in px (height follows the aspect ratio)" },
        { name: "height", type: "string", description: "output height in px (width follows the aspect ratio)" },
        { name: "scale", type: "string", description: "output scale factor, e.g. 2 for @2x" },
        { name: "square", type: "string", description: "fit the longer side to <px> keeping the aspect ratio, e.g. 512" },
        { ...MAX_KB_FLAG },
        { ...MIN_SCALE_FLAG },
        { ...NO_ALT_FLAG },
        BRAND_FLAG,
        CREATOR_FLAG,
        COPYRIGHT_FLAG,
        KEEP_FLAG,
      ],
      examples: [
        "affinity-axi export current PNG ~/Desktop/logo.png",
        "affinity-axi export current PNG ~/Desktop/out/{name}.png --all-artboards",
        "affinity-axi export current PNG ~/Desktop/og@2x.png --artboard og --scale 2",
        'affinity-axi export current "JPEG (High quality)" ~/Desktop/ad.jpg --artboard ad-300x250 --max-kb 150',
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const [ref, preset, rawPath] = parsed.positionals as [string, string, string];
      const template = userPath(rawPath);
      const probe = template.split("{name}").join("x");
      requireVisible(probe, "export path");
      const plan = planArea(parsed, rawPath);
      const size = parseSizeFlags(parsed);
      const budget = budgetFor(parsed);
      const wantAlt = parsed.flags["no-alt"] !== true;
      const brandPath = resolveBrandRef(typeof parsed.flags["brand"] === "string" ? parsed.flags["brand"] : undefined, process.env, process.cwd());
      const keep = parsed.flags["keep-metadata"] === true;
      if (keep && (typeof parsed.flags["creator"] === "string" || typeof parsed.flags["copyright"] === "string")) {
        throw new UsageError("--keep-metadata cannot be combined with --creator or --copyright", "drop --keep-metadata to strip Affinity's XMP and embed your credit");
      }
      const credit = keep ? undefined : creditFor(parsed, brandPath ? loadBrand(brandPath).kit : undefined);
      const spec: Omit<MetaSpec, "ai"> = { ...(credit ? { credit } : {}), ...(keep ? { keep } : {}) };
      if ((size || budget) && !SIZE_EXTS.includes(extname(template).toLowerCase())) {
        const flagsText = budget ? "--max-kb" : "size flags";
        throw new UsageError(
          `${flagsText} need a raster output path (${SIZE_EXTS.join(", ")}), got '${extname(template) || "no extension"}'`,
          "use a PNG, JPEG or WebP preset and file name, or drop --width, --height, --scale, --square and --max-kb",
        );
      }
      if (budget) ladderFor(preset, [preset], budget.minScale); // a non-raster preset is a usage error, before connecting

      const client = await connect({ url: urlFlag(parsed) });
      let doc: DocInfo;
      let targets: Target[];
      const budgeted = new Map<string, Attempt[]>();
      const finished = new Map<string, MetaOutcome>();
      let alts: Array<string | null> | null = null;
      let pages: string[] | null = null; // page files of a multi-page document, instead of the asked path
      try {
        const presets = await callJson<string[]>(client, LIST_PRESETS, "listing export presets");
        if (!presets.includes(preset)) {
          const q = preset.toLowerCase();
          const close = presets.filter((p) => p.toLowerCase().includes(q));
          const hint = close.length > 0 ? `closest: ${close.join(", ")}; ` : "";
          throw new UsageError(`unknown export preset '${preset}'`, `${hint}run '${BIN} presets' to list all names`);
        }

        const app = await callJson<{ version: string; desktop: string }>(client, APP_INFO, "reading Affinity app info");
        requireUnderDesktop(app.desktop, probe, "export path", "write-file");

        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(
          client,
          LIST_DOCUMENTS,
          "listing documents",
        );
        doc = resolveDocRef(ref, listing.documents, listing.current);

        if (plan.mode === "all" || plan.mode === "artboard") targets = await artboardTargets(client, doc, plan, template);
        else if (plan.mode === "selection") targets = [{ name: "", path: template, area: { kind: "selection" } }];
        else if (plan.mode === "spread") targets = [{ name: "", path: template, area: { kind: "spread", spread: plan.spread } }];
        else targets = [{ name: "", path: template, area: null }];

        const plain = plan.mode === "whole" && !size;
        const full: MetaSpec = { ...spec, ai: aiSpecFor(doc.uuid, doc.path) };
        const finish = (path: string): void => void finished.set(path, finalizeFile(path, full));
        const pageMode = plan.mode === "whole" || plan.mode === "spread" ? plan.mode : null;
        // Runs one export script; on a multi-page document Affinity writes <stem>_<k><ext> instead of the path.
        const exportTo = async (script: string, path: string, what: string): Promise<string[] | null> => {
          const started = Date.now();
          await runScript(client, script, what);
          return pageMode === null ? null : recoverPages(path, pageMode, started);
        };
        for (const t of targets) {
          const what = t.name === "" ? "export failed" : `export of artboard '${t.name}' failed`;
          pages = await exportTo(plain ? EXPORT(doc.uuid, preset, t.path) : EXPORT_AREA(doc.uuid, preset, t.path, t.area, null), t.path, what);
          if (pages !== null) {
            pages.forEach(finish); // clean every page file before anything can fail
            if (size || budget) {
              throw new UsageError(
                `size flags and --max-kb cannot be used with a multi-page export (Affinity wrote ${pages.length} page files: ${pages.join(", ")})`,
                "export one page with --spread <n> (0-based), or drop the size flags and --max-kb",
              );
            }
            break;
          }
          if (!size && !budget) {
            finish(t.path);
            continue;
          }
          // The SDK takes an absolute pixel size, so export at natural size first and read it back.
          const natural = imageSize(readBytes(t.path));
          if (!natural) {
            throw new AxiError(`cannot read the pixel size of ${t.path}`, "size and budget flags support PNG, JPEG and WebP presets only");
          }
          const want = size ? targetSize(natural, size) : natural;
          if (want.width !== natural.width || want.height !== natural.height) {
            await exportTo(EXPORT_AREA(doc.uuid, preset, t.path, t.area, want), t.path, what);
          }
          if (!budget) {
            finish(t.path);
            continue;
          }
          // The first step is the file just written; later steps re-export lower quality, then smaller.
          const steps = ladderFor(preset, presets, budget.minScale);
          const fitted = await fitBudget(steps, budget.bytes, async (s) => {
            if (s !== steps[0]) {
              const dim = s.scale === 1 && !size ? null : scaledDim(want, s.scale);
              await exportTo(EXPORT_AREA(doc.uuid, s.preset, t.path, t.area, dim), t.path, what);
            }
            finish(t.path); // the metadata pass first, so the verdict measures the final file
            const buf = readBytes(t.path);
            const dim = imageSize(buf);
            return { bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
          });
          budgeted.set(t.path, fitted.attempts);
        }
        if (wantAlt && pages === null) alts = await altStubs(client, doc.uuid, plan, targets);
      } finally {
        client.close();
      }

      if (pages !== null) {
        const tags = tagExports(doc.uuid, pages, spec, pages.map((p) => finished.get(p)!), doc.path);
        const rows = pageRows(pages);
        recordExports(doc, plan, preset, rows, tags.some(([k]) => k === "provenance"));
        print(pagesReport(doc.uuid, preset, rows, tags));
        return 0;
      }

      // The files are final (stripped, credited, labelled); the sidecars and the note come next, then measure what is on disk.
      const tags = tagExports(doc.uuid, targets.map((t) => t.path), spec, targets.map((t) => finished.get(t.path)!), doc.path);
      const written: Written[] = targets.map((t, i) => {
        const buf = readBytes(t.path);
        const dim = imageSize(buf);
        const w: Written = { ...t, bytes: buf.length, size: dim ? `${dim.width}x${dim.height}` : "" };
        const tried = budgeted.get(t.path);
        if (tried) Object.assign(w, { attempts: tried, preset: tried[tried.length - 1]!.preset, fit: tried[tried.length - 1]!.fit });
        const alt = alts?.[i];
        if (alt !== undefined && alt !== null) w.alt = alt;
        return w;
      });

      recordExports(doc, plan, preset, written, tags.some(([k]) => k === "provenance"));
      print(report(doc.uuid, plan, preset, written, tags, budget?.kb ?? null, wantAlt));
      const misses = written.filter((w) => w.fit === false);
      if (budget && misses.length > 0) {
        const m = misses[0]!;
        const more = misses.length > 1 ? ` (and ${misses.length - 1} more)` : "";
        throw new AxiError(`${noFitMessage(m.path, budget.kb, m.attempts![m.attempts!.length - 1]!)}${more}`, NO_FIT_SUGGESTION);
      }
      return 0;
    },
  };
}

/** Both commands hosted by this module, for the registry. */
export function make(connect: ConnectFn): { export: CommandModule; presets: CommandModule } {
  return { export: makeExport(connect), presets: makePresets(connect) };
}
