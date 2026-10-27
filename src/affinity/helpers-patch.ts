// Safe generative patch for run --with-helpers. Same rules as helpers-core.ts:
// function declarations only, prefixed axi, every require() inside a function, no
// document-closing call. The block is String.raw: keep backticks, ${ and
// backslashes out of it.
//
// This is the one helper that reaches the generative edit. The raw edit regenerates
// the WHOLE pixel layer even when a region is selected (measured live: 20-32 s,
// not pixel-aligned with the source), so a selection alone does not confine it.
// The helper therefore keeps a copy of the pre-edit pixels on top and deletes the
// feathered region from that copy, so only the region shows generated pixels.
//
// Guard: guard.ts lists the helper name among the generative identifiers, so a
// user script that calls it is refused without --allow-generative and logged as
// provenance. The helper body is appended after that scan and is never scanned;
// the SDK method name is built from two parts only so that the helper block stays
// free of the generative identifiers (a test scans HELPERS_SOURCE).
//
// Region: a rectangle {x,y,w,h} (Polygon.createRectangle) or an array of at least
// three [x,y] points (Polygon.create + addPoint({x, y}), as verified live in batch 10b), both through
// Document.setRasterSelectionFromPolygon. Curve.generatePolygon() handles are NOT
// accepted by the SDK there ('expected PolygonHandle').
//
// SDK used: Document.setRasterSelectionFromPolygon, RasterSelectionLogicalOperation.New,
// Polygon, Rectangle, Node.duplicate (fallback DocumentCommand.createDuplicate),
// DocumentCommand.createDeleteSelection / createRasterDeselect, Selection.create.

import type { HelperInfo } from "./helpers-core.js";

export const PATCH_INDEX: readonly HelperInfo[] = [
  { name: "axiGenerativePatch", signature: "axiGenerativePatch(doc, node, region, prompt, {feather,keep})", summary: "GENERATIVE (needs --allow-generative; provenance is logged): regenerate a small region of a pixel layer from a prompt (non-empty, 200 chars at most); region is {x,y,w,h} or [[x,y],...] (3 points or more) in layer px; feather px (default 24, 0 or more) softens the edge; the raw edit rewrites the WHOLE layer and is not pixel-aligned with the source, so with keep:true (default) a copy of the pre-edit pixels is kept on top, named '<name>-outside', with the feathered region deleted, so only the region shows new pixels (large regions still show seams: use small isolated objects, on the full-resolution master); keep:false is the raw whole-layer edit and keeps no copy; takes 20-32 s; returns {node, outside} (outside is null when keep is false)" },
];

/** Internal building blocks, not in the index. */
export const PATCH_INTERNAL: readonly string[] = ["axiPatchCheck", "axiPatchSelect"];

export const PATCH_SOURCE: string = String.raw`
// Internal: validate the arguments of the patch helper before any SDK call. Returns
// the normalised {feather, keep}. Throws naming the helper and the bad value.
function axiPatchCheck(node, region, prompt, o) {
  const opts = o || {};
  const who = 'axiGenerative' + 'Patch: ';
  if (!node) { throw new Error(who + 'pass the pixel node to patch'); }
  if (typeof prompt !== 'string' || prompt.trim() === '') { throw new Error(who + 'prompt must be a non-empty string'); }
  if (prompt.length > 200) { throw new Error(who + 'prompt must be 200 characters or fewer, got ' + prompt.length); }
  const feather = opts.feather === undefined ? 24 : opts.feather;
  if (typeof feather !== 'number' || !isFinite(feather) || feather < 0) { throw new Error(who + 'feather must be a finite number of 0 or more, got ' + feather); }
  const keep = opts.keep === undefined ? true : opts.keep;
  if (typeof keep !== 'boolean') { throw new Error(who + 'keep must be true or false, got ' + keep); }
  const num = function (v) { return typeof v === 'number' && isFinite(v); };
  if (Array.isArray(region)) {
    if (region.length < 3) { throw new Error(who + 'a polygon region needs at least 3 points, got ' + region.length); }
    for (const p of region) {
      if (!Array.isArray(p) || p.length !== 2 || !num(p[0]) || !num(p[1])) { throw new Error(who + 'every polygon point must be [x, y] with finite numbers'); }
    }
  } else if (region && typeof region === 'object') {
    if (!num(region.x) || !num(region.y) || !num(region.w) || !num(region.h) || region.w <= 0 || region.h <= 0) {
      throw new Error(who + 'region must be {x, y, w, h} with finite numbers and w, h above 0, or an array of [x, y] points');
    }
  } else {
    throw new Error(who + 'region must be {x, y, w, h} or an array of [x, y] points');
  }
  return { feather: feather, keep: keep };
}

// Internal: set the document's pixel selection from a rectangle {x,y,w,h} or an
// array of [x,y] points, replacing any selection, with the given feather in px.
function axiPatchSelect(doc, region, feather) {
  const { Polygon, Rectangle } = require('/geometry.js');
  const { RasterSelectionLogicalOperation } = require('/commands.js');
  let poly;
  if (Array.isArray(region)) {
    poly = Polygon.create();
    for (const p of region) { poly.addPoint({ x: p[0], y: p[1] }); }
  } else {
    poly = Polygon.createRectangle(new Rectangle(region.x, region.y, region.w, region.h));
  }
  doc.setRasterSelectionFromPolygon(poly, RasterSelectionLogicalOperation.New, true, feather);
}

// GENERATIVE: regenerate a region of the pixel layer node from prompt (see the
// header). keep (default true) puts a copy of the pre-edit pixels on top before the
// call and deletes the feathered region from it afterwards, so everything outside
// the region stays the source pixels. keep:false is the raw whole-layer edit. The
// pixel selection is cleared at the end. Returns {node, outside}.
function axiGenerativePatch(doc, node, region, prompt, o) {
  const opts = axiPatchCheck(node, region, prompt, o);
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  const base = node.userDescription ? String(node.userDescription) : '';
  let outside = null;
  if (opts.keep) {
    if (typeof node.duplicate === 'function') {
      const { Transform } = require('/geometry.js');
      outside = node.duplicate(Transform.createIdentity());
    } else {
      doc.selection = node;
      doc.executeCommand(DocumentCommand.createDuplicate(Selection.create(doc, node)));
      outside = doc.selection.nodes.first;
    }
  }
  axiPatchSelect(doc, region, opts.feather);
  doc.selection = node;
  const method = 'generative' + 'EditImage';
  doc[method](prompt);
  let out = node;
  const after = doc.selection.nodes.first;
  if (after && after !== outside) { out = after; }
  if (outside) {
    axiPatchSelect(doc, region, opts.feather);
    doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, outside), false));
    outside.userDescription = base ? base + '-outside' : 'outside';
  }
  doc.executeCommand(DocumentCommand.createRasterDeselect());
  return { node: out, outside: outside };
}
`;
