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

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { UsageError } from "../output/errors.js";
import { exifOrientation, orientationOps } from "./orientation.js";
import { expandHome } from "./paths.js";

const BIN = "affinity-axi";
/** The picture types a slot takes (HEIC, HEIF and TIFF were loaded live by Bitmap.loadFromFile). */
export const IMAGE_EXT = /\.(png|jpe?g|webp|heic|heif|tiff?)$/i;
const IMAGE_TYPES = "png, jpg, jpeg, webp, heic, heif, tif or tiff";
const FILE_EXT = /\.[a-z0-9]{2,5}$/i;
const HEX = /^#[0-9a-fA-F]{6}$/;
const FITS = ["contain", "cover", "stretch"];
const OBJECT_KEYS = ["text", "fill", "colour", "image", "fit", "box", "hidden", "cutout", "colourise", "align", "padding"];
const CUTOUTS = ["background", "subject"];
const ALIGNS = ["none", "centre", "fit"];

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
  /** ML cut-out of the placed photo (needs image). */
  cutout?: "background" | "subject";
  /** ML colourise of the placed photo (needs image). */
  colourise?: true;
  /** Re-centre ("centre") or scale-to-fit ("fit") the cut-out in its frame; absent means none. Needs cutout. */
  align?: "centre" | "fit";
  /** Margin in px kept free by align "fit". */
  padding?: number;
  box?: Box;
  hidden?: boolean;
  /** Degrees clockwise that make the picture upright (from its EXIF orientation); absent when none. */
  rotate?: 90 | 180 | 270;
  /** Horizontal flip, applied before rotate (from its EXIF orientation). */
  mirror?: true;
}

/** What the apply script logs. */
export interface ApplyReply {
  applied: string[];
  unknown: string[];
  duplicate: Array<{ key: string; paths: string[] }>;
  mismatch: Array<{ key: string; node: string; got: string }>;
  slots: string[];
  /** Per-slot remarks, e.g. "headline: text shrunk from 64 to 41 px to stay on ig-square". */
  notes: string[];
  /** The apply exception message when the script failed (applied is then []). */
  error?: string;
  /** With error: true when undo left the document clean. */
  cleaned?: boolean;
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

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
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
  if (!IMAGE_EXT.test(p)) throw bad(key, `'${raw}' is not a .png, .jpg, .jpeg, .webp, .heic, .heif, .tif or .tiff file`, `use ${IMAGE_TYPES}`);
  if (!existsSync(p)) throw bad(key, `image file not found: ${p}`, "paths are relative to the data file's folder");
  return p;
}

