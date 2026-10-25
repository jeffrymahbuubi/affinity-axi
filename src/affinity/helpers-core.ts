// Core SDK helpers (colour, document, fonts, text, shapes, measure) for
// run <file> --with-helpers; helpers.ts concatenates this block with the image,
// layout and platform blocks. Plain JS for Affinity's script runtime,
// distilled from the mood-board generator. Function declarations only, all prefixed `axi`, with every
// require() inside a function, so appending the block after a user's script
// neither shifts its line numbers nor collides with its own names.
//
// Contains no document-closing call and no generative API (a test scans it).
// The block is String.raw: keep backticks, ${ and backslashes out of it.

export interface HelperInfo {
  name: string;
  signature: string;
  summary: string;
}

/** Core helpers. axiStyled and axiStroke are internal building blocks. */
export const CORE_INDEX: readonly HelperInfo[] = [
  { name: "axiHex", signature: "axiHex(hex, alpha?)", summary: "'#RGB' or '#RRGGBB' to an RGBA8; alpha 0-1 (default 1; a value 2-255 is taken as a byte)" },
  { name: "axiDoc", signature: "axiDoc(w, h, dpi?)", summary: "new pixel document (1 unit = 1 px at 72 dpi)" },
  { name: "axiFont", signature: "axiFont(postscript)", summary: "find a font by postscriptName (cached); throws with near matches" },
  { name: "axiText", signature: "axiText(doc, {x,y,text,font,size,colour,spacing,align,maxW,name})", summary: "one text line, y is the baseline; align l|c|r anchors x; name sets the node's userDescription; returns the node" },
  { name: "axiParagraph", signature: "axiParagraph(doc, {x,y,w,h,text,font,size,colour,lead,spacing,align,name})", summary: "wrapped text in a frame (top-left x,y); lead is relative leading, default 1.5; align l|c|r|j; name sets the node's userDescription" },
  { name: "axiMeasure", signature: "axiMeasure(doc)", summary: "{x,y,w,h} in document px of the node just added or moved (selection.nodes.first)" },
  { name: "axiMove", signature: "axiMove(doc, dx, dy)", summary: "translate the current selection by dx, dy px" },
  { name: "axiRect", signature: "axiRect(doc, {x,y,w,h,fill,fillAlpha,radius,stroke,strokeWidth,frame,name})", summary: "rectangle; fillAlpha 0-1 (default 1); name sets the node's userDescription; radius in px rounds all four corners; frame:true makes it a picture frame that clips its children; returns the node" },
  { name: "axiEllipse", signature: "axiEllipse(doc, {x,y,w,h,fill,fillAlpha,stroke,strokeWidth,name})", summary: "ellipse in the box x,y,w,h; fillAlpha 0-1 (default 1); name sets the node's userDescription; returns the node" },
];

