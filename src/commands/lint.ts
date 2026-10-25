// `lint <doc>`: design checks before export (contrast, safe zone, minimum
// font, slot: names, off-kit colours). One document listing and one inventory
// call, then every rule runs offline in affinity/lint.ts. Read-only.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { BRAND_FLAG, loadBrand, resolveBrandRef, type BrandKit } from "../affinity/brand.js";
import { resolveDocRef } from "../affinity/docref.js";
import { INSPECT } from "../affinity/inspect-script.js";
import { lintInventory, type Finding } from "../affinity/lint.js";
import type { Inventory } from "../affinity/manifest-types.js";
import { findPlatform } from "../affinity/platforms.js";
import { LIST_DOCUMENTS } from "../affinity/scripts.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { ConnectFn, DocInfo } from "../mcp/types.js";
import { callJson } from "./run.js";

const BIN = "affinity-axi";
const TIMEOUT_MS = 120000;
const DEFAULT_MIN_FONT = 20;
const FIELDS = ["severity", "check", "node", "detail"];

export function make(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "lint",
      summary: "Design checks before export: contrast, safe zone, minimum font, slot: names, off-kit colours (exit 1 on errors)",
      args: [{ name: "doc", required: true, description: "session UUID, unique UUID prefix (8+ chars) or 'current'" }],
      flags: [
        BRAND_FLAG,
        { name: "platform", type: "string", description: "check the safe insets of this platform row (see 'platforms'); default: the row matching each artboard's size" },
        { name: "artboard", type: "string", description: "only this artboard (exact name) and what it contains" },
        { name: "min-font", type: "string", default: String(DEFAULT_MIN_FONT), description: "text below this size in px is a warning" },
        { name: "strict", type: "boolean", description: "treat warnings as errors" },
        { name: "out", type: "string", description: "also write the findings as JSON to this path" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        `${BIN} lint 70E876CB`,
        `${BIN} lint 70E876CB --platform story --strict`,
        `${BIN} lint 70E876CB --brand brand.json --artboard ig-square`,
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const ref = parsed.positionals[0]!;
      const strict = parsed.flags["strict"] === true;
      const str = (k: string): string | undefined => (typeof parsed.flags[k] === "string" ? (parsed.flags[k] as string) : undefined);

      const fontRaw = str("min-font") ?? String(DEFAULT_MIN_FONT);
      if (!/^[1-9]\d*$/.test(fontRaw)) throw new UsageError(`invalid --min-font '${fontRaw}'`, "use a positive whole number of px, e.g. --min-font 24");
      const minFont = Number(fontRaw);

      const platform = str("platform");
      if (platform !== undefined && !findPlatform(platform)) {
        throw new UsageError(`unknown platform '${platform}'`, `run '${BIN} platforms' for the keys`);
      }

      let kit: BrandKit | undefined;
      const brandPath = resolveBrandRef(str("brand"), process.env, process.cwd());
      if (brandPath) kit = loadBrand(brandPath).kit;

      const artboard = str("artboard");
      const out = str("out");

      const client = await connect({ url: str("url") });
      let uuid: string;
      let inv: Inventory;
      try {
        const listing = await callJson<{ current: string | null; documents: DocInfo[] }>(client, LIST_DOCUMENTS, "listing documents");
        uuid = resolveDocRef(ref, listing.documents, listing.current).uuid;
        inv = await callJson<Inventory>(client, INSPECT(uuid, {}), "inspecting the document", { timeoutMs: TIMEOUT_MS });
      } finally {
        client.close();
      }

      if (artboard !== undefined && !inv.artboards.some((a) => a.name === artboard)) {
        const names = inv.artboards.map((a) => a.name || a.path);
        throw new UsageError(
          `no artboard named '${artboard}'`,
          names.length > 0 ? `artboards in this document: ${names.join(", ")}` : "this document has no artboards; drop --artboard",
        );
      }

      const { findings, checked, skipped } = lintInventory(inv, { platform, artboard, minFont, strict, kit });
      const errors = findings.filter((f: Finding) => f.severity === "error").length;
      const warnings = findings.length - errors;
      const uuid8 = uuid.slice(0, 8);

      if (out !== undefined) {
        mkdirSync(dirname(out) || ".", { recursive: true });
        const json = { schema: "affinity-axi/lint/1", doc: inv.doc.uuid, at: new Date().toISOString(), findings, counts: { errors, warnings, checked, skipped } };
        writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
      }

      const head: Array<[string, unknown]> = [["doc", inv.doc.uuid]];
      if (kit) head.push(["brand", kit.name]);
      if (out !== undefined) head.push(["out", out]);
      const lines = [emitKV(head)];
      if (findings.length === 0) lines.push(`lint: clean (${checked} nodes checked)`);
      else lines.push(emitList("lint", findings as unknown as Array<Record<string, unknown>>, FIELDS));
      if (skipped > 0) lines.push(`note: ${skipped} text nodes skipped (no solid fill)`);
      lines.push(`summary: ${errors} errors, ${warnings} warnings`);
      lines.push(helpBlock([`${BIN} inspect ${uuid8} --named`, `${BIN} lint ${uuid8} --strict`]));
      print(lines.join("\n"));
      return errors > 0 ? 1 : 0;
    },
  };
}