/** Sets rotate/mirror on a picture edit from the file's EXIF orientation (JPEG and TIFF); nothing when upright or unknown. */
function orient(e: Edit, file: string): void {
  const o = exifOrientation(file);
  if (o === null) return;
  const ops = orientationOps(o);
  if (ops.rotate !== 0) e.rotate = ops.rotate;
  if (ops.mirror) e.mirror = true;
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
  if (o["image"] !== undefined) {
    e.image = imageFile(key, o["image"], dataDir);
    orient(e, e.image);
  }
  if (o["fit"] !== undefined) {
    if (e.image === undefined) throw bad(key, "fit needs an image", `use {"image": "photo.png", "fit": "cover"}`);
    if (typeof o["fit"] !== "string" || !FITS.includes(o["fit"])) throw bad(key, `invalid fit '${String(o["fit"])}'`, `fit is one of ${FITS.join(", ")}`);
    e.fit = o["fit"];
  }
  if (o["cutout"] !== undefined) {
    const c = o["cutout"];
    const valid = typeof c === "boolean" || (typeof c === "string" && CUTOUTS.includes(c));
    if (!valid) throw bad(key, "cutout must be true, false, 'background' or 'subject'", `e.g. {"image": "photo.jpg", "cutout": true}`);
    if (e.image === undefined) throw bad(key, "cutout needs an image", `use {"image": "photo.jpg", "cutout": true}`);
    if (c === true) e.cutout = "background";
    else if (c !== false) e.cutout = c as "background" | "subject";
  }
  if (o["colourise"] !== undefined) {
    if (typeof o["colourise"] !== "boolean") throw bad(key, "colourise must be true or false", `e.g. {"image": "photo.jpg", "colourise": true}`);
    if (e.image === undefined) throw bad(key, "colourise needs an image", `use {"image": "photo.jpg", "colourise": true}`);
    if (o["colourise"]) e.colourise = true;
  }
  if (o["align"] !== undefined) {
    const a = o["align"];
    if (typeof a !== "string" || !ALIGNS.includes(a)) throw bad(key, "align must be 'none', 'centre' or 'fit'", `e.g. {"image": "photo.jpg", "cutout": true, "align": "fit"}`);
    if (e.cutout === undefined) throw bad(key, "align needs cutout", `use {"image": "photo.jpg", "cutout": true, "align": "fit"}`);
    if (a !== "none") e.align = a as "centre" | "fit";
  }
  if (o["padding"] !== undefined) {
    const p = o["padding"];
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0) throw bad(key, "padding must be a number of 0 or more", `e.g. {"image": "photo.jpg", "cutout": true, "align": "fit", "padding": 40}`);
    if (e.align !== "fit") throw bad(key, "padding needs align 'fit'", `use {"image": "photo.jpg", "cutout": true, "align": "fit", "padding": 40}`);
    e.padding = p;
  }
  // A cut-out in a picture slot is centred in its frame unless the record says otherwise.
  if (e.cutout !== undefined && o["align"] === undefined) e.align = "centre";
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
 * A plain string that ends in .png/.jpg/.jpeg/.webp/.heic/.heif/.tif/.tiff is an image
 * candidate when the file exists or the string has no whitespace; otherwise it is text.
 * A plain string without whitespace that is an existing file of another type is an
 * unsupported image type. EXIF orientation of JPEG and TIFF pictures becomes rotate/mirror.
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
        if (existsSync(p)) {
          e.strImage = p;
          orient(e, p);
        } else if (!/\s/.test(v)) throw bad(key, `image file not found: ${p}`, "paths are relative to the data file's folder");
      } else if (FILE_EXT.test(v) && !/\s/.test(v) && isFile(imagePath(v, dataDir))) {
        throw bad(key, `'${v}' is an unsupported image type`, `use ${IMAGE_TYPES}`);
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
 * Loads the template unless the user already has it open, or has the target .af open.
 * Logs {"status":"loaded"|"already-open"|"target-open","uuid"}. Never reloads an open
 * document; with `target-open` nothing is loaded (saving over an open file would fail
 * with OPEN_IN_APP after the template was filled), and the uuid is the open target's.
 */
export function FILL_OPEN(templatePath: string, targetPath: string): string {
  return [
    "/* affinity-axi:fill-open */",
    "const { Document } = require('/document.js');",
    `const target = ${JSON.stringify(templatePath)};`,
    `const targetAf = ${JSON.stringify(targetPath)};`,
    "const targetOpen = Document.all.find((d) => String(d.path || '') === targetAf);",
    "const open = Document.all.find((d) => String(d.path || '') === target);",
    "if (targetOpen) { console.log(JSON.stringify({ status: 'target-open', uuid: String(targetOpen.sessionUuid) })); }",
    "else if (open) { console.log(JSON.stringify({ status: 'already-open', uuid: String(open.sessionUuid) })); }",
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
    "const out = { applied: [], unknown: [], duplicate: [], mismatch: [], slots: [], notes: [] };",
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
    "    else if (e.strImage !== undefined && isPic) { ops.push(['image', e.strImage, '', false, '', '', 0, e.rotate || 0, !!e.mirror]); }",
    "    else { problem = e.strImage !== undefined ? 'an image' : (HEX.test(e.str) ? 'a colour' : 'text'); }",
    "  }",
    "  if (e.text !== undefined) { if (isText) { ops.push(['text', e.text]); } else { problem = problem || 'text'; } }",
    "  if (e.fill !== undefined) { if (!isPic) { ops.push(['fill', e.fill]); } else { problem = problem || 'a colour'; } }",
    "  if (e.image !== undefined) { if (isPic) { ops.push(['image', e.image, e.fit || '', !!e.colourise, e.cutout || '', e.align || '', e.padding || 0]); ops[ops.length - 1].push(e.rotate || 0, !!e.mirror); } else { problem = problem || 'an image'; } }",
    "  if (e.box !== undefined) { ops.push(['box', e.box]); }",
    "  if (e.hidden !== undefined) { ops.push(['hidden', e.hidden]); }",
    "  if (problem) { out.mismatch.push({ key: key, node: kind, got: problem }); return; }",
    "  plan.push({ key: key, ref: e.ref, ops: ops });",
    "});",
    // Sets a text slot, then keeps it in bounds: a frame fits its pre-edit frame box, artistic
    // text fits the board (width by anchor, same margin as before on the anchored side). It is
    // shrunk to half its size at most. Affinity keeps a right/centre story on its anchor natively
    // (setText and the shrink alike), so the fill never moves a text node; a shrink that reaches
    // the floor always says so and says how far the text still runs.
    "function fillText(p, text) {",
    "  const tn = axiFind(doc, p.ref);",
    "  const before = axiNodeBox(tn);",
    "  const anchor = axiAlignOf(tn);",
    "  const isFrame = String(tn[Symbol.toStringTag]) === 'FrameTextNode';",
    "  const board = axiBoardBox(doc, tn);",
    "  axiSetText(doc, p.ref, text);",
    "  if (text === '') { return; }",
    "  const right = before.x + before.w;",
    "  const boardRight = board.x + board.w;",
    "  const cx = before.x + before.w / 2;",
    "  let w = before.w;",
    "  let h = before.h;",
    "  let limitLeft = before.x;",
    "  let limitRight = right;",
    "  if (!isFrame) {",
    "    h = 1e9;",
    "    if (anchor === 'r') { limitLeft = board.x + (boardRight - right); limitRight = right; }",
    "    else if (anchor === 'c') { const half = Math.min(cx - board.x, boardRight - cx); limitLeft = cx - half; limitRight = cx + half; }",
    "    else { limitLeft = before.x; limitRight = boardRight - (before.x - board.x); }",
    "    w = limitRight - limitLeft;",
    "  }",
    "  if (!(w > 0)) { return; }",
    "  const r = axiShrinkText(doc, p.ref, { w: w, h: h });",
    "  const after = axiNodeBox(tn);",
    "  const where = board.name || 'the document';",
    "  const dims = Math.round(before.w) + 'x' + Math.round(before.h);",
    "  const shrunkTo = 'text shrunk from ' + r.from + ' to ' + r.size + ' px';",
    "  if (isFrame) {",
    "    if (r.fits) { if (r.size < r.from) { out.notes.push(p.key + ': ' + shrunkTo + ' to fit its ' + dims + ' frame'); } }",
    "    else if (r.size < r.from) { out.notes.push(p.key + ': ' + shrunkTo + ' (the floor); still overflows its ' + dims + ' frame'); }",
    "    else { out.notes.push(p.key + ': overflows its ' + dims + ' frame at ' + r.size + ' px (cannot shrink below 8 px)'); }",
    "  } else if (r.fits) {",
    "    if (r.size < r.from) { out.notes.push(p.key + ': ' + shrunkTo + ' to stay on ' + where); }",
    "  } else {",
    "    const pastRight = (after.x + after.w) - boardRight;",
    "    const pastLeft = board.x - after.x;",
    "    const intoRight = (after.x + after.w) - limitRight;",
    "    const intoLeft = limitLeft - after.x;",
    "    let how = '';",
    "    if (pastRight > 0.5 || pastLeft > 0.5) {",
    "      const sideB = pastRight >= pastLeft ? 'right' : 'left';",
    "      how = Math.round(sideB === 'right' ? pastRight : pastLeft) + ' px past the ' + sideB + ' edge of ' + where;",
    "    } else if (intoRight > 0.5 || intoLeft > 0.5) {",
    "      const sideM = intoRight >= intoLeft ? 'right' : 'left';",
    "      how = Math.round(sideM === 'right' ? intoRight : intoLeft) + ' px into the ' + sideM + ' margin of ' + where;",
    "    }",
    "    if (r.size < r.from) { out.notes.push(p.key + ': ' + shrunkTo + ' (the floor)' + (how ? '; still runs ' + how : '')); }",
    "    else if (how) { out.notes.push(p.key + ': runs ' + how + ' at ' + r.size + ' px (cannot shrink below 8 px)'); }",
    "  }",
    "}",
    "const blocked = out.duplicate.length > 0 || out.mismatch.length > 0 || (out.unknown.length > 0 && !ignoreUnknown);",
    // An exception undoes what the script did so far (until the document is clean) and is
    // reported in the reply, so the command can close the document and go on.
    // A document that was already dirty is never undone: its earlier changes are not ours.
    "const wasDirty = !!doc.isDirty;",
    "if (!blocked) {",
    "  try {",
    "    plan.forEach(function (p) {",
    "      p.ops.forEach(function (op) {",
    "        if (op[0] === 'text') { fillText(p, op[1]); }",
    "        else if (op[0] === 'fill') { axiSetFill(doc, p.ref, op[1]); }",
    "        else if (op[0] === 'image') {",
    "          const io = {};",
    "          if (op[2]) { io.fit = op[2]; }",
    "          if (op[7]) { io.rotate = op[7]; }",
    "          if (op[8]) { io.mirror = true; }",
    "          const n = axiReplaceImage(doc, axiFind(doc, p.ref), op[1], io);",
    "          if (op[3]) { axiColourise(doc, n); }",
    "          if (op[4]) { axiCutout(doc, n, { method: op[4], transparent: false, align: op[5] || 'none', padding: op[6] || 0 }); }",
    "        }",
    "        else if (op[0] === 'box') { axiSetBox(doc, p.ref, op[1]); }",
    "        else if (op[0] === 'hidden') { doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, axiFind(doc, p.ref)), !op[1])); }",
    "      });",
    "      out.applied.push(p.key);",
    "    });",
    "  } catch (e) {",
    "    for (let i = 0; i < 200 && !wasDirty && doc.isDirty && doc.canUndo; i++) { doc.undo(); }",
    "    out.applied = [];",
    "    out.error = String(e && e.message ? e.message : e);",
    "    out.cleaned = !doc.isDirty;",
    "  }",
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
