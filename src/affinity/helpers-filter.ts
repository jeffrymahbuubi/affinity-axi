// Live filters, auto corrections and raster selections for run --with-helpers.
// Same rules as helpers-core.ts: function declarations only, prefixed axi, every
// require() inside a function, no document-closing call, no generative API. The
// block is String.raw: keep backticks, ${ and backslashes out of it.
//
// SDK classes used: <Kind>FilterParameters and <Kind>FilterRasterNodeDefinition
// (Denoise, Clarity, UnsharpMask, Vignette) added with AddChildNodesCommandBuilder
// at InsertionMode.Inside_AtFront like the adjustments in axiGrade;
// DocumentCommand.createRasterAuto* (WhiteBalance, Levels, Contrast, Colours);
// Document.setRasterSelectionFromPolygon with Polygon.createRectangle (rectangles)
// or Polygon.create + addPoint (point lists) and RasterSelectionLogicalOperation.

import type { HelperInfo } from "./helpers-core.js";

export const FILTER_INDEX: readonly HelperInfo[] = [
  { name: "axiFilter", signature: "axiFilter(doc, node, kind, params?)", summary: "add a live (non-destructive) filter as a child of an image or pixel layer, or of the picture inside a frame; kind denoise {luminance,luminanceDetail,luminanceContribution,colours,coloursContribution 0..1} | clarity {strength -1..1} | sharpen (unsharp mask) {radius 0..1024, factor 0..4, threshold 0..1} | vignette {exposure -4..4, hardness 0..1, scale 0.25..4, shape 0..1}; params omitted or true gives the defaults (denoise luminance 0.25, luminanceDetail 0.6, colours 0.4; clarity 0.2; sharpen 1.5, 0.6, 0.02; vignette -0.5, 0.5, 1, 0.5), an object sets only the keys it names (the rest stay at Affinity's own defaults); an unknown key or out-of-range value throws naming the allowed keys and range before any edit; returns the target node" },
  { name: "axiAuto", signature: "axiAuto(doc, node, kinds?)", summary: "auto corrections on a pixel layer, applied in the given order: whiteBalance | levels | contrast | colours (default ['whiteBalance','levels']); DESTRUCTIVE on the layer's pixels (keep an untouched copy, e.g. a hidden original layer); returns the target node" },
  { name: "axiSelectRect", signature: "axiSelectRect(doc, {x,y,w,h}, {feather, op})", summary: "raster (pixel) selection from a rectangle in document px; feather px >= 0 (default 0); op new (default) | add | subtract | intersect against the current pixel selection; clear it with axiDeselect; returns doc" },
  { name: "axiSelectPolygon", signature: "axiSelectPolygon(doc, points, {feather, op})", summary: "raster (pixel) selection from a polygon, points [[x,y],...] (at least 3, document px); feather and op as axiSelectRect; clear it with axiDeselect; returns doc" },
];

/** Internal building blocks, not in the index. */
export const FILTER_INTERNAL: readonly string[] = ["axiFilterSpec", "axiFilterParams", "axiFilterTarget", "axiSelectOp", "axiSelectApply"];

