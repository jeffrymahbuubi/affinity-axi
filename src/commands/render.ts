// `render <doc>`: render a spread or the selection to a JPEG on disk.
// The image bytes never reach stdout.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { jpegSize } from "../affinity/jpeg.js";
import { resultText } from "../affinity/result.js";
import { LIST_DOCUMENTS } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, print } from "../output/toon.js";
import type { ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";

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
        { name: "out", type: "string", description: "output path (default .affinity-axi/renders/<uuid8>-s<spread>.jpg)" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi render current",
        "affinity-axi render 70E876CB --spread 1",
        "affinity-axi render current --selection --out /tmp/sel.jpg",
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
        ["render", path],
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
