// `brand init|list|show|check`: per-project brand kits (see affinity/brand.ts).
// init, list and show are offline; check connects once to verify fonts and
// logos against the running Affinity.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { CommandModule } from "../cli/router.js";
import type { Parsed } from "../cli/args.js";
import { BRAND_SCHEMA, contrastRatio, extraKeys, loadBrand, ratioText, resolveBrandRef, type BrandKit } from "../affinity/brand.js";
import { APP_INFO } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { BIN, URL_FLAG, urlFlag } from "./doc.js";
import { hiddenSegment, isInside } from "../affinity/paths.js";
import { LIST_FONTS } from "./fonts.js";
import { callJson } from "./run.js";

const REF_ARG = { name: "ref", required: false, description: "a .brand.json path or a name under ./brands/ (default $AFFINITY_AXI_BRAND, then ./brand.json)" };
const AA = 4.5;

/** The starter kit `brand init` writes: neutral placeholders to edit. */
function starterKit(name: string): BrandKit {
  return {
    schema: BRAND_SCHEMA,
    name,
    colours: { ink: "#111111", paper: "#FFFFFF", accent: "#2F6FEB" },
    fonts: { headline: "Helvetica-Bold", body: "Helvetica" },
    type: {
      display: { font: "headline", size: 120, spacing: -0.01 },
      h1: { font: "headline", size: 64 },
      body: { font: "body", size: 32, leading: 1.4 },
    },
    space: [4, 8, 12, 16, 24, 32, 48, 64, 96],
    radius: { sm: 8, md: 16, lg: 32, pill: 999 },
    pairs: [
      ["ink", "paper"],
      ["paper", "accent"],
    ],
  };
}

