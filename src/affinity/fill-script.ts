// `fill`: slot planning (pure, offline) and the two Affinity scripts it owns.
//
// A slot is an element named `slot:<key>` (its userDescription, the Layers
// panel name). A data key `k` fills `slot:k`; `board/k` fills `board/slot:k`
// (the artboard-qualified form of the named helpers). Elements without the
// `slot:` prefix are never touched.
//
// The apply script is appended with the named/image helpers by the command
// (withHelpers). It resolves every key first and changes nothing when any key
// is unknown (unless forgiven), duplicate or of the wrong kind, so a refused
// record leaves the document clean and it can be closed.
//
// The console.log calls inside the script strings are required output: the
// only channel back from Affinity.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { UsageError } from "../output/errors.js";
import { expandHome } from "./paths.js";

const BIN = "affinity-axi";
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FITS = ["contain", "cover", "stretch"];
const OBJECT_KEYS = ["text", "fill", "colour", "image", "fit", "box", "hidden"];

export interface Box {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** One slot edit, as sent to the apply script. */
export interface Edit {
  key: string;
  /** `slot:k` or `board/slot:k`. */
  ref: string;
  /** Plain string value: decides by node type (text, colour or image). */
  str?: string;
  /** Absolute image path when the plain string looks like an image file. */
  strImage?: string;
  text?: string;
  fill?: string;
  image?: string;
  fit?: string;
  box?: Box;
  hidden?: boolean;
}

/** What the apply script logs. */
export interface ApplyReply {
  applied: string[];
  unknown: string[];
  duplicate: Array<{ key: string; paths: string[] }>;
  mismatch: Array<{ key: string; node: string; got: string }>;
  slots: string[];
}

/** Absolute form of an image path: relative to the data file's folder unless absolute or ~. */
function imagePath(p: string, dataDir: string): string {
  const e = expandHome(p);
  return isAbsolute(e) ? e : resolve(dataDir, e);
}

/** The element ref for a data key: `slot:k`, or `board/slot:k` for `board/k`. */
export function slotRef(key: string): string {
  const i = key.lastIndexOf("/");
  if (i < 0) return `slot:${key}`;
  return `${key.slice(0, i)}/slot:${key.slice(i + 1)}`;
}

function bad(key: string, why: string, fix: string): UsageError {
  return new UsageError(`slot '${key}': ${why}`, fix);
}

function checkKey(key: string): void {
  const i = key.lastIndexOf("/");
  if (key.trim() === "" || (i >= 0 && (i === 0 || i === key.length - 1))) {
    throw new UsageError(`invalid slot key '${key}'`, "use a name like headline, or board/headline to target one artboard");
  }
}

function imageFile(key: string, raw: unknown, dataDir: string): string {
  if (typeof raw !== "string" || raw === "") throw bad(key, "image must be a file path", `use {"image": "photo.png"}`);
  const p = imagePath(raw, dataDir);
  if (!IMAGE_EXT.test(p)) throw bad(key, `'${raw}' is not a .png, .jpg, .jpeg or .webp file`, "use a PNG, JPEG or WebP image");
  if (!existsSync(p)) throw bad(key, `image file not found: ${p}`, "paths are relative to the data file's folder");
  return p;
}

function boxOf(key: string, v: unknown): Box {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad(key, "box must be an object", `use {"box": {"x":0,"y":0,"w":100,"h":100}}`);
  const out: Box = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (!["x", "y", "w", "h"].includes(k)) throw bad(key, `unknown box field '${k}'`, "box fields are x, y, w and h (document px)");
    if (typeof n !== "number" || !Number.isFinite(n)) throw bad(key, `box.${k} must be a finite number`, "give plain numbers");
    if ((k === "w" || k === "h") && !(n > 0)) throw bad(key, `box.${k} must be positive`, "width and height are positive document px");
    out[k as keyof Box] = n;
  }
  if (Object.keys(out).length === 0) throw bad(key, "box is empty", "give at least one of x, y, w, h");
  return out;
}

function scalarText(key: string, v: unknown, what: string): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  throw bad(key, `${what} must be a string or number`, "text values are strings (numbers are written as digits)");
}