export const CORE_SOURCE: string = String.raw`
/* ---- affinity-axi helpers (appended by --with-helpers) ---- */

// '#RGB' or '#RRGGBB' to an RGBA8. alpha is a 0-1 fraction (default 1); a value
// above 1 up to 255 is taken as a byte (older scripts); anything else throws.
function axiHex(hex, alpha) {
  const { RGBA8 } = require('/colours.js');
  let h = String(hex).replace('#', '');
  if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) { throw new Error('axiHex: bad colour ' + hex); }
  let a = 255;
  if (alpha !== undefined) {
    if (typeof alpha !== 'number' || !(alpha >= 0 && alpha <= 255)) { throw new Error('axiHex: alpha must be 0..1'); }
    a = alpha <= 1 ? Math.round(alpha * 255) : Math.round(alpha);
  }
  return RGBA8(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a);
}

// New pixel document: units Pixel, dpi 72, so 1 unit is 1 px.
function axiDoc(w, h, dpi) {
  const { Document, NewDocumentOptions } = require('/document.js');
  const { UnitType } = require('/units.js');
  const o = NewDocumentOptions.createDefault();
  o.units = UnitType.Pixel; o.width = w; o.height = h; o.dpi = dpi || 72;
  return Document.createFromOptions(o);
}

// Font by postscriptName. Variable families report unreliable name/weight, so
// match on postscriptName only, e.g. Fraunces-SemiBold, PlusJakartaSans-Regular.
function axiFont(postscript) {
  const { FontFamily } = require('/fonts.js');
  axiFont.cache = axiFont.cache || {};
  if (!axiFont.cache[postscript]) {
    const names = [];
    for (const fam of FontFamily.all) {
      for (const f of fam.fonts) {
        axiFont.cache[f.postscriptName] = f;
        names.push(f.postscriptName);
      }
    }
    if (!axiFont.cache[postscript]) {
      const stem = String(postscript).split('-')[0].toLowerCase();
      const near = names.filter(function (n) { return n.toLowerCase().indexOf(stem) === 0; }).slice(0, 8);
      throw new Error('axiFont: no font ' + postscript + (near.length ? '; similar: ' + near.join(', ') : ''));
    }
  }
  return axiFont.cache[postscript];
}

// Story builder styled with font, size (px), colour and optional tracking.
// Spacing is tiny: 0.2 is already wide.
function axiStyled(doc, o, frame) {
  const { StoryBuilder } = require('/storybuilder.js');
  const { StoryDelta } = require('/storydelta.js');
  const { FontField } = require('/fonts.js');
  const { GlyphAttDoubleType } = require('/glyphatts.js');
  const { FillDescriptor } = require('/fills.js');
  const sb = StoryBuilder.create();
  if (frame) { sb.setToFrameTextDefaultStyle(doc.dpi, doc.rasterFormat); }
  else { sb.setToArtisticTextDefaultStyle(doc.dpi, doc.rasterFormat); }
  sb.applyGlyphDelta(StoryDelta.createFont(FontField.PostscriptName | FontField.FamilyName, axiFont(o.font)));
  sb.applyGlyphDelta(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, o.size));
  sb.applyGlyphDelta(StoryDelta.createBrushFill(FillDescriptor.createSolid(axiHex(o.colour || '#000000'))));
  if (o.spacing) { sb.applyGlyphDelta(StoryDelta.createGlyphDouble(GlyphAttDoubleType.CharacterSpacing, o.spacing)); }
  return sb;
}

// Box {x,y,w,h} of the node just added: after addNode it is selection.nodes.first.
// baseBox is in the node's own space and ignores moves, so run its corners
// through the node transform to get document coordinates.
function axiMeasure(doc) {
  const n = doc.selection.nodes.first;
  const b = n.baseBoxInterface.baseBox;
  const t = n.transform;
  const xs = [];
  const ys = [];
  [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].forEach(function (c) {
    const p = t.applyToPoint({ x: c[0], y: c[1] });
    xs.push(p.x);
    ys.push(p.y);
  });
  const x = Math.min.apply(null, xs);
  const y = Math.min.apply(null, ys);
  return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
}

// Translate the current selection.
function axiMove(doc, dx, dy) {
  const { Transform } = require('/geometry.js');
  doc.applyTransform(Transform.createTranslate(dx, dy));
}

// Internal: give node a stable name (its userDescription) when name is given, so
// a later session can find the element by name. Returns the node.
function axiName(node, name) {
  if (name !== undefined && name !== null && node) { node.userDescription = String(name); }
  return node;
}

// Internal: new nodes added while the selection sits inside a picture frame
// (for example right after a framed axiImage) would land inside it and be
// clipped. Move the selection out to the frame's parent first.
function axiSurface(doc) {
  let n = doc.selection.nodes.first;
  let top = null;
  while (n) {
    if (n.pictureFrameEnabled) { top = n; }
    n = n.parent;
  }
  if (top && top.parent) { doc.selection = top.parent; }
}

// One line of text at baseline y. align: 'l' (x = left edge of the ink, default),
// 'c' (x = centre) or 'r' (x = right edge). maxW shrinks the size to fit.
// Returns the node; axiMeasure(doc) then gives its final box.
function axiText(doc, o) {
  axiSurface(doc);
  const { ArtTextNodeDefinition } = require('/nodes.js');
  const make = function (size) {
    const sb = axiStyled(doc, { font: o.font, size: size, colour: o.colour, spacing: o.spacing }, false);
    sb.addText(o.text);
    doc.addNode(ArtTextNodeDefinition.createFromStoryBuilder({ x: o.x, y: o.y }, sb));
    return axiMeasure(doc);
  };
  let b = make(o.size);
  if (o.maxW && b.w > o.maxW) {
    doc.deleteSelection();
    b = make(o.size * o.maxW / b.w);
  }
  const align = o.align || 'l';
  const shift = align === 'c' ? o.x - (b.x + b.w / 2) : align === 'r' ? o.x - (b.x + b.w) : o.x - b.x;
  if (Math.abs(shift) > 0.01) { axiMove(doc, shift, 0); }
  return axiName(doc.selection.nodes.first, o.name);
}

// Wrapped text in a frame with top-left x,y and size w,h. lead is relative
// leading (1.5 = 150% of the text height). align: 'l' (default), 'c', 'r' or 'j'.
function axiParagraph(doc, o) {
  axiSurface(doc);
  const { FrameTextNodeDefinition } = require('/nodes.js');
  const { StoryDelta } = require('/storydelta.js');
  const { ParagraphAttDoubleType, ParagraphLeadingType, ParagraphAlignXType } = require('/paragraphatts.js');
  const sb = axiStyled(doc, o, true);
  const ax = { l: ParagraphAlignXType.Left, c: ParagraphAlignXType.Centre, r: ParagraphAlignXType.Right, j: ParagraphAlignXType.JustifyLeft }[o.align || 'l'];
  if (ax === undefined) { throw new Error('axiParagraph: align must be l, c, r or j'); }
  sb.applyParagraphDelta(StoryDelta.createAlignX(ax));
  sb.applyParagraphDelta(StoryDelta.createLeadingType(ParagraphLeadingType.RelativeToHeight));
  sb.applyParagraphDelta(StoryDelta.createParagraphDouble(ParagraphAttDoubleType.RelativeLeading, o.lead || 1.5));
  sb.addText(o.text);
  doc.addNode(FrameTextNodeDefinition.createFromStoryBuilder({ x: o.x, y: o.y, width: o.w, height: o.h }, sb));
  return axiName(doc.selection.nodes.first, o.name);
}

// Stroke arguments for ShapeNodeDefinition.create: a LineStyleDescriptor, not a LineStyle.
function axiStroke(o) {
  const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
  if (!o.stroke) { return [null, null]; }
  return [axiHex(o.stroke), LineStyleDescriptor.create(LineStyle.create({ weight: o.strokeWidth || 2 }))];
}

// Rectangle at x,y of size w,h. radius (px) rounds all four corners; the SDK
// wants it relative to the shorter side, capped at 0.5 (a full pill).
// frame:true turns it into a picture frame (children are clipped to it).
function axiRect(doc, o) {
  axiSurface(doc);
  const { ShapeRectangle, ShapeCornerType } = require('/shapes.js');
  const { ShapeNodeDefinition } = require('/nodes.js');
  const s = ShapeRectangle.create();
  if (o.radius) {
    const k = Math.min(0.5, o.radius / Math.min(o.w, o.h));
    for (const c of [s.topLeft, s.topRight, s.bottomLeft, s.bottomRight]) {
      c.cornerType = ShapeCornerType.Round;
      c.setRadius(k, o.w, o.h);
    }
  }
  const st = axiStroke(o);
  const def = ShapeNodeDefinition.create(s, { x: o.x, y: o.y, width: o.w, height: o.h }, o.fill ? axiHex(o.fill, o.fillAlpha) : null, st[0], st[1]);
  if (o.frame) { def.pictureFrameEnabled = true; }
  doc.addNode(def);
  return axiName(doc.selection.nodes.first, o.name);
}

// Ellipse filling the box x,y,w,h (use w === h for a circle).
function axiEllipse(doc, o) {
  axiSurface(doc);
  const { ShapeEllipse } = require('/shapes.js');
  const { ShapeNodeDefinition } = require('/nodes.js');
  const st = axiStroke(o);
  doc.addNode(ShapeNodeDefinition.create(ShapeEllipse.create(), { x: o.x, y: o.y, width: o.w, height: o.h }, o.fill ? axiHex(o.fill, o.fillAlpha) : null, st[0], st[1]));
  return axiName(doc.selection.nodes.first, o.name);
}
`;
