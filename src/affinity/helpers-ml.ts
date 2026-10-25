// ML helpers for run --with-helpers: background removal, subject selection and
// cut-outs, depth maps, colourise. Same rules as helpers-core.ts: function
// declarations only, prefixed axi, every require() inside a function, no
// document-closing call, no generative API. The block is String.raw: keep
// backticks, ${ and backslashes out of it.
//
// All ML commands run on-device (not generative) and act on pixel layers only,
// so axiPick rasterises an image node first. axiCutout leans on axiTransparent
// (helpers-core.ts) to make the document background transparent.
//
// SDK used: Document.removeBackground / selectSubject / detectDepth / colourise,
// Document.rasterSelection.isSelectNone, DocumentCommand.createRasterDeselect,
// createRasterInvertSelection, createDeleteSelection, createSetVisibility,
// Node.duplicate (fallback DocumentCommand.createDuplicate). Re-centring a cut-out
// adds Document.applyTransform with Transform.createTranslate/createScale (the
// measured box is axiNodeBox from helpers-named.ts). Depth blur adds
// Document.setRasterSelectionFromObject (useIntensity), RasterSelectionLogicalOperation.New,
// DocumentCommand.createGaussianBlurFilter and GaussianBlurFilterParameters. The
// depth-of-field filter is geometric and takes no depth map, so it is not used.

import type { HelperInfo } from "./helpers-core.js";

export const ML_INDEX: readonly HelperInfo[] = [
  { name: "axiRemoveBackground", signature: "axiRemoveBackground(doc, node?)", summary: "ML background removal on node (or the selection; image nodes are rasterised first), in place; returns the resulting node" },
  { name: "axiSelectSubject", signature: "axiSelectSubject(doc, node?)", summary: "ML subject selection on node (or the selection); the result is the document's pixel selection, not the node, which is returned unchanged; throws 'axiSelectSubject: no subject found' when nothing was selected; clear it with axiDeselect" },
  { name: "axiDeselect", signature: "axiDeselect(doc)", summary: "clear the document's pixel selection (what axiSelectSubject sets); returns doc" },
  { name: "axiCutout", signature: "axiCutout(doc, node?, {method,transparent,align,padding,box})", summary: "cut the subject out of a photo, in place: method 'background' (default, ML background removal) or 'subject' (select subject, delete the rest, clear the selection); align 'none' (default, the subject stays where it was in the photo), 'centre' (centre the cut-out in its target box) or 'fit' (also scale it uniformly to fit the box minus padding px, up or down); the target box is box {x,y,w,h} if given, else the picture frame the layer sits in, else where the photo was before the cut; unless transparent:false it also makes the document background transparent so a PNG export keeps alpha; returns the pixel node" },
  { name: "axiContentBox", signature: "axiContentBox(doc, node)", summary: "the visible content box {x,y,w,h} of a layer in document px (its box through its transform); after a cut-out this is the subject, not the original photo" },
  { name: "axiAlignIn", signature: "axiAlignIn(doc, node, box?, {align,padding})", summary: "move a pixel layer so its content box is centred in box {x,y,w,h} (default: the picture frame it sits in; throws when there is none); align 'centre' (default) or 'fit' (also scale uniformly to fit box minus padding px, up or down) or 'none' (does nothing); padding px, 0 or more; returns the node" },
  { name: "axiDetectDepth", signature: "axiDetectDepth(doc, node?, {inPlace,visible})", summary: "ML depth map (near = white) on node (or the selection); keeps the photo: runs on a copy named '<name>-depth' that is hidden unless visible:true, and returns that copy; inPlace:true overwrites the layer with the map and returns it (old behaviour)" },
  { name: "axiDepthBlur", signature: "axiDepthBlur(doc, photo, depth?, {radius})", summary: "blur the far part of photo, driven by its depth map (depth omitted: axiDetectDepth makes the hidden '<name>-depth' copy first; a supplied depth node is left as is); DESTRUCTIVE on the photo layer pixels (a Gaussian blur filter applied inside the inverted depth selection, soft falloff; duplicate the photo first to keep the original); radius defaults to 14 and must be a positive finite number; clears the pixel selection; returns {photo, depth}" },
  { name: "axiColourise", signature: "axiColourise(doc, node?)", summary: "ML colourise of a greyscale node (or the selection); returns the resulting node" },
];

/** Internal building blocks, not in the index. */
export const ML_INTERNAL: readonly string[] = ["axiPick"];

