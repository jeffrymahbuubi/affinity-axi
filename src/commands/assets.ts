// `assets`: offline list of saved .af files that have a manifest, found by
// scanning for *.af.axi.json. Newest save first.

import { relative, resolve } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { scanManifests } from "../affinity/assets-scan.js";
import { UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { expandHome } from "../affinity/paths.js";

const BIN = "affinity-axi";
const MAX_ROWS = 30;

/** "2026-10-24T13:02:11.000Z" -> "2026-10-24T13:02Z". */
function shortTime(iso: string): string {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso) ? iso.slice(0, 16) + "Z" : iso;
}

/** Offline; the connect argument is accepted so the registry can bind every module alike. */
export function make(_connect?: ConnectFn): Record<"assets", CommandModule> {
  return {
    assets: {
      spec: {
        name: "assets",
        summary: "Offline: list saved .af files with a manifest under a directory (newest first)",
        flags: [{ name: "dir", type: "string", description: "directory to scan (default: the current directory; depth 6)" }],
        examples: ["affinity-axi assets", "affinity-axi assets --dir ~/Desktop/campaign"],
      },
      run(parsed: Parsed): number {
        const raw = parsed.flags["dir"];
        const root = resolve(typeof raw === "string" ? expandHome(raw) : process.cwd());
        let rows;
        try {
          rows = scanManifests(root, 6);
        } catch (err) {
          throw new UsageError(`cannot scan ${root}: ${err instanceof Error ? err.message : String(err)}`, "pass an existing directory with --dir");
        }
        if (rows.length === 0) {
          print([`assets: none under ${root}`, helpBlock([`${BIN} doc new --width 1080 --height 1080   # then run, doc save to create one`, `${BIN} assets --dir <other-dir>`])].join("\n"));
          return 0;
        }
        const shown = rows.slice(0, MAX_ROWS).map((r) => ({
          file: relative(process.cwd(), resolve(root, r.file)) || r.file,
          madeBy: r.madeBy,
          saved: shortTime(r.savedAt),
          fresh: r.fresh,
        }));
        const first = shown[0]!.file;
        const lines = [emitList("assets", shown, ["file", "madeBy", "saved", "fresh"], { total: rows.length })];
        if (rows.length > MAX_ROWS) lines.push(`note: ${MAX_ROWS} of ${rows.length} shown; narrow with --dir`);
        lines.push(helpBlock([`${BIN} doc open ${first}`, `${BIN} doc info ${first}   # offline`]));
        print(lines.join("\n"));
        return 0;
      },
    },
  };
}