function slugOf(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const shownPath = (abs: string): string => relative(process.cwd(), abs) || abs;

/** The kit a command should use: the positional ref, else the default resolution. */
function pick(parsed: Parsed): string {
  const ref = parsed.positionals[0];
  const path = resolveBrandRef(ref, process.env, process.cwd());
  if (!path) {
    throw new UsageError("no brand kit found", `pass a kit: ${BIN} brand show <path|name>, or create one: ${BIN} brand init <name>`);
  }
  return path;
}

function makeInit(): CommandModule {
  return {
    spec: {
      name: "brand init",
      summary: "Offline: write a starter brand kit (or copy one with --from); never overwrites",
      args: [{ name: "name", required: true, description: "brand name; the file is <slug>.brand.json" }],
      flags: [
        { name: "dir", type: "string", default: "brands", description: "folder for the kit (default ./brands)" },
        { name: "from", type: "string", description: "copy this kit (path or name) instead of the neutral starter" },
      ],
      examples: ["affinity-axi brand init acme", "affinity-axi brand init acme-dark --from acme"],
    },
    run(parsed: Parsed): number {
      const name = parsed.positionals.join(" ").trim();
      const slug = slugOf(name);
      if (slug === "") throw new UsageError("brand name is empty", `example: ${BIN} brand init acme`);
      const dir = resolve(String(parsed.flags["dir"]));
      const file = resolve(dir, `${slug}.brand.json`);
      let kit: BrandKit = starterKit(name);
      const from = parsed.flags["from"];
      if (typeof from === "string") {
        const src = resolveBrandRef(from, process.env, process.cwd());
        if (!src) throw new UsageError(`cannot find the kit '${from}'`, `${BIN} brand list`);
        const loaded = loadBrand(src).kit;
        kit = { ...loaded, name };
        if (loaded.logo) kit.logo = Object.fromEntries(Object.entries(loaded.logo).map(([k, p]) => [k, relative(dir, p)]));
      }
      if (existsSync(file)) {
        throw new AxiError(`${shownPath(file)} already exists; not overwriting`, `edit it by hand, or pick another name: ${BIN} brand init ${name}-2`);
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(kit, null, 2) + "\n", { flag: "wx" });
      const ref = dirname(file) === resolve("brands") ? slug : shownPath(file);
      print(
        [
          emitKV([["wrote", shownPath(file)], ["name", name]]),
          helpBlock([`${BIN} brand show ${ref}`, `${BIN} run <script.js> --with-helpers --brand ${ref}`]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

function kitFiles(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const found: string[] = [];
  const dir = resolve(cwd, "brands");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) if (f.endsWith(".brand.json")) found.push(resolve(dir, f));
  }
  const local = resolve(cwd, "brand.json");
  if (existsSync(local)) found.push(local);
  const fromEnv = env["AFFINITY_AXI_BRAND"];
  if (fromEnv) {
    const p = resolveBrandRef(undefined, { AFFINITY_AXI_BRAND: fromEnv }, cwd);
    if (p) found.push(p);
  }
  return [...new Set(found)];
}

function makeList(): CommandModule {
  return {
    spec: {
      name: "brand list",
      summary: "Offline: list the brand kits in this project (./brands, ./brand.json, $AFFINITY_AXI_BRAND) and which one runs use",
      flags: [],
      examples: ["affinity-axi brand list"],
    },
    run(): number {
      const cwd = process.cwd();
      const files = kitFiles(cwd, process.env);
      if (files.length === 0) {
        print(["brands: 0 found", helpBlock([`${BIN} brand init <name>   # writes ./brands/<name>.brand.json`])].join("\n"));
        return 0;
      }
      const def = resolveBrandRef(undefined, process.env, cwd);
      const rows = files.map((f) => {
        let name = "";
        let status = "ok";
        try {
          name = loadBrand(f, cwd).kit.name;
        } catch (err) {
          name = basename(f);
          status = err instanceof Error ? err.message.replace(/^brand kit [^:]*: /, "invalid: ") : "invalid";
        }
        return { name, path: shownPath(f), default: f === def ? "default" : "", status };
      });
      print([emitList("brands", rows, ["name", "path", "default", "status"]), helpBlock([`${BIN} brand show ${rows[0]!.path}`])].join("\n"));
      return 0;
    },
  };
}

function makeShow(): CommandModule {
  return {
    spec: {
      name: "brand show",
      summary: "Offline: print a brand kit's tokens as tables, with the contrast of its colour pairs",
      args: [REF_ARG],
      flags: [],
      examples: ["affinity-axi brand show examples/_brand/brand.json", "affinity-axi brand show acme"],
    },
    run(parsed: Parsed): number {
      const path = pick(parsed);
      const { kit, ref } = loadBrand(path);
      const out: string[] = [emitKV([["name", kit.name], ["path", ref.path], ["sha256", ref.sha256.slice(0, 12)]])];
      out.push(emitList("colours", Object.entries(kit.colours).map(([key, hex]) => ({ key, hex })), ["key", "hex"]));
      out.push(emitList("fonts", Object.entries(kit.fonts).map(([role, postscript]) => ({ role, postscript })), ["role", "postscript"]));
      if (kit.type) {
        out.push(emitList("type", Object.entries(kit.type).map(([key, t]) => ({ key, font: t.font, size: t.size, leading: t.leading, spacing: t.spacing })), ["key", "font", "size", "leading", "spacing"]));
      }
      if (kit.space) out.push(emitKV([["space", kit.space.join(" ")]]));
      if (kit.radius) out.push(emitList("radius", Object.entries(kit.radius).map(([key, px]) => ({ key, px })), ["key", "px"]));
      if (kit.logo) out.push(emitList("logo", Object.entries(kit.logo).map(([key, p]) => ({ key, path: shownPath(p) })), ["key", "path"]));
      if (kit.pairs) out.push(emitList("contrast", kit.pairs.map(([fg, bg]) => contrastRow(kit, fg, bg)), ["fg", "bg", "ratio", "aa"]));
      const extra = extraKeys(kit);
      if (extra.length > 0) out.push(emitKV([["extra", extra.join(" ")]]));
      out.push(helpBlock([`${BIN} brand check ${ref.path}`, `${BIN} run <script.js> --with-helpers --brand ${ref.path}`]));
      print(out.join("\n"));
      return 0;
    },
  };
}

function contrastRow(kit: BrandKit, fg: string, bg: string): { fg: string; bg: string; ratio: string; aa: string } {
  const ratio = contrastRatio(kit.colours[fg]!, kit.colours[bg]!);
  return { fg, bg, ratio: ratioText(ratio), aa: ratio >= AA ? "yes" : "no" };
}

interface Check {
  check: string;
  status: "ok" | "warn" | "fail";
  note: string;
}

function logoProblem(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return "file not found";
  const fd = openSync(path, "r");
  const head = Buffer.alloc(8);
  try {
    readSync(fd, head, 0, 8, 0);
  } finally {
    closeSync(fd);
  }
  const png = head.subarray(0, 4).toString("hex") === "89504e47";
  const jpeg = head.subarray(0, 2).toString("hex") === "ffd8";
  return png || jpeg ? null : "not a PNG or JPEG file";
}

function makeCheck(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "brand check",
      summary: "Verify a brand kit against Affinity: font postscript names, logo files (PNG/JPEG under Desktop) and colour contrast",
      args: [REF_ARG],
      flags: [URL_FLAG],
      examples: ["affinity-axi brand check examples/_brand/brand.json", "affinity-axi brand check acme"],
    },
    async run(parsed: Parsed): Promise<number> {
      const path = pick(parsed);
      const { kit, ref } = loadBrand(path);
      const client = await connect({ url: urlFlag(parsed) });
      let installed: string[];
      let desktop: string;
      try {
        const rows = await callJson<unknown>(client, LIST_FONTS, "listing fonts", { timeoutMs: 60000 });
        installed = Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? String(r[1]) : "")).filter((s) => s !== "") : [];
        desktop = (await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info")).desktop;
      } finally {
        client.close();
      }

      const checks: Check[] = [];
      const have = new Set(installed);
      for (const [role, ps] of Object.entries(kit.fonts)) {
        if (have.has(ps)) {
          checks.push({ check: `font ${role}`, status: "ok", note: ps });
          continue;
        }
        const stem = ps.split("-")[0]!.toLowerCase();
        const near = installed.filter((n) => n.toLowerCase().startsWith(stem)).slice(0, 5);
        checks.push({ check: `font ${role}`, status: "fail", note: `${ps} is not installed${near.length ? `; similar: ${near.join(" ")}` : `; find it with: ${BIN} fonts --grep ${stem}`}` });
      }
      for (const [key, p] of Object.entries(kit.logo ?? {})) {
        const problem = logoProblem(p);
        const seg = hiddenSegment(p);
        if (problem) checks.push({ check: `logo ${key}`, status: "fail", note: `${problem}: ${shownPath(p)}` });
        else if (seg) checks.push({ check: `logo ${key}`, status: "fail", note: `inside a hidden folder or file ('${seg}'); Affinity cannot read it` });
        else if (!isInside(resolve(desktop), p)) checks.push({ check: `logo ${key}`, status: "fail", note: `outside the Desktop folder (${desktop}); Affinity can only read files under it` });
        else checks.push({ check: `logo ${key}`, status: "ok", note: shownPath(p) });
      }
      for (const [fg, bg] of kit.pairs ?? []) {
        const row = contrastRow(kit, fg, bg);
        checks.push({ check: `contrast ${fg}/${bg}`, status: row.aa === "yes" ? "ok" : "warn", note: `${row.ratio}${row.aa === "yes" ? "" : " is below 4.5 (WCAG AA body text)"}` });
      }

      const count = (s: Check["status"]): number => checks.filter((c) => c.status === s).length;
      const fails = count("fail");
      const helps = fails > 0 ? [`${BIN} fonts --grep <name>   # exact postscript names`, `edit ${ref.path}, then ${BIN} brand check ${ref.path}`] : [`${BIN} run <script.js> --with-helpers --brand ${ref.path}`];
      print(
        [
          emitKV([["name", kit.name], ["path", ref.path]]),
          emitList("checks", checks as unknown as Array<Record<string, unknown>>, ["check", "status", "note"]),
          `summary: ok=${count("ok")} warn=${count("warn")} fail=${fails}`,
          helpBlock(helps),
        ].join("\n"),
      );
      return fails > 0 ? 1 : 0;
    },
  };
}

export function make(connect: ConnectFn): Record<"brand init" | "brand list" | "brand show" | "brand check", CommandModule> {
  return { "brand init": makeInit(), "brand list": makeList(), "brand show": makeShow(), "brand check": makeCheck(connect) };
}