export const ML_SOURCE: string = String.raw`
// Internal: select node (when given), else keep the current selection; throws
// if empty. An image node is rasterised first: the ML commands do nothing on one.
function axiPick(doc, node, who) {
  if (node) { doc.selection = node; }
  if (!doc.selection.nodes.first) { throw new Error(who + ': nothing selected; pass a node'); }
  if (doc.selection.nodes.first.isImageNode) { doc.rasteriseObjects(); }
}

// ML background removal (on-device, not generative). Edits the pixel layer in place.
function axiRemoveBackground(doc, node) {
  axiPick(doc, node, 'axiRemoveBackground');
  doc.removeBackground();
  return doc.selection.nodes.first;
}

// ML subject selection (on-device, not generative). The result is the document's
// pixel selection, not the node; the node is returned unchanged. Throws when
// nothing was selected. Clear the selection with axiDeselect.
function axiSelectSubject(doc, node) {
  axiPick(doc, node, 'axiSelectSubject');
  doc.selectSubject();
  if (doc.rasterSelection.isSelectNone) { throw new Error('axiSelectSubject: no subject found'); }
  return doc.selection.nodes.first;
}

// Clear the document's pixel selection. Returns doc.
function axiDeselect(doc) {
  const { DocumentCommand } = require('/commands.js');
  doc.executeCommand(DocumentCommand.createRasterDeselect());
  return doc;
}

// Cut the subject out of the photo node (or the selection), in place.
// o.method: 'background' (default) runs ML background removal; 'subject' selects
// the subject, inverts the pixel selection, deletes it and clears the selection.
// o.align: 'none' (default; the subject stays where it was), 'centre' or 'fit'
// (axiAlignIn). Target box: o.box, else the picture frame the layer sits in, else
// the layer's box measured before the ML call. o.padding (px) applies to 'fit'.
// Unless o.transparent === false the document background is made transparent
// (axiTransparent), so a PNG export keeps the alpha. Returns the pixel node.
function axiCutout(doc, node, o) {
  const opts = o || {};
  const method = opts.method === undefined ? 'background' : opts.method;
  if (method !== 'background' && method !== 'subject') { throw new Error('axiCutout: method must be background or subject, got ' + method); }
  const align = opts.align === undefined ? 'none' : opts.align;
  if (align !== 'none' && align !== 'centre' && align !== 'fit') { throw new Error('axiCutout: align must be none, centre or fit, got ' + align); }
  const padding = opts.padding === undefined ? 0 : opts.padding;
  if (typeof padding !== 'number' || !isFinite(padding) || padding < 0) { throw new Error('axiCutout: padding must be a finite number of 0 or more'); }
  let start = node;
  let before;
  if (align !== 'none') {
    axiPick(doc, start, 'axiCutout');
    before = axiNodeBox(doc.selection.nodes.first);
    start = undefined;
  }
  if (method === 'background') {
    axiPick(doc, start, 'axiCutout');
    doc.removeBackground();
  } else {
    const { DocumentCommand } = require('/commands.js');
    axiSelectSubject(doc, start);
    doc.executeCommand(DocumentCommand.createRasterInvertSelection());
    doc.executeCommand(DocumentCommand.createDeleteSelection(doc.selection, false));
    axiDeselect(doc);
  }
  if (align !== 'none') {
    const n = doc.selection.nodes.first;
    const framed = !!(n.parent && n.parent.pictureFrameEnabled);
    axiAlignIn(doc, n, opts.box || (framed ? undefined : before), { align: align, padding: padding });
  }
  if (opts.transparent !== false) { axiTransparent(doc, true); }
  return doc.selection.nodes.first;
}

// The visible content box {x,y,w,h} of a layer in document px: its box through its
// transform (axiNodeBox). After removeBackground or a subject cut this is the
// subject, not the original photo.
function axiContentBox(doc, node) {
  if (!node) { throw new Error('axiContentBox: pass the node'); }
  return axiNodeBox(node);
}

// Move (and for 'fit' scale) a pixel layer so its content box sits centred in box.
// box {x,y,w,h}, or omitted for the picture frame node sits in (throws when it is
// not in one). o.align: 'centre' (default), 'fit' (uniform scale to fit the box
// minus o.padding px on each side, up or down, then centre) or 'none' (returns at
// once). o.padding defaults to 0. Checked before any SDK call. Returns node.
function axiAlignIn(doc, node, box, o) {
  const opts = o || {};
  const align = opts.align === undefined ? 'centre' : opts.align;
  if (align !== 'none' && align !== 'centre' && align !== 'fit') { throw new Error('axiAlignIn: align must be none, centre or fit, got ' + align); }
  const padding = opts.padding === undefined ? 0 : opts.padding;
  if (typeof padding !== 'number' || !isFinite(padding) || padding < 0) { throw new Error('axiAlignIn: padding must be a finite number of 0 or more'); }
  if (align === 'none') { return node; }
  if (!node) { throw new Error('axiAlignIn: pass the node'); }
  let target = box;
  if (!target) {
    if (!(node.parent && node.parent.pictureFrameEnabled)) { throw new Error('axiAlignIn: no box; the layer is not in a picture frame, pass box {x,y,w,h}'); }
    target = axiNodeBox(node.parent);
  }
  ['x', 'y', 'w', 'h'].forEach(function (k) {
    if (!(typeof target[k] === 'number' && isFinite(target[k]))) { throw new Error('axiAlignIn: box.' + k + ' must be a finite number'); }
  });
  if (!(target.w > 0 && target.h > 0)) { throw new Error('axiAlignIn: box w and h must be positive'); }
  const c = axiContentBox(doc, node);
  let k = 1;
  if (align === 'fit') {
    if (!(c.w > 0 && c.h > 0)) { throw new Error('axiAlignIn: the layer has no visible content to fit'); }
    k = Math.min((target.w - 2 * padding) / c.w, (target.h - 2 * padding) / c.h);
    if (!(k > 0) || !isFinite(k)) { throw new Error('axiAlignIn: padding leaves no room'); }
  }
  const { Transform } = require('/geometry.js');
  const xf = Transform.createTranslate(target.x + target.w / 2, target.y + target.h / 2).multiply(Transform.createScale(k, k)).multiply(Transform.createTranslate(-(c.x + c.w / 2), -(c.y + c.h / 2)));
  doc.selection = node;
  doc.applyTransform(xf);
  return node;
}

// ML depth map (on-device, not generative; near = white). By default the photo is
// kept: the map is made on a copy named <name>-depth (or depth), hidden unless
// o.visible, and that copy is returned. o.inPlace overwrites the layer with the
// map and returns it. Image nodes are rasterised first.
function axiDetectDepth(doc, node, o) {
  const opts = o || {};
  axiPick(doc, node, 'axiDetectDepth');
  if (opts.inPlace) {
    doc.detectDepth();
    return doc.selection.nodes.first;
  }
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  const src = doc.selection.nodes.first;
  const base = src.userDescription ? String(src.userDescription) : '';
  let copy;
  if (typeof src.duplicate === 'function') {
    const { Transform } = require('/geometry.js');
    copy = src.duplicate(Transform.createIdentity());
  } else {
    doc.executeCommand(DocumentCommand.createDuplicate(Selection.create(doc, src)));
    copy = doc.selection.nodes.first;
  }
  doc.selection = copy;
  doc.detectDepth();
  copy = doc.selection.nodes.first;
  axiName(copy, base ? base + '-depth' : 'depth');
  if (!opts.visible) { doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, copy), false)); }
  return copy;
}

// Depth-driven background blur (on-device depth, not generative). DESTRUCTIVE on
// the photo layer: the far part is blurred in its pixels. Selects the depth map by
// intensity (near = white), inverts it (far), then runs a Gaussian blur on the
// photo inside that soft selection. depth omitted: made by axiDetectDepth on a
// copy, hidden again once used; a supplied depth node is left as the caller set it.
// o.radius defaults to 14 and is checked before any SDK call. Returns {photo, depth}.
function axiDepthBlur(doc, photo, depth, o) {
  const opts = o || {};
  const radius = opts.radius === undefined ? 14 : opts.radius;
  if (typeof radius !== 'number' || !isFinite(radius) || radius <= 0) { throw new Error('axiDepthBlur: radius must be a positive finite number, got ' + radius); }
  if (!photo) { throw new Error('axiDepthBlur: pass the photo node'); }
  const { DocumentCommand, RasterSelectionLogicalOperation } = require('/commands.js');
  const { GaussianBlurFilterParameters } = require('/nodes.js');
  const { Selection } = require('/selections.js');
  axiPick(doc, photo, 'axiDepthBlur');
  const target = doc.selection.nodes.first;
  const made = !depth;
  const map = depth || axiDetectDepth(doc, target, { visible: true });
  doc.setRasterSelectionFromObject(map, true, RasterSelectionLogicalOperation.New);
  doc.executeCommand(DocumentCommand.createRasterInvertSelection());
  if (made) { doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, map), false)); }
  doc.selection = target;
  const p = GaussianBlurFilterParameters.create();
  p.radius = radius;
  doc.executeCommand(DocumentCommand.createGaussianBlurFilter(doc.selection, p));
  axiDeselect(doc);
  return { photo: target, depth: map };
}

// ML colourise of a greyscale image (on-device, not generative).
function axiColourise(doc, node) {
  axiPick(doc, node, 'axiColourise');
  doc.colourise();
  return doc.selection.nodes.first;
}
`;
