import type { CommandModule } from "../cli/router.js";
import { relative, resolve } from "node:path";
import { scanManifests } from "../affinity/assets-scan.js";
import { classify, resultText } from "../affinity/result.js";
import { HOME_INFO } from "../affinity/scripts.js";
import { resolveUrl, version } from "../mcp/connect.js";
import { print } from "../output/toon.js";
import { type AffinityClient, type ConnectFn, type DocInfo } from "../mcp/types.js";
import {
  TOOL,
  renderBrief,
  renderHome,
  rootHelpText,
  uuid8,
  type HomeState,
} from "../guide/content.js";

function debug(msg: string): void {
  if (process.env["AFFINITY_AXI_DEBUG"] === "1") process.stderr.write(`[affinity-axi] ${msg}\n`);
}

interface HomeInfo {
  version: string;
  desktop: string;
  current: string | null;
  documents: DocInfo[];
}

/** "Affinity 3.3.1.4940 MacOS (Oct  6 2026)" -> "3.3.1.4940". */
function shortVersion(raw: string): string {
  return /\d+(?:\.\d+)+/.exec(raw)?.[0] ?? raw;
}

/** Parses the one JSON line HOME_INFO logs; null when the shape is wrong. */
export function parseHomeInfo(text: string): HomeInfo | null {
  const line = text.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  try {
    const v = JSON.parse(line) as Partial<HomeInfo>;
    if (typeof v.version !== "string" || !Array.isArray(v.documents)) return null;
    return { version: v.version, desktop: v.desktop ?? "", current: v.current ?? null, documents: v.documents };
  } catch {
    return null;
  }
}

async function readInfo(client: AffinityClient): Promise<{ info?: HomeInfo; note?: string }> {
  try {
    const r = await client.callTool("execute_script", { script: HOME_INFO });
    const outcome = classify(r);
    if (outcome.kind !== "ok") return { note: (resultText(r).split("\n")[0] ?? "script failed").slice(0, 120) };
    const info = parseHomeInfo(outcome.text);
    return info ? { info } : { note: "unexpected script output" };
  } catch (err) {
    debug(`home-info failed: ${err instanceof Error ? err.message : String(err)}`);
    return { note: "script call failed" };
  }
}

async function gather(connect: ConnectFn, flag: string | undefined): Promise<HomeState> {
  let client: AffinityClient;
  try {
    client = await connect(flag ? { url: flag } : {});
  } catch (err) {
    debug(`connect failed: ${err instanceof Error ? err.message : String(err)}`);
    return { connected: false, url: resolveUrl({ url: flag }) };
  }
  try {
    const { info, note } = await readInfo(client);
    const state: HomeState = { connected: true, url: client.baseUrl };
    if (!info) return { ...state, documentsNote: note };
    const first = info.documents[0];
    const ref = info.current ?? first?.uuid;
    return {
      ...state,
      version: shortVersion(info.version),
      documents: info.documents,
      ...(ref ? { helpDoc: uuid8(ref) } : {}),
    };
  } finally {
    client.close();
  }
}

/** Manifest count under cwd and the newest one's path (relative), or null when there are none. */
function assetsUnder(cwd: string): { count: number; first: string } | null {
  try {
    const rows = scanManifests(cwd, 6);
    const r = rows[0];
    if (!r) return null;
    return { count: rows.length, first: relative(cwd, resolve(cwd, r.file)) || r.file };
  } catch {
    return null;
  }
}

/** Adds `assets: N under ./` before the help; the full view also gets a `doc open` help line. */
function withAssets(body: string, a: { count: number; first: string } | null, brief: boolean): string {
  if (!a) return body;
  const line = `assets: ${a.count} under ./`;
  const at = body.lastIndexOf("\nhelp");
  if (at < 0) return `${body}\n${line}`;
  const head = body.slice(0, at);
  let help = body.slice(at + 1);
  if (!brief) {
    help = help.replace(/^help\[(\d+)\]:/, (_m, n: string) => `help[${Number(n) + 1}]:`) + `\n  ${TOOL} doc open ${a.first}`;
  }
  return `${head}\n${line}\n${help}`;
}

/** Home view command bound to a transport. */
export function make(connect: ConnectFn, opts: { cwd?: string } = {}): CommandModule {
  return {
    spec: {
      name: "",
      summary: "Home view: live connection state and open documents (AXI principle 8)",
      flags: [
        { name: "brief", type: "boolean", description: "at most 6 lines, for SessionStart hooks" },
        { name: "url", type: "string", description: "Affinity MCP endpoint (AFFINITY_MCP_URL wins)" },
        { name: "version", type: "boolean", description: "print the tool version" },
      ],
      examples: ["affinity-axi", "affinity-axi --brief", "affinity-axi --version"],
    },
    async run(parsed) {
      if (parsed.flags["version"]) {
        print(`affinity-axi: ${version()}`);
        return 0;
      }
      const flag = typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined;
      const state = await gather(connect, flag);
      const brief = parsed.flags["brief"] === true;
      const assets = assetsUnder(opts.cwd ?? process.cwd());
      const text = brief ? renderBrief(TOOL, state) : renderHome(process.argv[1] ?? TOOL, state);
      print(withAssets(text, assets, brief));
      return 0;
    },
  };
}

export function rootHelp(): string {
  return rootHelpText();
}