export const FILTER_SOURCE: string = String.raw`
// Internal: the filter table. kinds map to the SDK class prefix, the allowed keys
// with their ranges, and the defaults.
function axiFilterSpec() {
  return {
    denoise: { sdk: 'Denoise', keys: { luminance: [0, 1], luminanceDetail: [0, 1], luminanceContribution: [0, 1], colours: [0, 1], coloursContribution: [0, 1] }, dflt: { luminance: 0.25, luminanceDetail: 0.6, colours: 0.4 } },
    clarity: { sdk: 'Clarity', keys: { strength: [-1, 1] }, dflt: { strength: 0.2 } },
    sharpen: { sdk: 'UnsharpMask', keys: { radius: [0, 1024], factor: [0, 4], threshold: [0, 1] }, dflt: { radius: 1.5, factor: 0.6, threshold: 0.02 } },
    vignette: { sdk: 'Vignette', keys: { exposure: [-4, 4], hardness: [0, 1], scale: [0.25, 4], shape: [0, 1] }, dflt: { exposure: -0.5, hardness: 0.5, scale: 1, shape: 0.5 } },
  };
}

// Internal: validate kind and params into a plain {key: value} object. params
// undefined, true, null or {} gives the defaults. Throws on an unknown kind or key
// and on a value outside its range, naming what is allowed. No SDK call.
function axiFilterParams(kind, params) {
  const table = axiFilterSpec();
  if (!table[kind]) { throw new Error('axiFilter: unknown kind ' + kind + '; known: ' + Object.keys(table).join(', ')); }
  const t = table[kind];
  if (params === undefined || params === null || params === true) { return Object.assign({}, t.dflt); }
  if (typeof params !== 'object' || Array.isArray(params)) { throw new Error('axiFilter: ' + kind + ' params must be true or an object with keys ' + Object.keys(t.keys).join(', ')); }
  const keys = Object.keys(params);
  if (keys.length === 0) { return Object.assign({}, t.dflt); }
  const out = {};
  keys.forEach(function (k) {
    if (!t.keys[k]) { throw new Error('axiFilter: ' + kind + ' has no key ' + k + '; allowed: ' + Object.keys(t.keys).map(function (a) { return a + ' ' + t.keys[a][0] + '..' + t.keys[a][1]; }).join(', ')); }
    const v = params[k];
    const r = t.keys[k];
    if (typeof v !== 'number' || !isFinite(v) || v < r[0] || v > r[1]) { throw new Error('axiFilter: ' + kind + '.' + k + ' must be a number in ' + r[0] + '..' + r[1] + ', got ' + v); }
    out[k] = v;
  });
  return out;
}

// Internal: the image or pixel layer to edit: node itself, or the picture inside a frame.
function axiFilterTarget(who, doc, node) {
  const n = node || doc.selection.nodes.first;
  if (!n) { throw new Error(who + ': nothing selected; pass a node'); }
  if (n.isImageNode || n.isRasterNode) { return n; }
  for (const c of n.children) { if (c.isImageNode || c.isRasterNode) { return c; } }
  throw new Error(who + ': node is not an image or pixel layer and holds none');
}

// Add one live filter as a child of the image or pixel layer (in front of its
// other children). kind: denoise | clarity | sharpen (unsharp mask) | vignette.
// params: true or omitted for the defaults, or an object naming only the keys to
// set (ranges in the index). Delete the filter child to undo. Returns the target.
function axiFilter(doc, node, kind, params) {
  const p = axiFilterParams(kind, params);
  const target = axiFilterTarget('axiFilter', doc, node);
  const N = require('/nodes.js');
  const { AddChildNodesCommandBuilder, InsertionMode, NodeChildType } = require('/commands.js');
  const sdk = axiFilterSpec()[kind].sdk;
  const P = N[sdk + 'FilterParameters'].create();
  Object.keys(p).forEach(function (k) { P[k] = p[k]; });
  const b = AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(target);
  b.setInsertionMode(InsertionMode.Inside_AtFront);
  b.addNode(N[sdk + 'FilterRasterNodeDefinition'].create(P));
  doc.executeCommand(b.createCommand(false, NodeChildType.Main));
  doc.selection = target;
  return target;
}

// Auto corrections on a pixel layer, in the order given (default white balance,
// then levels). These rewrite the layer's pixels: keep an untouched copy.
// kinds: whiteBalance | levels | contrast | colours. Returns the target.
function axiAuto(doc, node, kinds) {
  const map = { whiteBalance: 'createRasterAutoWhiteBalance', levels: 'createRasterAutoLevels', contrast: 'createRasterAutoContrast', colours: 'createRasterAutoColours' };
  const list = kinds === undefined || kinds === null ? ['whiteBalance', 'levels'] : kinds;
  if (!Array.isArray(list) || list.length === 0) { throw new Error('axiAuto: kinds must be a non-empty array of ' + Object.keys(map).join(', ')); }
  list.forEach(function (k) {
    if (!map[k]) { throw new Error('axiAuto: unknown kind ' + k + '; known: ' + Object.keys(map).join(', ')); }
  });
  const target = axiFilterTarget('axiAuto', doc, node);
  if (!target.isRasterNode) { throw new Error('axiAuto: needs a pixel layer; axiImage rasterises by default'); }
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  list.forEach(function (k) {
    doc.executeCommand(DocumentCommand[map[k]](Selection.create(doc, target)));
  });
  doc.selection = target;
  return target;
}

// Internal: validate {feather, op} and return {feather, op (SDK member)}.
function axiSelectOp(who, o) {
  const opts = o || {};
  const feather = opts.feather === undefined ? 0 : opts.feather;
  if (typeof feather !== 'number' || !isFinite(feather) || feather < 0) { throw new Error(who + ': feather must be a number >= 0 (px), got ' + feather); }
  const ops = { new: 'New', add: 'Add', subtract: 'Subtract', intersect: 'Intersect' };
  const op = opts.op === undefined ? 'new' : opts.op;
  if (!ops[op]) { throw new Error(who + ': op must be one of ' + Object.keys(ops).join(', ') + ', got ' + op); }
  return { feather: feather, op: ops[op] };
}

// Internal: apply a polygon as the pixel selection.
function axiSelectApply(doc, poly, sel) {
  const { RasterSelectionLogicalOperation } = require('/commands.js');
  doc.setRasterSelectionFromPolygon(poly, RasterSelectionLogicalOperation[sel.op], true, sel.feather);
  return doc;
}

// Pixel selection from a rectangle {x,y,w,h} in document px. feather px >= 0;
// op new (default) | add | subtract | intersect. Returns doc.
function axiSelectRect(doc, r, o) {
  if (!r || ![r.x, r.y, r.w, r.h].every(function (v) { return typeof v === 'number' && isFinite(v); }) || !(r.w > 0 && r.h > 0)) { throw new Error('axiSelectRect: needs {x, y, w, h} numbers with w and h > 0'); }
  const sel = axiSelectOp('axiSelectRect', o);
  const { Polygon, Rectangle } = require('/geometry.js');
  return axiSelectApply(doc, Polygon.createRectangle(new Rectangle(r.x, r.y, r.w, r.h)), sel);
}

// Pixel selection from a polygon, points [[x,y],...] (at least 3) in document px.
// feather and op as axiSelectRect. Returns doc.
function axiSelectPolygon(doc, points, o) {
  if (!Array.isArray(points) || points.length < 3) { throw new Error('axiSelectPolygon: points must be an array of at least 3 [x, y] pairs'); }
  points.forEach(function (p, i) {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !isFinite(p[0]) || !isFinite(p[1])) { throw new Error('axiSelectPolygon: points[' + i + '] must be [x, y] numbers'); }
  });
  const sel = axiSelectOp('axiSelectPolygon', o);
  const { Polygon } = require('/geometry.js');
  const poly = Polygon.create();
  points.forEach(function (p) { poly.addPoint({ x: p[0], y: p[1] }); });
  return axiSelectApply(doc, poly, sel);
}
`;
