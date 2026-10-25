// `inspect <doc>`: list what is inside a document (artboards, names, boxes,
// text, fonts, fills) as a compact table. Read-only: the walker script never
// changes the selection or the current spread.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { resolveDocRef } from "../affinity/docref.js";
import { INSPECT } from "../affinity/inspect-script.js";
import type { Inventory, InventoryNode } from "../affinity/manifest-types.js";
import { LIST_DOCUMENTS } from "../affinity/scripts.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const ROW_CAP = 60;
const FIELDS = ["path", "type", "name", "box", "text", "font", "fill"];
const TIMEOUT_MS = 120000;

function tilde(path: string): string {
  const home = homedir();
  return home && path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

function row(n: InventoryNode): Record<string, unknown> {
  return { path: n.path, type: n.type, name: n.name, box: n.box.join(" "), text: n.text, font: n.font, fill: n.fill };
}

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "inspect",
      summary: "List the nodes inside a document: artboards, names, boxes, text, fonts, fills",
      args: [{ name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" }],
      flags: [
        { name: "named", type: "boolean", description: "only nodes that have a name (userDescription); no row cap" },
        { name: "artboard", type: "string", description: "only this artboard (exact name) and what it contains" },
        { name: "depth", type: "string", description: "deepest nesting level to list (spread children are level 1)" },
        { name: "out", type: "string", description: "write the inventory as JSON to this path instead of printing rows" },
        { name: "full", type: "boolean", description: `print every row (default caps at ${ROW_CAP})` },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        "affinity-axi inspect current --named",
        "affinity-axi inspect 70E876CB --artboard ig-square --full",
        "affinity-axi inspect current --out .affinity-axi/inventory.json",
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const ref = parsed.positionals[0]!;
      const named = parsed.flags["named"] === true;
      const full = parsed.flags["full"] === true;
      const artboard = typeof parsed.flags["artboard"] === "string" ? parsed.flags["artboard"] : undefined;
      const depthRaw = parsed.flags["depth"];
      let depth: number | undefined;
      if (typeof depthRaw === "string") {
        if (!/^[1-9]\d*$/.test(depthRaw)) {
          throw new UsageError(`invalid --depth '${depthRaw}'`, "use a positive integer; spread children are level 1");
        }
        depth = Number(depthRaw);
      }
      const out = typeof parsed.flags["out"] === "string" ? parsed.flags["out"] : undefined;
      const url = typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined;

      const client = await connect({ url });
      let uuid: string;
      let inv: Inventory;
      try {
        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(
          client,
          LIST_DOCUMENTS,
          "listing documents",
        );
        uuid = resolveDocRef(ref, listing.documents, listing.current).uuid;
        inv = await callJson<Inventory>(
          client,
          INSPECT(uuid, { named, ...(artboard !== undefined ? { artboard } : {}), ...(depth !== undefined ? { depth } : {}) }),
          "inspecting the document",
          { timeoutMs: TIMEOUT_MS },
        );
      } finally {
        client.close();
      }

      const uuid8 = uuid.slice(0, 8);
      if (artboard !== undefined && !inv.artboards.some((a) => a.name === artboard)) {
        const names = inv.artboards.map((a) => a.name || a.path);
        throw new UsageError(
          `no artboard named '${artboard}'`,
          names.length > 0 ? `artboards in this document: ${names.join(", ")}` : "this document has no artboards; drop --artboard",
        );
      }

      const { doc, counts } = inv;
      const countPairs: Array<[string, unknown]> = [
        ["nodes", counts.nodes],
        ["named", counts.named],
        ["text", counts.text],
        ["images", counts.images],
        ["artboards", inv.artboards.length],
      ];

      if (out !== undefined) {
        mkdirSync(dirname(out) || ".", { recursive: true });
        writeFileSync(out, JSON.stringify(inv, null, 2) + "\n");
        print(
          [
            emitKV([["inspect", out], ["doc", doc.uuid], ...countPairs]),
            helpBlock([`${BIN} inspect ${uuid8} --named`, `${BIN} render ${uuid8}`]),
          ].join("\n"),
        );
        return 0;
      }

      const capped = !full && !named && inv.nodes.length > ROW_CAP;
      const shown = capped ? inv.nodes.slice(0, ROW_CAP) : inv.nodes;
      const filters: string[] = [];
      if (named) filters.push("named only");
      if (artboard !== undefined) filters.push(`artboard ${artboard}`);
      if (depth !== undefined) filters.push(`depth ${depth}`);
      if (capped) filters.push(`first ${ROW_CAP}`);
      const qual = filters.length > 0 ? ` (${filters.join(", ")})` : "";
      const fullFlags = [
        artboard !== undefined ? ` --artboard ${JSON.stringify(artboard)}` : "",
        depth !== undefined ? ` --depth ${depth}` : "",
      ].join("");
      const note = `${shown.length} of ${counts.nodes} nodes${qual}` + (capped ? `; ${BIN} inspect ${uuid8}${fullFlags} --full` : "");

      print(
        [
          emitKV([
            ["doc", doc.uuid],
            ["path", doc.path ? tilde(doc.path) : "(unsaved)"],
            ["size", `${doc.width}x${doc.height} px @ ${doc.dpi} dpi`],
          ]),
          emitList("nodes", shown.map(row), FIELDS),
          `note: ${note}`,
          helpBlock([
            `${BIN} run <script.js> --with-helpers --args '{"uuid":"${uuid8}"}'`,
            `${BIN} inspect ${uuid8} --out <json>`,
          ]),
        ].join("\n"),
      );
      return 0;
    },
  };
}
