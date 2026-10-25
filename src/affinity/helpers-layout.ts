// Artboard, safe-zone and text-fitting helpers for run --with-helpers. Same
// rules as helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks or ${).
//
// SDK classes used: Document.addArtboard with a rectangular ShapeNodeDefinition,
// ArtboardInterface (description, spreadBaseBox; the name is the artboard
// node's userDescription), Document.addGuide (guides are per artboard: select
// the artboard first; positions are spread coordinates), and for text fitting
// Node.getExactSpreadVisibleBox (the ink box) and, for frame text nodes,
// Node.getSpreadVisibleBox (which also grows with the text that overflows).

import type { HelperInfo } from "./helpers-core.js";

export const LAYOUT_INDEX: readonly HelperInfo[] = [
  { name: "axiPlatform", signature: "axiPlatform(key)", summary: "size row {key,w,h,safe?,notes} for a web or social platform (ig-square, ig-portrait, story, og, discover, gbp-post, favicon-32, web-hero ...); throws with the known keys; run `platforms` to list them" },
  { name: "axiArtboard", signature: "axiArtboard(doc, {name,x,y,w,h,fill})", summary: "add one rectangular artboard whose name (its userDescription) is required and unique; the first artboard of a document must be at 0,0 (fill is an optional hex); returns the artboard node" },
  { name: "axiArtboards", signature: "axiArtboards(doc, specs, {gap})", summary: "add artboards [{name,w,h,fill} or {platform,name?,fill?}] in a row from 0,0 (or after the existing ones), top-aligned, gap px apart (default 100); returns [{name,x,y,w,h}]" },
  { name: "axiOn", signature: "axiOn(doc, name)", summary: "select the artboard so new nodes land inside it, and return its origin {name,x,y,w,h}; coordinates stay in the spread, so draw at origin.x + dx" },
  { name: "axiSafeZone", signature: "axiSafeZone(doc, artboardName, platformKey, {overlay})", summary: "add guides at the platform's safe-area insets on that artboard (story: 250 px top, 340 px bottom); guides show in the editor only; overlay:true also draws locked translucent red bands named axi-safe-zone so a render shows them (delete before export); returns [{horizontal,pos}], empty when the platform has no safe area" },
  { name: "axiFitText", signature: "axiFitText(doc, {x,y,w,h,text,font,size,minSize,maxLines,colour,align,leading,spacing,name})", summary: "wrapped text in the box x,y,w,h, shrunk from size toward minSize until it fits the box and maxLines; name sets the node's userDescription; returns {size,lines,overflow,node}; overflow true means even minSize does not fit" },
  { name: "axiShrinkText", signature: "axiShrinkText(doc, ref, {w,h,minSize})", summary: "shrink an existing text node (ref as axiFind) until its box is <= w by h (a frame text node must also have a spread visible box, the one inspect reports, no taller than h plus max(4, 5% of h); that box's width is ignored), bisecting in 0.5 px steps from its current size down to minSize (default half the size, at least 8); returns {from,size,fits}; from === size when it already fit, fits false means even minSize does not fit (the node is left at minSize)" },
];

/** Internal building blocks, not in the index. */
export const LAYOUT_INTERNAL: readonly string[] = ["axiFindArtboard"];

