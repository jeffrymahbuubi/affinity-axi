// `templates list` and `templates new <name> --out <file.af>`: ready-made slot
// templates on a brand kit. `list` is offline. `new` validates everything it can
// before connecting, builds the document with the template's script (kit and
// ARGS injected, helpers appended), saves it with saveAs, records the run so the
// manifest gets madeBy and the kit, and closes the document only after the save
// reported dirty:false. A dirty or unclosable document is left open.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { CommandModule } from "../cli/router.js";
import { positiveFlag, type Parsed } from "../cli/args.js";
import { BRAND_FLAG, injectBrand, loadBrand, resolveBrandRef, type BrandKit } from "../affinity/brand.js";
import { withHelpers } from "../affinity/helpers.js";
import { recordSave, writeManifest } from "../affinity/manifest.js";
import { checkOverwrite, FORCE_FLAG } from "../affinity/overwrite.js";
import { requireUnderDesktop, requireVisible, userPath } from "../affinity/paths.js";
import { classify, resultText } from "../affinity/result.js";
import { APP_INFO, injectArgs } from "../affinity/scripts.js";
import { AxiError, UsageError } from "../output/errors.js";
import { helpBlock } from "../output/suggest.js";
import { emitKV, emitList, print } from "../output/toon.js";
import type { ConnectFn } from "../mcp/types.js";
import { TEMPLATES, templateByName, type Template } from "../templates/index.js";
import { IMAGE_EXT } from "../affinity/fill-script.js";
import { DOC_CLOSE, DOC_SAVE } from "./doc.js";
import { callJson, logRun } from "./run.js";

const BIN = "affinity-axi";
const DEFAULT_TIMEOUT_MS = 60000;
const USAGE = `usage: ${BIN} templates new <name> --out <file.af under Desktop> --brand <kit>`;
const NAMES = TEMPLATES.map((t) => t.name).join(", ");
const REQUIRED_TYPES = ["display", "h1", "body"];

// ---- a one-colour PNG, used as the photo placeholder so `fill` can swap a real picture in ----

const CRC_TABLE = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A size x size PNG filled with one #RRGGBB colour. */
export function solidPng(hex: string, size = 64): Buffer {
  const h = hex.replace("#", "");
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  const row = Buffer.alloc(size * 4 + 1);
  for (let x = 0; x < size; x++) {
    row[1 + x * 4] = rgb[0]!;
    row[2 + x * 4] = rgb[1]!;
    row[3 + x * 4] = rgb[2]!;
    row[4 + x * 4] = 255;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ---- arguments ----

interface TemplateArgs {
  rows?: unknown[];
  photo?: string;
}

/** --args for one template: only `rows` (price-post) and `photo` (the photo templates) are accepted. */
export function parseTemplateArgs(t: Template, raw: string | undefined): TemplateArgs {
  if (raw === undefined) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new UsageError("--args is not valid JSON", `example: --args '{"photo":"~/Desktop/photo.png"}'`);
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new UsageError("--args must be a JSON object", `example: --args '{"photo":"~/Desktop/photo.png"}'`);
  const out: TemplateArgs = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "photo") {
      if (!t.slots.includes("photo")) throw new UsageError(`template ${t.name} has no photo slot`, `photo applies to: ${TEMPLATES.filter((x) => x.slots.includes("photo")).map((x) => x.name).join(", ")}`);
      if (typeof val !== "string" || !IMAGE_EXT.test(val)) throw new UsageError("photo must be the path of a .png, .jpg, .jpeg, .webp, .heic, .heif, .tif or .tiff file", `example: --args '{"photo":"~/Desktop/photo.png"}'`);
      const p = userPath(val);
      if (!existsSync(p)) throw new UsageError(`photo not found: ${p}`, "paths are relative to the current directory");
      requireVisible(p, "photo");
      out.photo = p;
    } else if (k === "rows") {
      if (t.name !== "price-post") throw new UsageError(`template ${t.name} has no table`, "rows applies to price-post");
      if (!Array.isArray(val) || val.length < 1 || val.length > 5) throw new UsageError("rows must be 1 to 5 rows (the header first)", `example: --args '{"rows":[["Item","Price"],["Cut","30"]]}'`);
      const cols = Array.isArray(val[0]) ? (val[0] as unknown[]).length : 0;
      const ok = cols >= 1 && cols <= 4 && val.every((r) => Array.isArray(r) && r.length === cols && r.every((c) => typeof c === "string" || (typeof c === "number" && Number.isFinite(c))));
      if (!ok) throw new UsageError("every row needs the same 1 to 4 cells, each a string or a number", `example: --args '{"rows":[["Item","Price"],["Cut","30"]]}'`);
      out.rows = val;
    } else {
      throw new UsageError(`unknown --args key '${k}'`, "accepted keys: photo (photo templates), rows (price-post); fill the text afterwards with: fill");
    }
  }
  return out;
}

