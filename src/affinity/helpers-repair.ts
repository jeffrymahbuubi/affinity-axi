// Local repair and local grading for run --with-helpers. Same rules as helpers-core.ts:
// function declarations only, prefixed axi, every require() inside a function, no
// document-closing call, no generative API. The block is String.raw: keep backticks,
// ${ and backslashes out of it.
//
// Both helpers work on a COPY of the pixel layer put on top of it: the copy is
// edited, then everything outside the wanted region is deleted from the copy, so
// the layer underneath stays the source and the edit shows only inside the region.
// The copy comes from Node.duplicate(Transform.createIdentity()), which keeps pixels
// identical (verified live in batch 10b). The two live filters that axiFilter does
// not expose (DustAndScratch, BilateralBlur) are added with the same insertion
// pattern axiFilter uses: AddChildNodesCommandBuilder, InsertionMode.Inside_AtFront.
//
// SDK used: DocumentCommand.createRasterSelectShadows|Midtones|Highlights|Reds|
// Greens|Blues, createFeatherRasterSelection, createRasterInvertSelection,
// createDeleteSelection, createRasterDeselect; DustAndScratchFilterParameters
// (radius, tolerance) and BilateralBlurFilterParameters (radius, tolerance) with
// their FilterRasterNodeDefinition classes; helpers axiGrade, axiFilter,
// axiSelectPolygon, axiFind from the other helper blocks.

import type { HelperInfo } from "./helpers-core.js";

export const REPAIR_INDEX: readonly HelperInfo[] = [
  { name: "axiRepair", signature: "axiRepair(doc, ref, polygons, {strength, feather, name})", summary: "repair uneven or damaged areas of a pixel layer (ref: node or name, or the picture inside a frame): puts a copy on top, grades it (exposure +0.6, vibrance -0.5, saturation -0.35, a little warmth, each scaled by strength), adds live DustAndScratch (radius 10), BilateralBlur (radius 60, at most 100) and Denoise filters, then deletes everything outside the polygons from the copy so only those areas show the repair; polygons [[[x,y],...], ...] in layer px, at least 1 and at least 3 points each; strength 0.25..2 (default 1) scales the grade and the radii; feather px >= 0 (default 40) softens the edge; name sets the copy's name stem (default the layer's name); returns the copy, named '<name>-repair'" },
  { name: "axiLocalGrade", signature: "axiLocalGrade(doc, ref, zone, spec, {feather, name})", summary: "grade only one tonal or colour zone of a pixel layer (ref: node or name, or the picture inside a frame): zone shadows | midtones | highlights | reds | greens | blues selects that zone of the pixels, feather px >= 0 (default 24) softens it; spec is an axiGrade spec (object or look name) applied to a copy put on top, with everything outside the zone deleted from the copy; returns the copy, named '<name>-local-<zone>'" },
];

/** Internal building blocks, not in the index. */
export const REPAIR_INTERNAL: readonly string[] = ["axiRepairCheck", "axiRepairNode", "axiRepairCopy", "axiRepairFilter", "axiRepairZone"];