export const LAYOUT_SOURCE: string = String.raw`
// Internal: the artboard named name as an ArtboardInterface; throws with the names present.
function axiFindArtboard(doc, name) {
  const all = doc.artboards;
  const hit = all.find(function (a) { return a.description === name; });
  if (!hit) { throw new Error('no artboard named ' + name + '; present: ' + (all.map(function (a) { return a.description; }).join(', ') || 'none')); }
  return hit;
}

// One rectangular artboard named name at x,y (default 0,0) of size w,h; fill is
// an optional hex colour. Artboard names must be unique. Affinity re-bases the
// spread on the first artboard (it moves it to 0,0 and the spread shrinks to
// the artboards), so the first artboard of a document must be at 0,0: a
// different x,y throws. Later ones go anywhere. Returns the artboard node.
function axiArtboard(doc, o) {
  if (!o || typeof o.name !== 'string' || o.name === '') { throw new Error('axiArtboard: name is required'); }
  if (!(o.w > 0 && o.h > 0)) { throw new Error('axiArtboard: w and h must be positive'); }
  if (doc.artboards.some(function (a) { return a.description === o.name; })) { throw new Error('axiArtboard: an artboard named ' + o.name + ' already exists'); }
  const x = o.x || 0;
  const y = o.y || 0;
  if (doc.artboards.length === 0 && (x !== 0 || y !== 0)) { throw new Error('axiArtboard: the first artboard of a document must be at 0,0 (Affinity re-bases the spread on it)'); }
  const { ShapeNodeDefinition } = require('/nodes.js');
  const { ShapeRectangle } = require('/shapes.js');
  const before = doc.artboards.map(function (a) { return a.description; });
  doc.addArtboard(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: x, y: y, width: o.w, height: o.h }, o.fill ? axiHex(o.fill) : null, null, null));
  const fresh = doc.artboards.filter(function (a) { return before.indexOf(a.description) < 0; });
  const ab = fresh[fresh.length - 1];
  if (!ab) { throw new Error('axiArtboard: the artboard was not created'); }
  ab.node.userDescription = o.name;
  return ab.node;
}

// Artboards in a row, top-aligned, gap px apart (default 100). A new document
// starts at 0,0 (see axiArtboard); when artboards already exist the row
// continues to the right of them. Each spec is {name,w,h,fill} or {platform:'story',
// name?,fill?}; a platform key (see axiPlatform) supplies w and h and is the
// default name. Returns [{name,x,y,w,h}] in the spread.
function axiArtboards(doc, specs, o) {
  const opts = o || {};
  if (!Array.isArray(specs) || specs.length === 0) { throw new Error('axiArtboards: specs must be a non-empty array'); }
  const gap = opts.gap === undefined ? 100 : opts.gap;
  let x = 0;
  let y = 0;
  const have = doc.artboards.map(function (a) { return a.spreadBaseBox; });
  if (have.length) {
    x = Math.max.apply(null, have.map(function (b) { return b.x + b.width; })) + gap;
    y = Math.min.apply(null, have.map(function (b) { return b.y; }));
  }
  return specs.map(function (s) {
    const p = s.platform ? axiPlatform(s.platform) : null;
    const w = s.w || (p && p.w);
    const h = s.h || (p && p.h);
    const name = s.name || (p && p.key);
    axiArtboard(doc, { name: name, x: x, y: y, w: w, h: h, fill: s.fill });
    const r = { name: name, x: x, y: y, w: w, h: h };
    x += w + gap;
    return r;
  });
}

// Select the artboard named name, so the next nodes are added inside it, and
// return its origin {name,x,y,w,h}. Coordinates are still spread coordinates:
// draw at origin.x + dx, origin.y + dy.
function axiOn(doc, name) {
  const a = axiFindArtboard(doc, name);
  doc.selection = a.node;
  const b = a.spreadBaseBox;
  return { name: name, x: b.x, y: b.y, w: b.width, h: b.height };
}

// Guides at the safe-area insets of platformKey (axiPlatform(key).safe) on the
// named artboard. Guides belong to the selected artboard and are spread
// coordinates, so the artboard is selected first. Returns the guides added as
// [{horizontal,pos}] (horizontal true = a line at a y position); [] when the
// platform defines no safe area. Guides are write-only in the SDK: they show in
// the editor, not in render or export. overlay:true adds locked, translucent
// red bands (named axi-safe-zone) over the unsafe margins so a render can show
// them; delete them before export.
function axiSafeZone(doc, artboardName, platformKey, o) {
  const row = axiPlatform(platformKey);
  const s = row.safe;
  const a = axiOn(doc, artboardName);
  if (!s) { return []; }
  const guides = [];
  if (s.top) { guides.push({ horizontal: true, pos: a.y + s.top }); }
  if (s.bottom) { guides.push({ horizontal: true, pos: a.y + a.h - s.bottom }); }
  if (s.left) { guides.push({ horizontal: false, pos: a.x + s.left }); }
  if (s.right) { guides.push({ horizontal: false, pos: a.x + a.w - s.right }); }
  guides.forEach(function (g) { doc.addGuide(g.horizontal, g.pos); });
  if (o && o.overlay) {
    const bands = [];
    if (s.top) { bands.push([a.x, a.y, a.w, s.top]); }
    if (s.bottom) { bands.push([a.x, a.y + a.h - s.bottom, a.w, s.bottom]); }
    if (s.left) { bands.push([a.x, a.y, s.left, a.h]); }
    if (s.right) { bands.push([a.x + a.w - s.right, a.y, s.right, a.h]); }
    bands.forEach(function (r) {
      axiOn(doc, artboardName);
      const n = axiRect(doc, { x: r[0], y: r[1], w: r[2], h: r[3], fill: '#ff0000', fillAlpha: 0.27 });
      n.userDescription = 'axi-safe-zone';
      n.lock();
    });
  }
  return guides;
}

// Wrapped text in the box x,y,w,h (top-left x,y), shrunk until it fits. It tries
// size first, then bisects down to minSize (default half of size, at least 8) in
// 0.5 steps. Fits means: the ink height is <= h, the ink width is <= w and the
// line count is <= maxLines (default unlimited). Measured on a real text frame
// with the ink box (getExactSpreadVisibleBox), after transforms, so wrapping,
// leading and font metrics are the actual ones. leading is relative (default 1.2);
// colour, align (l c r j) and spacing as axiParagraph. Returns {size, lines,
// overflow, node}; overflow is true when even minSize does not fit (the text is
// then placed at minSize anyway).
function axiFitText(doc, o) {
  if (!o || typeof o.text !== 'string' || o.text === '') { throw new Error('axiFitText: text is required'); }
  if (typeof o.font !== 'string' || o.font === '') { throw new Error('axiFitText: font (a postscriptName) is required'); }
  if (!(o.w > 0 && o.h > 0)) { throw new Error('axiFitText: w and h must be positive'); }
  if (typeof o.x !== 'number' || typeof o.y !== 'number') { throw new Error('axiFitText: x and y are required'); }
  if (!(o.size > 0)) { throw new Error('axiFitText: size must be positive'); }
  const minSize = o.minSize === undefined ? Math.max(8, o.size / 2) : o.minSize;
  if (!(minSize > 0) || minSize > o.size) { throw new Error('axiFitText: minSize must be in (0, size]'); }
  if (o.maxLines !== undefined && !(o.maxLines >= 1 && Math.floor(o.maxLines) === o.maxLines)) { throw new Error('axiFitText: maxLines must be a whole number >= 1'); }
  const lead = o.leading === undefined ? 1.2 : o.leading;
  if (!(lead >= 0.8 && lead <= 3)) { throw new Error('axiFitText: leading must be 0.8..3 (relative to the text height)'); }
  const place = function (size, h, name) {
    return axiParagraph(doc, { x: o.x, y: o.y, w: o.w, h: h, text: o.text, font: o.font, size: size, colour: o.colour, lead: lead, spacing: o.spacing, align: o.align, name: name });
  };
  const measure = function (size) {
    const p = place(size, 20000);
    const b = p.getExactSpreadVisibleBox(false, true);
    doc.deleteSelection();
    const lines = Math.max(1, Math.round((b.height - 0.85 * size) / (lead * size)) + 1);
    return { h: b.height, w: b.width, lines: lines, fits: b.height <= o.h + 0.5 && b.width <= o.w + 0.5 && lines <= (o.maxLines || Infinity) };
  };
  let size = o.size;
  let m = measure(size);
  let overflow = false;
  if (!m.fits) {
    let lo = minSize;
    let hi = size;
    const mLo = measure(lo);
    if (!mLo.fits) {
      size = lo;
      m = mLo;
      overflow = true;
    } else {
      let best = mLo;
      while (hi - lo > 0.5) {
        const mid = Math.floor((lo + hi) / 2 * 2) / 2;
        if (mid <= lo) { break; }
        const mm = measure(mid);
        if (mm.fits) { lo = mid; best = mm; } else { hi = mid; }
      }
      size = lo;
      m = best;
    }
  }
  const node = place(size, o.h, o.name);
  return { size: size, lines: m.lines, overflow: overflow, node: node };
}

// Shrink the text of an existing node (ref as axiFind) until its ink box is at
// most w wide and h high. The size is the glyph height over the whole story: it
// starts at the first run's height, then bisects in 0.5 steps down to minSize
// (default half the start size, at least 8, never above it). Measured on the
// node itself with the ink box (getExactSpreadVisibleBox), so wrapping and font
// metrics are the actual ones. Returns {from, size, fits}: from === size and no
// edit when it already fit; fits false means even minSize does not fit, and the
// node is left at minSize. Use h of 1e9 for a one-line text that only has a width.
// A frame text node fits when its ink box fits and its spread visible box (the
// one inspect reports) is no taller than h plus max(4, 5% of h): the ink box of a
// frame is clipped to the frame right after the text is set, so overflow only
// shows as height in the spread box, whose width includes frame chrome and is
// ignored. Art text keeps the ink box and never reads the spread box.
function axiShrinkText(doc, ref, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiShrinkText: options {w,h} are required'); }
  if (!(typeof o.w === 'number' && o.w > 0) || !(typeof o.h === 'number' && o.h > 0)) { throw new Error('axiShrinkText: w and h must be positive numbers'); }
  if (o.minSize !== undefined && !(typeof o.minSize === 'number' && o.minSize > 0)) { throw new Error('axiShrinkText: minSize must be a positive number'); }
  const row = axiOne(doc, ref);
  if (row.text === null) { throw new Error('axiShrinkText: ' + axiRowLabel(row) + ' is not a text node'); }
  const { StoryDelta } = require('/storydelta.js');
  const { GlyphAttDoubleType } = require('/glyphatts.js');
  let from = 0;
  for (const run of row.node.story.getGlyphAttRunsFrom(0)) {
    from = run.glyphAtts.height;
    break;
  }
  if (!(from > 0)) { throw new Error('axiShrinkText: ' + axiRowLabel(row) + ' has no text size to shrink'); }
  const frame = !!row.node.isFrameTextNode;
  const back = axiOnSpread(doc, row.node);
  try {
    const fitsNow = function () {
      const b = row.node.getExactSpreadVisibleBox(false, true);
      if (!(b.width <= o.w + 0.5 && b.height <= o.h + 0.5)) { return false; }
      if (frame) {
        const l = row.node.getSpreadVisibleBox(false);
        if (!(l.height <= o.h + Math.max(4, 0.05 * o.h))) { return false; }
      }
      return true;
    };
    if (fitsNow()) { return { from: from, size: from, fits: true }; }
    const minSize = Math.min(from, o.minSize === undefined ? Math.max(8, from / 2) : o.minSize);
    let cur = from;
    const apply = function (size) {
      doc.formatText(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, size), axiStoryRange(doc, row.node));
      cur = size;
    };
    let lo = minSize;
    let hi = from;
    if (lo >= hi) { return { from: from, size: from, fits: false }; }
    apply(lo);
    if (!fitsNow()) { return { from: from, size: lo, fits: false }; }
    while (hi - lo > 0.5) {
      const mid = Math.floor((lo + hi) / 2 * 2) / 2;
      if (mid <= lo) { break; }
      apply(mid);
      if (fitsNow()) { lo = mid; } else { hi = mid; }
    }
    if (cur !== lo) { apply(lo); }
    return { from: from, size: lo, fits: true };
  } finally { back(); }
}
`;