function requireKitTypes(t: Template, kit: BrandKit): void {
  for (const key of REQUIRED_TYPES) {
    if (!kit.type || !kit.type[key]) throw new UsageError(`template ${t.name}: the kit needs type.${key}`, `add type.${key} {font, size} to the kit; ${BIN} brand show shows what it has`);
  }
}

interface BuildReply {
  uuid: string | null;
  slots?: string[];
  error?: string;
}

/** Lists the slots in the template's declared order, then any extra the script reported. */
function orderSlots(t: Template, reported: string[]): string[] {
  const known = t.slots.filter((s) => reported.includes(s));
  return [...known, ...reported.filter((s) => !t.slots.includes(s))];
}

function makeList(): CommandModule {
  return {
    spec: {
      name: "templates list",
      summary: "List the ready-made slot templates: name, size, platform, slots (offline)",
      flags: [],
      examples: [`${BIN} templates list`],
    },
    run(): number {
      const rows = TEMPLATES.map((t) => ({ name: t.name, size: `${t.w}x${t.h}`, platform: t.platform ?? "", slots: t.slots.join(" ") }));
      print(
        [
          emitList("templates", rows, ["name", "size", "platform", "slots"]),
          helpBlock([`${BIN} templates new ig-post --out ~/Desktop/post.af --brand <kit.brand.json>`, `${BIN} platforms   # the sizes behind the templates`]),
        ].join("\n"),
      );
      return 0;
    },
  };
}