function explicit(key: string, ref: string, o: Record<string, unknown>, dataDir: string): Edit {
  const unknown = Object.keys(o).filter((k) => !OBJECT_KEYS.includes(k));
  if (unknown.length > 0) throw bad(key, `unknown field '${unknown[0]}'`, `an object value takes ${OBJECT_KEYS.join(", ")}`);
  if (Object.keys(o).length === 0) throw bad(key, "empty object", `give one of ${OBJECT_KEYS.join(", ")}`);
  const e: Edit = { key, ref };
  if (o["text"] !== undefined) e.text = scalarText(key, o["text"], "text");
  if (o["fill"] !== undefined && o["colour"] !== undefined) throw bad(key, "fill and colour both given", `they mean the same: give one, e.g. {"colour": "#FFC857"}`);
  const colourKey = o["colour"] !== undefined ? "colour" : "fill";
  const colour = o[colourKey];
  if (colour !== undefined) {
    if (typeof colour !== "string" || !HEX.test(colour)) throw bad(key, `${colourKey} must be a #RRGGBB colour`, `e.g. {"${colourKey}": "#FFC857"}`);
    e.fill = colour;
  }
  if (o["image"] !== undefined) e.image = imageFile(key, o["image"], dataDir);
  if (o["fit"] !== undefined) {
    if (e.image === undefined) throw bad(key, "fit needs an image", `use {"image": "photo.png", "fit": "cover"}`);
    if (typeof o["fit"] !== "string" || !FITS.includes(o["fit"])) throw bad(key, `invalid fit '${String(o["fit"])}'`, `fit is one of ${FITS.join(", ")}`);
    e.fit = o["fit"];
  }
  if (o["box"] !== undefined) e.box = boxOf(key, o["box"]);
  if (o["hidden"] !== undefined) {
    if (typeof o["hidden"] !== "boolean") throw bad(key, "hidden must be true or false", `e.g. {"hidden": true}`);
    e.hidden = o["hidden"];
  }
  return e;
}

/**
 * The slot edits for one record. Pure apart from checking that image files
 * exist; every error is a UsageError so the run stops before connecting.
 * A plain string that ends in .png/.jpg/.jpeg/.webp is an image candidate when
 * the file exists or the string has no whitespace; otherwise it is text.
 */
export function planEdits(record: Record<string, unknown>, keyField: string | undefined, dataDir: string): Edit[] {
  const edits: Edit[] = [];
  for (const [key, v] of Object.entries(record)) {
    if (key === keyField) continue;
    checkKey(key);
    const ref = slotRef(key);
    if (typeof v === "string") {
      const e: Edit = { key, ref, str: v };
      if (IMAGE_EXT.test(v)) {
        const p = imagePath(v, dataDir);
        if (existsSync(p)) e.strImage = p;
        else if (!/\s/.test(v)) throw bad(key, `image file not found: ${p}`, "paths are relative to the data file's folder");
      }
      edits.push(e);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      edits.push({ key, ref, str: String(v) });
    } else if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      edits.push(explicit(key, ref, v as Record<string, unknown>, dataDir));
    } else {
      throw bad(key, "unsupported value", `use a string, a number or an object like {"fill": "#FFC857"}; see: ${BIN} fill --help`);
    }
  }
  return edits;
}

/** Every image path the edits will load (for the Desktop check). */
export function imagePaths(edits: Edit[]): string[] {
  const out: string[] = [];
  for (const e of edits) {
    if (e.strImage !== undefined) out.push(e.strImage);
    if (e.image !== undefined) out.push(e.image);
  }
  return out;
}

/** File extension (no dot) a preset writes, or undefined when unknown. */
export function extFor(preset: string): string | undefined {
  const p = preset.trim().toLowerCase();
  const table: Array<[string, string]> = [
    ["png", "png"], ["jpeg xl", "jxl"], ["jpeg", "jpg"], ["webp", "webp"], ["gif", "gif"], ["tiff", "tif"],
    ["svg", "svg"], ["eps", "eps"], ["pdf", "pdf"], ["epub", "epub"], ["dwg", "dwg"], ["dxf", "dxf"],
    ["psd", "psd"], ["openexr", "exr"], ["radiance", "hdr"], ["tga", "tga"],
  ];
  return table.find(([prefix]) => p.startsWith(prefix))?.[1];
}

/**
 * Loads the template unless the user already has it open. Logs
 * {"status":"loaded"|"already-open","uuid"}. Never reloads an open document.
 */
export function FILL_OPEN(path: string): string {
  return [
    "/* affinity-axi:fill-open */",
    "const { Document } = require('/document.js');",
    `const target = ${JSON.stringify(path)};`,
    "const open = Document.all.find((d) => String(d.path || '') === target);",
    "if (open) { console.log(JSON.stringify({ status: 'already-open', uuid: String(open.sessionUuid) })); }",
    "else {",
    "  const doc = Document.load(target);",
    "  console.log(JSON.stringify({ status: 'loaded', uuid: String(doc.sessionUuid) }));",
    "}",
  ].join("\n");
}

/**
 * Applies the edits to the loaded document. Logs an ApplyReply. Append the
 * helpers (withHelpers) before sending. Nothing is changed when any key is
 * duplicate, of the wrong kind, or unknown (unless ignoreUnknown).
 */
