// `render <doc>`: render a spread or the selection to a JPEG on disk.
// The image bytes never reach stdout.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { shown } from "../affinity/paths.js";
import { jpegSize } from "../affinity/jpeg.js";
import { resultText } from "../affinity/result.js";
import { LIST_DOCUMENTS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, print } from "../output/toon.js";
import type { ConnectFn, DocInfo } from "../mcp/types.js";
import { parseSizeFlags } from "../affinity/export-area.js";
import { callJson } from "./run.js";
import { renderArtboard } from "./render-artboard.js";

const BIN = "affinity-axi";
const NOTE = "preview capped at 1024px; use export for full resolution";

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "render",
      summary: "Render a spread or the selection to a JPEG on disk (never printed)",
      args: [{ name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" }],
      flags: [
        { name: "spread", type: "string", default: "0", description: "spread index to render" },
        { name: "selection", type: "boolean", description: "render the current selection instead of a spread" },
        { name: "artboard", type: "string", description: "render one artboard at its own size instead of the 1024 px preview: a name, or its index from 0; goes through a PNG export, so the Desktop must be writable" },
        { name: "width", type: "string", description: "with --artboard: output width in px (default: the artboard's size, at most 2048 px on the longer side)" },
        { name: "out", type: "string", description: "output path (default .affinity-axi/renders/<uuid8>-s<spread>.jpg)" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi render 70E876CB",
        "affinity-axi render 70E876CB --spread 1",
        "affinity-axi render 70E876CB --selection --out renders/sel.jpg",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const ref = parsed.positionals[0]!;
      const spreadRaw = String(parsed.flags["spread"]);
      if (!/^\d+$/.test(spreadRaw)) {
        throw new UsageError(`invalid --spread '${spreadRaw}'`, "use a spread index starting at 0, e.g. --spread 0");
      }
      const spread = Number(spreadRaw);
      const selection = parsed.flags["selection"] === true;
      const artboard = typeof parsed.flags["artboard"] === "string" ? parsed.flags["artboard"] : undefined;
      const outRaw = typeof parsed.flags["out"] === "string" ? parsed.flags["out"] : undefined;
      let width: number | undefined;
      if (artboard !== undefined) {
        if (artboard.trim() === "") {
          throw new UsageError("--artboard needs a name", "pass the artboard name or its index from 0");
        }
        if (selection) throw new UsageError("--artboard and --selection cannot be combined", "pick one");
        if (outRaw !== undefined && !outRaw.toLowerCase().endsWith(".png")) {
          throw new UsageError("--artboard renders a PNG: --out must end in .png", "use a .png file name, or drop --out");
        }
        width = parseSizeFlags(parsed)?.width;
      } else if (parsed.flags["width"] !== undefined) {
        throw new UsageError("--width needs --artboard <name|index>", "add --artboard, or drop --width");
      }
      const url = typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined;

      const client = await connect({ url });
      let doc: DocInfo;
      let data: string;
      try {
        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(
          client,
          LIST_DOCUMENTS,
          "listing documents",
        );
        doc = resolveDocRef(ref, listing.documents, listing.current);
        if (artboard !== undefined) {
          return await renderArtboard(client, doc, { name: artboard, spread, ...(width !== undefined ? { width } : {}), ...(outRaw !== undefined ? { out: outRaw } : {}) });
        }
        const result = selection
          ? await client.callTool("render_selection", { document_session_uuid: doc.uuid })
          : await client.callTool("render_spread", { document_session_uuid: doc.uuid, spread_index: spread });
        if (result.isError) {
          const msg = resultText(result).trim() || "render failed";
          throw new AxiError(`render failed: ${msg}`, `check the document and spread index with '${BIN} render ${doc.uuid.slice(0, 8)} --spread 0'`);
        }
        const image = result.content.find((c) => c.type === "image");
        if (!image || image.type !== "image") {
          throw new AxiError("render returned no image", "retry; if it persists, check that Affinity is not showing a modal dialog");
        }
        data = image.data;
      } finally {
        client.close();
      }

      const buf = Buffer.from(data, "base64");
      const uuid8 = doc.uuid.slice(0, 8);
      const outFlag = parsed.flags["out"];
      const path =
        typeof outFlag === "string"
          ? outFlag
          : join(".affinity-axi", "renders", selection ? `${uuid8}-selection.jpg` : `${uuid8}-s${spread}.jpg`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, buf);

      const size = jpegSize(buf);
      const pairs: Array<[string, unknown]> = [
        ["render", shown(path)],
        ["doc", doc.uuid],
      ];
      pairs.push(selection ? ["selection", "true"] : ["spread", spread]);
      pairs.push(["bytes", buf.length], ["size", size ? `${size.width}x${size.height}` : "unknown"], ["note", NOTE]);
      print(
        [
          emitKV(pairs),
          helpBlock([
            selection ? `${BIN} render ${uuid8}` : `${BIN} render ${uuid8} --selection`,
            `${BIN} export ${uuid8} PNG <path-under-Desktop>`,
          ]),
        ].join("\n"),
      );
      return 0;
    },
  };
}
