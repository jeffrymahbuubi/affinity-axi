// Image and grade helpers for run --with-helpers (the ML helpers are in
// helpers-ml.ts). Same rules as helpers-core.ts: function declarations only,
// prefixed axi, every require() inside a function, no document-closing call, no
// generative API. The block is String.raw: keep backticks, ${ and backslashes out of it.
//
// SDK classes used: ImageNodeDefinition and Bitmap (placement), the picture
// frame flag on ShapeNodeDefinition (clipping), AddChildNodesCommandBuilder with
// InsertionMode.Inside_AtFront (children of a frame or image), the
// *AdjustmentRasterNodeDefinition family (grade), DocumentCommand.createReplaceBitmap.
// ML commands act on pixel layers only, so images are rasterised by default.

import type { HelperInfo } from "./helpers-core.js";

export const IMAGE_INDEX: readonly HelperInfo[] = [
  { name: "axiImage", signature: "axiImage(doc, {path,x,y,w,h,fit,radius,frame,focus,raster,name,rotate,mirror})", summary: "place an image file (under Desktop) as a pixel layer; rotate 0|90|180|270 (degrees clockwise) and mirror:true (horizontal flip, applied first) turn the picture before the fit, for a file whose EXIF orientation Affinity ignores; fit contain (default, inside the box, top-left) | cover (fills w x h, clipped to a picture frame, centred on focus {x,y} 0-1) | stretch; radius px (or frame:true) clips to a rounded picture frame; raster:false keeps an image node; name sets the image node's userDescription (its frame gets name-frame); returns the image node (its parent is the frame)" },
  { name: "axiReplaceImage", signature: "axiReplaceImage(doc, node, path, {fit,raster,name,rotate,mirror})", summary: "swap the picture in node (image, pixel layer or its frame) for another file, same slot: createReplaceBitmap when the pixel size matches, else re-placed with fit cover (default) into the old box and frame, keeping the old node's name unless name is given; rotate/mirror as axiImage (the picture is then always re-placed, never swapped in place); returns the new node" },
  { name: "axiGrade", signature: "axiGrade(doc, node, spec|look)", summary: "non-destructive adjustment stack on an image or pixel layer from a JSON spec; keys whiteBalance{temp,tint} exposure levels{black,white,gamma,outBlack,outWhite} curves brightnessContrast{brightness,contrast} shadowsHighlights{shadows,highlights} vibrance saturation hsl{hue,saturation,luminosity} splitToning{shadowsHue,shadowsSat,highlightsHue,highlightsSat,balance}; spec may be a look name" },
  { name: "axiLook", signature: "axiLook(name)", summary: "grade spec preset: 'warm-soft' (warm, lifted blacks, gentle colour) or 'neutral' (light tone correction only, for Google Business Profile where heavy filters are disallowed)" },
];

/** Internal building blocks, not in the index. */
export const IMAGE_INTERNAL: readonly string[] = ["axiPlace", "axiOrientCheck", "axiCmykGuard", "axiGradeTarget", "axiGradeSteps"];