function makeNew(connect: ConnectFn): CommandModule {
  return {
    spec: {
      name: "templates new",
      summary: "Build a template on a brand kit and save it as .af, ready for fill (colours and fonts come from the kit)",
      args: [{ name: "name", required: true, description: `one of: ${NAMES}` }],
      flags: [
        { name: "out", type: "string", description: "where to save the .af; must be inside the Desktop folder (required)" },
        BRAND_FLAG,
        FORCE_FLAG,
        { name: "args", type: "string", description: `JSON: {"photo": "<image>"} on photo templates, {"rows": [[...]]} on price-post` },
        { name: "timeout", type: "string", default: String(DEFAULT_TIMEOUT_MS), description: "per-script timeout in milliseconds" },
        { name: "url", type: "string", description: "Affinity MCP URL (AFFINITY_MCP_URL wins; default http://[::1]:6767)" },
      ],
      examples: [
        `${BIN} templates new ig-post --out ~/Desktop/post.af --brand brand.json`,
        `${BIN} templates new price-post --out ~/Desktop/prices.af --args '{"rows":[["Cut","Price"],["Trim","30"]]}'`,
      ],
    },
    async run(parsed: Parsed): Promise<number> {
      const name = parsed.positionals[0]!;
      const t = templateByName(name);
      if (!t) throw new UsageError(`unknown template '${name}'`, `templates: ${NAMES}; run '${BIN} templates list'`);
      const rawOut = parsed.flags["out"];
      if (typeof rawOut !== "string") throw new UsageError("--out is required (the .af to save)", USAGE);
      const out = userPath(rawOut);
      if (!out.toLowerCase().endsWith(".af")) throw new UsageError(`--out must end in .af: ${out}`, USAGE);
      requireVisible(out, "--out");
      const timeoutMs = positiveFlag(parsed, "timeout", { integer: true, fallback: DEFAULT_TIMEOUT_MS, example: "60000" });
      const userArgs = parseTemplateArgs(t, typeof parsed.flags["args"] === "string" ? parsed.flags["args"] : undefined);

      const brandPath = resolveBrandRef(typeof parsed.flags["brand"] === "string" ? parsed.flags["brand"] : undefined, process.env, process.cwd());
      if (!brandPath) throw new UsageError("templates need a brand kit", `pass --brand <kit.brand.json>, set $AFFINITY_AXI_BRAND, or create one: ${BIN} brand init <name>`);
      const brand = loadBrand(brandPath);
      requireKitTypes(t, brand.kit);

      // A hand-edited file, or one affinity-axi never saved, is not overwritten without --force.
      const verdict = checkOverwrite(out, { force: parsed.flags["force"] === true, cmd: `${BIN} templates new ${name} --out ${rawOut}` });
      if (!verdict.ok) throw new AxiError(verdict.message, verdict.suggestion);

      const client = await connect({ url: typeof parsed.flags["url"] === "string" ? parsed.flags["url"] : undefined });
      const placeholder = join(dirname(out), `axi-photo-placeholder-${process.pid}.png`);
      let uuid = "";
      let slots: string[] = [];
      const started = Date.now();
      try {
        const app = await callJson<{ desktop: string }>(client, APP_INFO, "reading Affinity app info");
        const desktop = resolve(app.desktop);
        requireUnderDesktop(desktop, out, "--out", "write-file");
        if (userArgs.photo !== undefined) requireUnderDesktop(desktop, userArgs.photo, "photo", "read-image");
        mkdirSync(dirname(out), { recursive: true });

        // The photo slot needs a real picture in a frame for fill to replace; without one, a one-colour placeholder stands in.
        const scriptArgs: TemplateArgs = { ...userArgs };
        if (t.slots.includes("photo") && userArgs.photo === undefined) {
          const keys = Object.keys(brand.kit.colours);
          writeFileSync(placeholder, solidPng(brand.kit.colours[keys[keys.length > 1 ? 1 : 0]!]!));
          scriptArgs.photo = placeholder;
        }
        const source = withHelpers(injectBrand(injectArgs(t.source, JSON.stringify(scriptArgs)), brand.kit));

        let text: string;
        try {
          const result = await client.callTool("execute_script", { script: source }, { timeoutMs });
          const outcome = classify(result);
          if (outcome.kind !== "ok") {
            const why = outcome.kind === "exception" ? outcome.error.replace(/^\w*Error: /, "") : (resultText(result).split("\n").find((l) => l.trim() !== "") ?? outcome.kind);
            throw new AxiError(why, "fix the kit or --args; nothing was created");
          }
          text = outcome.text;
        } catch (err) {
          if (err instanceof AxiError) throw err;
          throw new AxiError(`building ${name} failed: ${err instanceof Error ? err.message : String(err)}`, "check Affinity for an open dialog or an unsaved document; do not re-run blindly");
        }
        let reply: BuildReply;
        try {
          reply = JSON.parse(text.split("\n").filter((l) => l.trim() !== "").pop() ?? "") as BuildReply;
        } catch {
          throw new AxiError(`building ${name} returned unreadable output`, "check Affinity for an unsaved document; do not re-run blindly");
        }
        if (reply.error !== undefined || !reply.uuid) {
          if (reply.uuid) {
            logRun({ cmd: "templates", script: `templates/${name}`, source: t.source, args: userArgs, flags: [], outcome: "error", ms: Date.now() - started, documents: [{ uuid: reply.uuid, path: "" }], brand: brand.ref });
            throw new AxiError(`template ${name}: ${reply.error ?? "no document was reported"} (document ${reply.uuid} is unsaved and left open)`, "check Affinity; save it with: doc save <doc> <path>.af, or close it by hand");
          }
          throw new AxiError(`template ${name}: ${reply.error ?? "no document was reported"}`, "fix the kit or --args");
        }
        uuid = reply.uuid.toUpperCase();
        slots = orderSlots(t, reply.slots ?? []);

        const saved = await callJson<{ status: string; dirty?: boolean }>(client, DOC_SAVE(uuid, out), "saving the document");
        if (saved.status === "missing") throw new AxiError(`document ${uuid} vanished before it was saved`, "check Affinity");
        if (saved.dirty !== false || !existsSync(out)) {
          throw new AxiError(saved.dirty !== false ? `${out} is still dirty after save; left open (${uuid})` : `save reported success but ${out} was not written; left open (${uuid})`, "check Affinity; do not close it blindly");
        }
        logRun({ cmd: "templates", script: `templates/${name}`, source: t.source, args: userArgs, flags: [], outcome: "ok", ms: Date.now() - started, documents: [{ uuid, path: out }], brand: brand.ref });
        try {
          const m = recordSave(out, uuid, null, process.cwd(), { forced: verdict.forced });
          // The file's origin is this command; the kit path is relative to the .af like every manifest path.
          const kitPath = relative(dirname(out), resolve(process.cwd(), brand.ref.path));
          m.madeBy = { script: `templates/${name}`, scriptSha256: m.madeBy?.scriptSha256 ?? "", args: userArgs, flags: [], brand: { ...brand.ref, path: kitPath } };
          writeManifest(out, m);
        } catch {
          // the file is saved; the manifest is best effort
        }
        const closed = await callJson<{ status: string }>(client, DOC_CLOSE(uuid), "closing the document");
        if (closed.status !== "closed" && closed.status !== "missing") {
          throw new AxiError(`document ${uuid} is still open after save (${closed.status})`, "check Affinity; do not close it blindly");
        }
      } finally {
        client.close();
        rmSync(placeholder, { force: true });
      }

      const pairs: Array<[string, unknown]> = [
        ["template", name],
        ["doc", uuid],
        ["saved", out],
        [`slots[${slots.length}]`, slots.join(", ")],
      ];
      print([emitKV(pairs), helpBlock([`${BIN} fill ${rawOut} --data <records.json> --out-dir <dir> --export PNG`, `${BIN} doc open ${rawOut}`])].join("\n"));
      return 0;
    },
  };
}

export function make(connect: ConnectFn): Record<"templates list" | "templates new", CommandModule> {
  return { "templates list": makeList(), "templates new": makeNew(connect) };
}