export const REPAIR_SOURCE: string = String.raw`
// Internal: validate the arguments of axiRepair before any SDK call. Returns the
// normalised {strength, feather, name}. Throws naming the helper and the bad value.
function axiRepairCheck(polygons, o) {
  const opts = o || {};
  const who = 'axiRepair: ';
  if (!Array.isArray(polygons) || polygons.length < 1) { throw new Error(who + 'polygons must be an array of at least 1 polygon, each an array of [x, y] points'); }
  polygons.forEach(function (poly, i) {
    if (!Array.isArray(poly) || poly.length < 3) { throw new Error(who + 'polygons[' + i + '] needs at least 3 [x, y] points'); }
    poly.forEach(function (p, j) {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number' || !isFinite(p[0]) || !isFinite(p[1])) { throw new Error(who + 'polygons[' + i + '][' + j + '] must be [x, y] with finite numbers'); }
    });
  });
  const strength = opts.strength === undefined ? 1 : opts.strength;
  if (typeof strength !== 'number' || !isFinite(strength) || strength < 0.25 || strength > 2) { throw new Error(who + 'strength must be a number in 0.25..2, got ' + strength); }
  const feather = opts.feather === undefined ? 40 : opts.feather;
  if (typeof feather !== 'number' || !isFinite(feather) || feather < 0) { throw new Error(who + 'feather must be a finite number of 0 or more, got ' + feather); }
  if (opts.name !== undefined && (typeof opts.name !== 'string' || opts.name === '')) { throw new Error(who + 'name must be a non-empty string, got ' + opts.name); }
  return { strength: strength, feather: feather, name: opts.name };
}

// Internal: the pixel layer to edit for ref (a node, or a name resolved with
// axiFind): the node itself or the picture inside a frame. Must be a pixel layer,
// because the copy has pixels deleted from it (axiImage rasterises by default).
function axiRepairNode(who, doc, ref) {
  if (ref === undefined || ref === null) { throw new Error(who + ': pass the pixel layer (a node or a name)'); }
  const node = typeof ref === 'string' ? axiFind(doc, ref) : ref;
  const target = axiFilterTarget(who, doc, node);
  if (!target.isRasterNode) { throw new Error(who + ': needs a pixel layer; axiImage rasterises by default'); }
  return target;
}

// Internal: a copy of the target pixels put on top, pixel-identical (identity
// transform). Falls back to the duplicate command when the node has no duplicate().
function axiRepairCopy(doc, target) {
  if (typeof target.duplicate === 'function') {
    const { Transform } = require('/geometry.js');
    return target.duplicate(Transform.createIdentity());
  }
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  doc.selection = target;
  doc.executeCommand(DocumentCommand.createDuplicate(Selection.create(doc, target)));
  return doc.selection.nodes.first;
}

// Internal: add one live filter the axiFilter table does not cover as a child of
// the pixel layer, in front of its other children. kind: DustAndScratch or
// BilateralBlur, p: {radius, tolerance}.
function axiRepairFilter(doc, target, kind, p) {
  const N = require('/nodes.js');
  const { AddChildNodesCommandBuilder, InsertionMode, NodeChildType } = require('/commands.js');
  const P = N[kind + 'FilterParameters'].create();
  P.radius = p.radius;
  P.tolerance = p.tolerance;
  const b = AddChildNodesCommandBuilder.create();
  b.setInsertionTarget(target);
  b.setInsertionMode(InsertionMode.Inside_AtFront);
  b.addNode(N[kind + 'FilterRasterNodeDefinition'].create(P));
  doc.executeCommand(b.createCommand(false, NodeChildType.Main));
  return target;
}

// Internal: the select command name for a zone, or throws naming the zones.
function axiRepairZone(zone) {
  const zones = { shadows: 'createRasterSelectShadows', midtones: 'createRasterSelectMidtones', highlights: 'createRasterSelectHighlights', reds: 'createRasterSelectReds', greens: 'createRasterSelectGreens', blues: 'createRasterSelectBlues' };
  if (typeof zone !== 'string' || !zones[zone]) { throw new Error('axiLocalGrade: zone must be one of ' + Object.keys(zones).join(', ') + ', got ' + zone); }
  return zones[zone];
}

// Repair uneven or damaged areas: a graded, de-speckled, smoothed and denoised copy
// of the pixel layer on top, kept only inside the polygons (see the header). strength
// 0.25..2 scales the grade and the filter radii. Returns the copy, named
// '<name>-repair'.
function axiRepair(doc, ref, polygons, o) {
  const opts = axiRepairCheck(polygons, o);
  const target = axiRepairNode('axiRepair', doc, ref);
  const s = opts.strength;
  const base = opts.name !== undefined ? opts.name : (target.userDescription ? String(target.userDescription) : 'photo');
  const copy = axiRepairCopy(doc, target);
  axiGrade(doc, copy, { exposure: 0.6 * s, whiteBalance: { temp: 0.05 }, vibrance: -0.5 * s, saturation: -0.35 * s });
  axiRepairFilter(doc, copy, 'DustAndScratch', { radius: Math.max(1, Math.round(10 * s)), tolerance: 0.12 });
  axiRepairFilter(doc, copy, 'BilateralBlur', { radius: Math.min(100, Math.round(60 * s)), tolerance: 0.12 });
  axiFilter(doc, copy, 'denoise', { luminance: 0.6 });
  polygons.forEach(function (poly, i) {
    axiSelectPolygon(doc, poly, { feather: opts.feather, op: i === 0 ? 'new' : 'add' });
  });
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  doc.executeCommand(DocumentCommand.createRasterInvertSelection());
  doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, copy), false));
  doc.executeCommand(DocumentCommand.createRasterDeselect());
  copy.userDescription = base + '-repair';
  doc.selection = copy;
  return copy;
}

// Grade one zone of the pixel layer only: a copy on top, its pixels outside the
// zone deleted, then spec (an axiGrade spec or look name) added to the copy. The zone
// is selected on the copy before the grade, so it follows the source tones. Returns
// the copy, named '<name>-local-<zone>'.
function axiLocalGrade(doc, ref, zone, spec, o) {
  const opts = o || {};
  const select = axiRepairZone(zone);
  const full = typeof spec === 'string' ? axiLook(spec) : spec;
  if (!full || typeof full !== 'object' || Array.isArray(full) || Object.keys(full).length === 0) { throw new Error('axiLocalGrade: spec must be an axiGrade spec object or a look name'); }
  axiGradeSteps(full);
  const feather = opts.feather === undefined ? 24 : opts.feather;
  if (typeof feather !== 'number' || !isFinite(feather) || feather < 0) { throw new Error('axiLocalGrade: feather must be a finite number of 0 or more, got ' + feather); }
  if (opts.name !== undefined && (typeof opts.name !== 'string' || opts.name === '')) { throw new Error('axiLocalGrade: name must be a non-empty string, got ' + opts.name); }
  const target = axiRepairNode('axiLocalGrade', doc, ref);
  const base = opts.name !== undefined ? opts.name : (target.userDescription ? String(target.userDescription) : 'photo');
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  const copy = axiRepairCopy(doc, target);
  doc.selection = copy;
  doc.executeCommand(DocumentCommand[select]());
  if (feather > 0) { doc.executeCommand(DocumentCommand.createFeatherRasterSelection(feather)); }
  doc.executeCommand(DocumentCommand.createRasterInvertSelection());
  doc.executeCommand(DocumentCommand.createDeleteSelection(Selection.create(doc, copy), false));
  doc.executeCommand(DocumentCommand.createRasterDeselect());
  axiGrade(doc, copy, full);
  copy.userDescription = base + '-local-' + zone;
  doc.selection = copy;
  return copy;
}
`;