export const IMAGE_SOURCE: string = String.raw`
// Internal: load path and add it as an image node. target (a frame or other
// parent node) makes it a child, in front; null adds it to the current insertion
// point. box {x,y,w,h} and fit place it: contain (default, top-left aligned),
// cover or stretch. focus {x,y} (0-1) positions the overflow of cover. o.mirror
// (horizontal flip, first) and o.rotate (0, 90, 180, 270 degrees clockwise on screen,
// y down) turn the placed node about its centre before the fit is measured.
// Returns the image node.
function axiPlace(doc, o, box, target) {
  const { ImageNodeDefinition } = require('/nodes.js');
  const { Bitmap, RasterFormat } = require('/rasterobject.js');
  const { Transform } = require('/geometry.js');
  const { AddChildNodesCommandBuilder, InsertionMode, NodeChildType } = require('/commands.js');
  const fit = o.fit || 'contain';
  if (!target) { axiSurface(doc); }
  const def = ImageNodeDefinition.create(RasterFormat.RGBA8);
  def.bitmap = Bitmap.loadFromFile(o.path, RasterFormat.RGBA8);
  if (target) {
    const b = AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(target);
    b.setInsertionMode(InsertionMode.Inside_AtFront);
    b.addNode(def);
    doc.executeCommand(b.createCommand(true, NodeChildType.Main));
  } else {
    doc.addNode(def);
  }
  const node = doc.selection.nodes.first;
  if (o.mirror || o.rotate) {
    const c0 = axiMeasure(doc);
    const cx = c0.x + c0.w / 2;
    const cy = c0.y + c0.h / 2;
    let turn = Transform.createTranslate(cx, cy);
    if (o.rotate) { turn = turn.multiply(Transform.createRotate(o.rotate * Math.PI / 180)); }
    if (o.mirror) { turn = turn.multiply(Transform.createScale(-1, 1)); }
    doc.applyTransform(turn.multiply(Transform.createTranslate(-cx, -cy)));
  }
  const m = axiMeasure(doc);
  let sx = 1;
  let sy = 1;
  if (fit === 'stretch') { sx = box.w / m.w; sy = box.h / m.h; }
  else if (fit === 'cover') { sx = sy = Math.max(box.w / m.w, box.h / m.h); }
  else {
    const k = Math.min(box.w ? box.w / m.w : Infinity, box.h ? box.h / m.h : Infinity);
    sx = sy = isFinite(k) ? k : 1;
  }
  const f = o.focus || (fit === 'cover' ? { x: 0.5, y: 0.5 } : { x: 0, y: 0 });
  doc.applyTransform(Transform.createTranslate(-m.x, -m.y));
  if (sx !== 1 || sy !== 1) { doc.applyTransform(Transform.createScale(sx, sy)); }
  const tx = box.x + (box.w ? (box.w - m.w * sx) * f.x : 0);
  const ty = box.y + (box.h ? (box.h - m.h * sy) * f.y : 0);
  doc.applyTransform(Transform.createTranslate(tx, ty));
  if (o.raster !== false) {
    doc.rasteriseObjects();
    return doc.selection.nodes.first;
  }
  return node;
}

// Internal: validate the rotate and mirror options before any SDK call.
function axiOrientCheck(who, o) {
  if (o.rotate !== undefined && [0, 90, 180, 270].indexOf(o.rotate) < 0) { throw new Error(who + ': rotate must be 0, 90, 180 or 270 (degrees clockwise)'); }
  if (o.mirror !== undefined && typeof o.mirror !== 'boolean') { throw new Error(who + ': mirror must be true or false'); }
}

// Internal: throw before any SDK edit when doc is a CMYK document (addNode fails inside
// Affinity there). doc.format is compared with the CMYK members of RasterFormat
// (/rasterobject.js: CMYK8, CMYKA8, CMYK16, CMYKA16, plus any other key containing CMYK),
// falling back to a CMYK match on String(doc.format). A failed read never blocks.
function axiCmykGuard(who, doc) {
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
  if (cmyk) { throw new Error(who + ': cannot place a picture in a CMYK document; place it while the document is RGB, then convert (doc.format = CMYKA8 or print --cmyk)'); }
}

// Place an image file (the file must be under the Desktop). x,y is the top-left
// corner (default 0,0); w and/or h give the box. fit: 'contain' (default) keeps
// the aspect ratio inside the box and sits top-left; 'cover' fills the whole
// w x h box, cropped by a picture frame and centred on focus {x,y} (0-1);
// 'stretch' distorts to w x h. radius (px) or frame:true clips to a picture
// frame (a rounded rectangle) and needs both w and h. The ML commands only act
// on pixel layers (they silently do nothing on an image node), so the result is
// rasterised at its placed size unless o.raster === false. Returns the image
// (or pixel) node; with a frame it is the frame's child: node.parent is the frame.
function axiImage(doc, o) {
  axiOrientCheck('axiImage', o);
  axiCmykGuard('axiImage', doc);
  const fit = o.fit || 'contain';
  if (fit !== 'contain' && fit !== 'cover' && fit !== 'stretch') { throw new Error('axiImage: fit must be contain, cover or stretch'); }
  const framed = !!(o.radius || o.frame || fit === 'cover');
  if ((framed || fit === 'stretch') && !(o.w > 0 && o.h > 0)) { throw new Error('axiImage: fit ' + fit + ', radius and frame need both w and h'); }
  const box = { x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0 };
  const frame = framed ? axiRect(doc, { x: box.x, y: box.y, w: box.w, h: box.h, radius: o.radius, frame: true }) : null;
  const img = axiPlace(doc, o, box, frame);
  if (o.name !== undefined) {
    axiName(img, o.name);
    if (frame) { axiName(frame, o.name + '-frame'); }
  }
  return img;
}

// Replace the picture in node (an image node, a pixel layer or the picture
// frame holding one) with the file at path. Same pixel size as a pixel layer:
// DocumentCommand.createReplaceBitmap in place (not when o.rotate or o.mirror is
// set: the picture must be turned, so it is always re-placed). Otherwise the old picture is
// deleted and the new one placed into the same box and frame (fit 'cover' by
// default, o.fit overrides), in front of its siblings. Returns the new node.
function axiReplaceImage(doc, node, path, o) {
  const { Bitmap, RasterFormat } = require('/rasterobject.js');
  const { DocumentCommand } = require('/commands.js');
  const opts = o || {};
  axiOrientCheck('axiReplaceImage', opts);
  axiCmykGuard('axiReplaceImage', doc);
  const turned = !!(opts.rotate || opts.mirror);
  let n = node || doc.selection.nodes.first;
  if (!n) { throw new Error('axiReplaceImage: nothing selected; pass a node'); }
  if (n.pictureFrameEnabled && !n.isImageNode && !n.isRasterNode) {
    let inner = null;
    for (const c of n.children) { if (c.isImageNode || c.isRasterNode) { inner = c; break; } }
    if (!inner) { throw new Error('axiReplaceImage: the frame holds no picture'); }
    n = inner;
  }
  const keepName = opts.name !== undefined ? opts.name : n.userDescription;
  const parent = n.parent;
  const inFrame = !!(parent && parent.pictureFrameEnabled);
  const bm = Bitmap.loadFromFile(path, RasterFormat.RGBA8);
  doc.selection = n;
  if (!turned && n.isRasterNode && n.rasterWidth === bm.width && n.rasterHeight === bm.height) {
    doc.executeCommand(DocumentCommand.createReplaceBitmap(doc.selection, bm));
    return axiName(doc.selection.nodes.first, opts.name);
  }
  if (inFrame) { doc.selection = parent; }
  const box = axiMeasure(doc);
  doc.selection = n;
  doc.deleteSelection();
  const target = parent && (inFrame || parent.isArtboardEnabled) ? parent : null;
  const out = axiPlace(doc, { path: path, fit: opts.fit || (inFrame ? 'cover' : 'contain'), raster: opts.raster, focus: opts.focus, rotate: opts.rotate, mirror: opts.mirror }, box, target);
  return axiName(out, keepName || undefined);
}

// Grade presets as axiGrade specs. neutral is a light tone correction only;
// use it for Google Business Profile, which disallows heavy filters.
function axiLook(name) {
  const looks = {
    'warm-soft': {
      whiteBalance: { temp: 0.18, tint: 0.02 },
      exposure: 0.1,
      curves: [[0, 0.03], [0.5, 0.52], [1, 0.98]],
      vibrance: 0.12,
    },
    neutral: {
      levels: { black: 0.02, white: 0.98 },
      vibrance: 0.05,
    },
  };
  if (!looks[name]) { throw new Error('axiLook: unknown look ' + name + '; known: ' + Object.keys(looks).join(', ')); }
  return JSON.parse(JSON.stringify(looks[name]));
}

// Validate a grade spec into an ordered list of steps [kind, params]. Throws on
// unknown keys or out-of-range values, so mistakes surface before anything is added.
function axiGradeSteps(spec) {
  const known = ['whiteBalance', 'exposure', 'levels', 'curves', 'brightnessContrast', 'shadowsHighlights', 'vibrance', 'saturation', 'hsl', 'splitToning'];
  Object.keys(spec).forEach(function (k) {
    if (known.indexOf(k) < 0) { throw new Error('axiGrade: unknown key ' + k + '; known: ' + known.join(', ')); }
  });
  const num = function (what, v, lo, hi) {
    if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) { throw new Error('axiGrade: ' + what + ' must be a number in ' + lo + '..' + hi + ', got ' + v); }
    return v;
  };
  const opt = function (obj, key, what, lo, hi, dflt) { return obj[key] === undefined ? dflt : num(what + '.' + key, obj[key], lo, hi); };
  const rad = function (obj, key, what) { return opt(obj, key, what, 0, 360, 0) * Math.PI / 180; };
  const steps = [];
  if (spec.exposure !== undefined) { steps.push(['exposure', { exposure: num('exposure', spec.exposure, -20, 20) }]); }
  if (spec.whiteBalance) {
    const w = spec.whiteBalance;
    steps.push(['whiteBalance', { whiteBalance: opt(w, 'temp', 'whiteBalance', -1, 1, 0), tint: opt(w, 'tint', 'whiteBalance', -1, 1, 0) }]);
  }
  if (spec.levels) {
    const l = spec.levels;
    steps.push(['levels', { blackLevel: opt(l, 'black', 'levels', 0, 1, 0), whiteLevel: opt(l, 'white', 'levels', 0, 1, 1), gamma: opt(l, 'gamma', 'levels', 0, 2, 1), outputBlackLevel: opt(l, 'outBlack', 'levels', 0, 1, 0), outputWhiteLevel: opt(l, 'outWhite', 'levels', 0, 1, 1) }]);
  }
  if (spec.curves) {
    const c = Array.isArray(spec.curves) ? { master: spec.curves } : spec.curves;
    const lists = {};
    ['master', 'r', 'g', 'b'].forEach(function (ch) {
      if (!c[ch]) { return; }
      if (!Array.isArray(c[ch]) || c[ch].length < 2) { throw new Error('axiGrade: curves.' + ch + ' needs at least two [x,y] points'); }
      lists[ch] = c[ch].map(function (p, i) {
        if (!Array.isArray(p) || p.length !== 2) { throw new Error('axiGrade: curves.' + ch + '[' + i + '] must be [x,y]'); }
        return [num('curves.' + ch + ' x', p[0], 0, 1), num('curves.' + ch + ' y', p[1], 0, 1)];
      });
    });
    steps.push(['curves', lists]);
  }
  if (spec.brightnessContrast) {
    const b = spec.brightnessContrast;
    steps.push(['brightnessContrast', { brightness: opt(b, 'brightness', 'brightnessContrast', -1, 1, 0), contrast: opt(b, 'contrast', 'brightnessContrast', -1, 1, 0) }]);
  }
  if (spec.shadowsHighlights) {
    const s = spec.shadowsHighlights;
    steps.push(['shadowsHighlights', { shadows: opt(s, 'shadows', 'shadowsHighlights', -2, 2, 0), highlights: opt(s, 'highlights', 'shadowsHighlights', -2, 2, 0) }]);
  }
  if (spec.vibrance !== undefined || spec.saturation !== undefined) {
    steps.push(['vibrance', { vibrance: spec.vibrance === undefined ? 0 : num('vibrance', spec.vibrance, -1, 1), saturation: spec.saturation === undefined ? 0 : num('saturation', spec.saturation, -1, 1) }]);
  }
  if (spec.hsl) {
    const h = spec.hsl;
    steps.push(['hsl', { hueShift: opt(h, 'hue', 'hsl', -180, 180, 0) * Math.PI / 180, saturationShift: opt(h, 'saturation', 'hsl', -1, 1, 0), luminosityShift: opt(h, 'luminosity', 'hsl', -1, 1, 0) }]);
  }
  if (spec.splitToning) {
    const t = spec.splitToning;
    steps.push(['splitToning', { shadowsHue: rad(t, 'shadowsHue', 'splitToning'), shadowsSaturation: opt(t, 'shadowsSat', 'splitToning', 0, 1, 0), highlightsHue: rad(t, 'highlightsHue', 'splitToning'), highlightsSaturation: opt(t, 'highlightsSat', 'splitToning', 0, 1, 0), balance: opt(t, 'balance', 'splitToning', 0, 1, 0.5) }]);
  }
  return steps;
}

// The image or pixel layer to grade: node itself, or the picture inside a frame.
function axiGradeTarget(doc, node) {
  const n = node || doc.selection.nodes.first;
  if (!n) { throw new Error('axiGrade: nothing selected; pass a node'); }
  if (n.isImageNode || n.isRasterNode) { return n; }
  for (const c of n.children) { if (c.isImageNode || c.isRasterNode) { return c; } }
  throw new Error('axiGrade: node is not an image or pixel layer and holds none');
}

// Add a stack of adjustment layers as children of the image or pixel layer
// (non-destructive; delete the adjustment children to undo). spec keys, applied
// in this order, all optional:
//   exposure: EV, -20..20
//   whiteBalance: {temp, tint} each -1..1 (temp + is warmer)
//   levels: {black, white, gamma, outBlack, outWhite}, 0..1 each, gamma 0..2 (1 = neutral)
//   curves: [[x,y],...] master curve, 0..1; or {master, r, g, b} point lists
//   brightnessContrast: {brightness, contrast} -1..1
//   shadowsHighlights: {shadows, highlights} -2..2
//   vibrance, saturation: -1..1 (one Vibrance layer)
//   hsl: {hue (degrees -180..180), saturation, luminosity (-1..1)} master shift
//   splitToning: {shadowsHue, highlightsHue (degrees 0..360), shadowsSat, highlightsSat, balance (0..1)}
// spec may also be an axiLook name. Returns the graded node.
function axiGrade(doc, node, spec) {
  const steps = axiGradeSteps(typeof spec === 'string' ? axiLook(spec) : spec || {});
  const target = axiGradeTarget(doc, node);
  const N = require('/nodes.js');
  const { Spline } = require('/geometry.js');
  const { AddChildNodesCommandBuilder, InsertionMode, NodeChildType } = require('/commands.js');
  const cs = doc.colourProfile.colourSpace;
  const make = function (kind, p) {
    let params;
    if (kind === 'exposure') { params = N.ExposureAdjustmentParameters.create(); params.exposure = p.exposure; return N.ExposureAdjustmentRasterNodeDefinition.create(params); }
    if (kind === 'whiteBalance') { params = N.WhiteBalanceAdjustmentParameters.create(); params.whiteBalance = p.whiteBalance; params.tint = p.tint; return N.WhiteBalanceAdjustmentRasterNodeDefinition.create(params); }
    if (kind === 'levels') { params = N.LevelsAdjustmentParameters.create(); params.masterParameters = p; return N.LevelsAdjustmentRasterNodeDefinition.create(params, cs); }
    if (kind === 'curves') {
      params = N.CurvesAdjustmentParameters.create();
      if (p.master) { params.masterSpline = Spline.createFromPoints(p.master); }
      ['r', 'g', 'b'].forEach(function (ch, i) { if (p[ch]) { params.setChannelSpline(i, Spline.createFromPoints(p[ch])); } });
      return N.CurvesAdjustmentRasterNodeDefinition.create(params, cs);
    }
    if (kind === 'brightnessContrast') { params = N.BrightnessContrastAdjustmentParameters.create(); params.brightness = p.brightness; params.contrast = p.contrast; return N.BrightnessContrastAdjustmentRasterNodeDefinition.create(params); }
    if (kind === 'shadowsHighlights') { params = N.ShadowsHighlightsAdjustmentParameters.create(); params.shadows = p.shadows; params.highlights = p.highlights; return N.ShadowsHighlightsAdjustmentRasterNodeDefinition.create(params); }
    if (kind === 'vibrance') { params = N.VibranceAdjustmentParameters.create(); params.vibrance = p.vibrance; params.saturation = p.saturation; return N.VibranceAdjustmentRasterNodeDefinition.create(params); }
    if (kind === 'hsl') { params = N.HSLShiftAdjustmentParameters.create(); params.masterParameters = p; return N.HSLShiftAdjustmentRasterNodeDefinition.create(params); }
    params = N.SplitToningAdjustmentParameters.create();
    Object.keys(p).forEach(function (k) { params[k] = p[k]; });
    return N.SplitToningAdjustmentRasterNodeDefinition.create(params);
  };
  steps.forEach(function (s) {
    const b = AddChildNodesCommandBuilder.create();
    b.setInsertionTarget(target);
    b.setInsertionMode(InsertionMode.Inside_AtFront);
    b.addNode(make(s[0], s[1]));
    doc.executeCommand(b.createCommand(false, NodeChildType.Main));
  });
  doc.selection = target;
  return target;
}
`;
