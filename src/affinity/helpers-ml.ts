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
// Guards: axiRemoveBackground and axiColourise read the layer back before (and for
// removal after) the ML call through axiPixelStats, using NodeRenderingEngine /
// RasterFormat (/rasterobject.js) and PixelReaderRGBA8 (/pixelaccessor.js). A failed
// readback skips the guard: it never fails the ML call.
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
  { name: "axiRemoveBackground", signature: "axiRemoveBackground(doc, node?, {allowEmpty})", summary: "ML background removal on node (or the selection; image nodes are rasterised first), in place; returns the resulting node; throws 'nothing was removed (no subject found)' when the clear-pixel share did not grow (a texture, a flat photo), unless {allowEmpty: true} keeps the photo as it is" },
  { name: "axiSelectSubject", signature: "axiSelectSubject(doc, node?, {allowEmpty})", summary: "ML subject selection on node (or the selection); the result is the document's pixel selection, not the node, which is returned unchanged; throws 'axiSelectSubject: no subject found' when nothing was selected (allowEmpty: true returns null instead); clear it with axiDeselect" },
  { name: "axiDeselect", signature: "axiDeselect(doc)", summary: "clear the document's pixel selection (what axiSelectSubject sets); returns doc" },
  { name: "axiCutout", signature: "axiCutout(doc, node?, {method,transparent,align,padding,box,artboard})", summary: "cut the subject out of a photo, in place: method 'background' (default, ML background removal) or 'subject' (select subject, delete the rest, clear the selection); align 'none' (default, the subject stays where it was in the photo), 'centre' (centre the cut-out in its target box) or 'fit' (also scale it uniformly to fit the box minus padding px, up or down); the target box is box {x,y,w,h} if given, else the picture frame the layer sits in, else where the photo was before the cut; unless transparent:false it also makes the document background transparent so a PNG export keeps alpha; artboard {name, padding = 0} adds an artboard named name around the cut-out (its content box grown by padding px, clamped to the document) so export --artboard <name> gives a tight PNG; when the document has no artboard yet the layer is first moved by (-x,-y), because the first artboard must sit at 0,0; with artboard the return value is {node, artboard: {name,x,y,w,h}} instead of the bare node; otherwise returns the pixel node; a cut that removes nothing throws (method background: 'nothing was removed'; subject: 'no subject found'), allowEmpty: true leaves the photo as it is and still makes the background transparent" },
  { name: "axiContentBox", signature: "axiContentBox(doc, node)", summary: "the visible content box {x,y,w,h} of a layer in document px (its box through its transform); after a cut-out this is the subject, not the original photo" },
  { name: "axiAlignIn", signature: "axiAlignIn(doc, node, box?, {align,padding})", summary: "move a pixel layer so its content box is centred in box {x,y,w,h} (default: the picture frame it sits in; throws when there is none); align 'centre' (default) or 'fit' (also scale uniformly to fit box minus padding px, up or down) or 'none' (does nothing); padding px, 0 or more; returns the node" },
  { name: "axiDetectDepth", signature: "axiDetectDepth(doc, node?, {inPlace,visible})", summary: "ML depth map (near = white) on node (or the selection); keeps the photo: runs on a copy named '<name>-depth' that is hidden unless visible:true, and returns that copy; inPlace:true overwrites the layer with the map and returns it (old behaviour)" },
  { name: "axiDepthBlur", signature: "axiDepthBlur(doc, photo, depth?, {radius})", summary: "blur the far part of photo, driven by its depth map (depth omitted: axiDetectDepth makes the hidden '<name>-depth' copy first; a supplied depth node is left as is); DESTRUCTIVE on the photo layer pixels (a Gaussian blur filter applied inside the inverted depth selection, soft falloff; duplicate the photo first to keep the original); radius defaults to 14 and must be a positive finite number; clears the pixel selection; returns {photo, depth}" },
  { name: "axiColourise", signature: "axiColourise(doc, node?, {force})", summary: "ML colourise of a greyscale node (or the selection); returns the resulting node; throws when the layer is already in colour (mean saturation above 0.05, measured from its pixels) unless {force: true}" },
];

/** Internal building blocks, not in the index. */
export const ML_INTERNAL: readonly string[] = ["axiPick", "axiPixelStats"];