export function FILL_APPLY(docUuid: string, edits: Edit[], ignoreUnknown: boolean): string {
  return [
    "/* affinity-axi:fill-apply */",
    "const { Document } = require('/document.js');",
    "const { DocumentCommand } = require('/commands.js');",
    "const { Selection } = require('/selections.js');",
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    // The key is not sent: it is the ref without its slot: prefix.
    `const edits = ${JSON.stringify(edits.map(({ key: _key, ...rest }) => rest))};`,
    `const ignoreUnknown = ${ignoreUnknown ? "true" : "false"};`,
    "const doc = Document.all.find((d) => String(d.sessionUuid) === targetUuid);",
    "if (!doc) { throw new Error('No document with that Uuid exists.'); }",
    "const HEX = /^#[0-9a-fA-F]{6}$/;",
    "const out = { applied: [], unknown: [], duplicate: [], mismatch: [], slots: [] };",
    "const seen = {};",
    "axiNames(doc).forEach(function (r) {",
    "  if (r.name.indexOf('slot:') === 0 && !seen[r.name]) { seen[r.name] = true; out.slots.push(r.name); }",
    "});",
    "const plan = [];",
    "edits.forEach(function (e) {",
    "  const key = e.ref.replace('slot:', '');",
    "  const rows = axiResolve(doc, e.ref);",
    "  if (rows.length === 0) { out.unknown.push(key); return; }",
    "  if (rows.length > 1) { out.duplicate.push({ key: key, paths: rows.map(function (r) { return '#' + r.path; }) }); return; }",
    "  const n = rows[0].node;",
    "  const isText = rows[0].text !== null;",
    "  const isPic = !!(n.isImageNode || n.isRasterNode || n.pictureFrameEnabled);",
    "  const kind = isText ? 'text node' : (isPic ? 'picture' : 'shape');",
    "  const ops = [];",
    "  let problem = '';",
    "  if (e.str !== undefined) {",
    "    if (isText) { ops.push(['text', e.str]); }",
    "    else if (HEX.test(e.str) && !isPic) { ops.push(['fill', e.str]); }",
    "    else if (e.strImage !== undefined && isPic) { ops.push(['image', e.strImage, '']); }",
    "    else { problem = e.strImage !== undefined ? 'an image' : (HEX.test(e.str) ? 'a colour' : 'text'); }",
    "  }",
    "  if (e.text !== undefined) { if (isText) { ops.push(['text', e.text]); } else { problem = problem || 'text'; } }",
    "  if (e.fill !== undefined) { if (!isPic) { ops.push(['fill', e.fill]); } else { problem = problem || 'a colour'; } }",
    "  if (e.image !== undefined) { if (isPic) { ops.push(['image', e.image, e.fit || '']); } else { problem = problem || 'an image'; } }",
    "  if (e.box !== undefined) { ops.push(['box', e.box]); }",
    "  if (e.hidden !== undefined) { ops.push(['hidden', e.hidden]); }",
    "  if (problem) { out.mismatch.push({ key: key, node: kind, got: problem }); return; }",
    "  plan.push({ key: key, ref: e.ref, ops: ops });",
    "});",
    "const blocked = out.duplicate.length > 0 || out.mismatch.length > 0 || (out.unknown.length > 0 && !ignoreUnknown);",
    "if (!blocked) {",
    "  plan.forEach(function (p) {",
    "    p.ops.forEach(function (op) {",
    "      if (op[0] === 'text') { axiSetText(doc, p.ref, op[1]); }",
    "      else if (op[0] === 'fill') { axiSetFill(doc, p.ref, op[1]); }",
    "      else if (op[0] === 'image') { axiReplaceImage(doc, axiFind(doc, p.ref), op[1], op[2] ? { fit: op[2] } : undefined); }",
    "      else if (op[0] === 'box') { axiSetBox(doc, p.ref, op[1]); }",
    "      else if (op[0] === 'hidden') { doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, axiFind(doc, p.ref)), !op[1])); }",
    "    });",
    "    out.applied.push(p.key);",
    "  });",
    "}",
    "console.log(JSON.stringify(out));",
  ].join("\n");
}

const plain = (slot: string): string => slot.replace(/^slot:/, "");

/** The reasons a record cannot be filled; empty when it can. `ignoreUnknown` forgives only unknown slots. */
export function problemsOf(r: ApplyReply, ignoreUnknown: boolean): string[] {
  const out: string[] = [];
  const names = r.slots.map(plain);
  if (!ignoreUnknown) {
    for (const k of r.unknown) {
      out.push(`unknown slot '${k}' (slots: ${names.length > 0 ? names.join(", ") : "none; name elements slot:<key> in the Layers panel"})`);
    }
  }
  for (const d of r.duplicate) out.push(`duplicate slot '${d.key}' at ${d.paths.join(", ")} (qualify as board/${d.key}, or rename one)`);
  for (const m of r.mismatch) out.push(`slot '${m.key}' is a ${m.node}; got ${m.got}`);
  return out;
}