export const ML_SOURCE: string = String.raw`
// Internal: select node (when given), else keep the current selection; throws
// if empty. An image node is rasterised first: the ML commands do nothing on one.
// A CMYK document (doc.format against the CMYK members of RasterFormat, else a CMYK
// match on String(doc.format)) is refused first: ML silently removes nothing there.
function axiPick(doc, node, who) {
  let cmyk = false;
  try {
    const f = doc.format;
    if (f !== undefined && f !== null) {
      const { RasterFormat } = require('/rasterobject.js');
      const names = ['CMYK8', 'CMYKA8', 'CMYK16', 'CMYKA16'];
      for (const k of Object.keys(RasterFormat || {})) { if (k.indexOf('CMYK') >= 0 && names.indexOf(k) < 0) { names.push(k); } }
      for (const k of names) { if (RasterFormat && RasterFormat[k] !== undefined && f === RasterFormat[k]) { cmyk = true; } }
      if (!cmyk && String(f).indexOf('CMYK') >= 0) { cmyk = true; }
    }
  } catch (e) { cmyk = false; }
  if (cmyk) { throw new Error(who + ': ML needs an RGB document; run ML before converting to CMYK (print --cmyk converts at the end)'); }
  if (node) { doc.selection = node; }
  if (!doc.selection.nodes.first) { throw new Error(who + ': nothing selected; pass a node'); }
  if (doc.selection.nodes.first.isImageNode) { doc.rasteriseObjects(); }
}

// Internal: read the layer's rendered bitmap on a 32x32 grid. Returns {w, h, clear,
// sat}: clear is the share of samples with alpha below 128, sat the mean
// (max-min)/max over the samples with alpha 128 or more (0 when there are none).
// The reader is disposed in finally. Throws when the readback fails.
function axiPixelStats(node) {
  let reader = null;
  try {
    const { NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
    const { PixelReaderRGBA8 } = require('/pixelaccessor.js');
    const bitmap = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8).createCompatibleBitmap(true);
    reader = PixelReaderRGBA8.create(bitmap);
    const w = bitmap.width;
    const h = bitmap.height;
    const n = 32;
    const at = function (k, span) { return Math.min(span - 1, Math.floor((k + 0.5) * span / n)); };
    let clear = 0;
    let opaque = 0;
    let satSum = 0;
    for (let gy = 0; gy < n; gy += 1) {
      for (let gx = 0; gx < n; gx += 1) {
        const p = reader.readPixel(at(gx, w), at(gy, h));
        if (p.alpha < 128) { clear += 1; continue; }
        opaque += 1;
        const hi = Math.max(p.r, p.g, p.b);
        const lo = Math.min(p.r, p.g, p.b);
        if (hi > 0) { satSum += (hi - lo) / hi; }
      }
    }
    return { w: w, h: h, clear: clear / (n * n), sat: opaque > 0 ? satSum / opaque : 0 };
  } catch (e) {
    throw new Error('axiPixelStats: pixel readback failed [' + String(e && e.message ? e.message : e) + ']');
  } finally {
    if (reader) { reader.dispose(); }
  }
}

// ML background removal (on-device, not generative). Edits the pixel layer in place.
// The SDK gives no result, and a photo with no subject (a texture) is left intact, so
// the clear-pixel share is read before and after (axiPixelStats): when it did not
// grow, nothing was removed and this throws, unless o.allowEmpty, which keeps the
// photo as it is. A failed readback skips the check. An image node has been
// rasterised by then.
function axiRemoveBackground(doc, node, o) {
  const opts = o || {};
  axiPick(doc, node, 'axiRemoveBackground');
  let before = null;
  if (!opts.allowEmpty) {
    try { before = axiPixelStats(doc.selection.nodes.first); } catch (e) { before = null; }
  }
  doc.removeBackground();
  const out = doc.selection.nodes.first;
  if (before) {
    let after = null;
    try { after = axiPixelStats(out); } catch (e) { after = null; }
    if (after && !(after.clear > before.clear)) {
      throw new Error('axiRemoveBackground: nothing was removed (no subject found); pass {allowEmpty: true} to keep the photo as it is');
    }
  }
  return out;
}

// ML subject selection (on-device, not generative). The result is the document's
// pixel selection, not the node; the node is returned unchanged. Throws when
// nothing was selected, or returns null when o.allowEmpty. Clear the selection with
// axiDeselect.
function axiSelectSubject(doc, node, o) {
  const opts = o || {};
  axiPick(doc, node, 'axiSelectSubject');
  doc.selectSubject();
  if (doc.rasterSelection.isSelectNone) {
    if (opts.allowEmpty) { return null; }
    throw new Error('axiSelectSubject: no subject found');
  }
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
// A cut that removes nothing throws (axiRemoveBackground / axiSelectSubject) unless
// o.allowEmpty, which leaves the photo as it is.
// o.align: 'none' (default; the subject stays where it was), 'centre' or 'fit'
// (axiAlignIn). Target box: o.box, else the picture frame the layer sits in, else
// the layer's box measured before the ML call. o.padding (px) applies to 'fit'.
// Unless o.transparent === false the document background is made transparent
// (axiTransparent), so a PNG export keeps the alpha. Returns the pixel node.
// o.artboard {name, padding = 0}: after the cut, adds an artboard (axiArtboard) over
// the cut-out's content box grown by padding px and clamped to the document, so
// export --artboard <name> is a tight PNG. The first artboard must sit at 0,0, so
// when the document has none the layer is first moved by (-x,-y). With o.artboard
// the return value is {node, artboard: {name,x,y,w,h}}.
function axiCutout(doc, node, o) {
  const opts = o || {};
  const method = opts.method === undefined ? 'background' : opts.method;
  if (method !== 'background' && method !== 'subject') { throw new Error('axiCutout: method must be background or subject, got ' + method); }
  const align = opts.align === undefined ? 'none' : opts.align;
  if (align !== 'none' && align !== 'centre' && align !== 'fit') { throw new Error('axiCutout: align must be none, centre or fit, got ' + align); }
  const padding = opts.padding === undefined ? 0 : opts.padding;
  if (typeof padding !== 'number' || !isFinite(padding) || padding < 0) { throw new Error('axiCutout: padding must be a finite number of 0 or more'); }
  let ab = null;
  if (opts.artboard !== undefined) {
    const a = opts.artboard;
    if (!a || typeof a !== 'object' || typeof a.name !== 'string' || a.name === '') { throw new Error('axiCutout: artboard needs a name, artboard: {name, padding}'); }
    const ap = a.padding === undefined ? 0 : a.padding;
    if (typeof ap !== 'number' || !isFinite(ap) || ap < 0) { throw new Error('axiCutout: artboard.padding must be a finite number of 0 or more'); }
    if (doc.artboards && doc.artboards.some(function (x) { return x.description === a.name; })) { throw new Error('axiCutout: an artboard named ' + a.name + ' already exists'); }
    ab = { name: a.name, padding: ap };
  }
  let start = node;
  let before;
  if (align !== 'none') {
    axiPick(doc, start, 'axiCutout');
    before = axiNodeBox(doc.selection.nodes.first);
    start = undefined;
  }
  if (method === 'background') {
    axiPick(doc, start, 'axiCutout');
    axiRemoveBackground(doc, undefined, { allowEmpty: opts.allowEmpty });
  } else {
    const { DocumentCommand } = require('/commands.js');
    if (axiSelectSubject(doc, start, { allowEmpty: opts.allowEmpty })) {
      doc.executeCommand(DocumentCommand.createRasterInvertSelection());
      doc.executeCommand(DocumentCommand.createDeleteSelection(doc.selection, false));
      axiDeselect(doc);
    }
  }
  if (align !== 'none') {
    const n = doc.selection.nodes.first;
    const framed = !!(n.parent && n.parent.pictureFrameEnabled);
    axiAlignIn(doc, n, opts.box || (framed ? undefined : before), { align: align, padding: padding });
  }
  if (opts.transparent !== false) { axiTransparent(doc, true); }
  if (!ab) { return doc.selection.nodes.first; }
  const out = doc.selection.nodes.first;
  const c = axiContentBox(doc, out);
  const x0 = Math.max(0, c.x - ab.padding);
  const y0 = Math.max(0, c.y - ab.padding);
  let x1 = c.x + c.w + ab.padding;
  let y1 = c.y + c.h + ab.padding;
  if (typeof doc.widthPixels === 'number' && isFinite(doc.widthPixels)) { x1 = Math.min(doc.widthPixels, x1); }
  if (typeof doc.heightPixels === 'number' && isFinite(doc.heightPixels)) { y1 = Math.min(doc.heightPixels, y1); }
  if (!(x1 - x0 > 0 && y1 - y0 > 0)) { throw new Error('axiCutout: artboard: the cut-out has no visible content inside the document'); }
  const box = { name: ab.name, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  if (doc.artboards.length === 0 && (box.x !== 0 || box.y !== 0)) {
    const { Transform } = require('/geometry.js');
    doc.selection = out;
    doc.applyTransform(Transform.createTranslate(-box.x, -box.y));
    box.x = 0;
    box.y = 0;
  }
  axiArtboard(doc, box);
  doc.selection = out;
  return { node: out, artboard: box };
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

// ML colourise of a greyscale image (on-device, not generative). The SDK recolours a
// colour photo into a different picture, so a layer whose mean saturation is above
// 0.05 (greyscale measures 0, a colour photo 0.15 or more) is refused unless
// o.force. A failed readback skips the check.
function axiColourise(doc, node, o) {
  const opts = o || {};
  axiPick(doc, node, 'axiColourise');
  if (!opts.force) {
    let stats = null;
    try { stats = axiPixelStats(doc.selection.nodes.first); } catch (e) { stats = null; }
    if (stats && stats.sat > 0.05) {
      throw new Error('axiColourise: the layer is already in colour (mean saturation ' + stats.sat.toFixed(2) + '; greyscale is 0.05 or less); pass {force: true} to colourise it anyway');
    }
  }
  doc.colourise();
  return doc.selection.nodes.first;
}
`;
