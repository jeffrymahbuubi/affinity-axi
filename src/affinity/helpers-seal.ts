// Seal and arc-text helpers for run --with-helpers. Same rules as helpers-core.ts
// (function declarations prefixed axi, requires inside functions, nothing
// blocking or generative, String.raw so no backticks, dollar-brace or
// backslash surprises).
//
// SDK classes used: CurveBuilder.beginXY/addArc/createCurve and PolyCurve from
// /geometry.js, CurvePathTextNodeDefinition from /nodes.js (text on an open arc,
// centre aligned), ShapeStar for the burst, ShapeNodeDefinition for placing it.
//
// PROBE RESULTS (test/live/arc-probe.js, Affinity 3.3.1.4940, 2026-10-26):
//   - Text nodes on a path (ShapePathText on an Ellipse, CurvePathText) report the
//     box of the PATH from baseBox and getSpreadBaseBox, never of the text. The text
//     cannot be measured, so the plan's measure-and-rotate scheme is not possible.
//     The helper places the text by geometry instead: an open arc centred on the
//     requested angle, text centre aligned, so the middle of the text sits on it.
//   - CurveBuilder.addArc(a0, a1, r, reverse) starts at the CURRENT point (use
//     beginXY), the circle centre is that point minus r*(cos a0, sin a0). Angles are
//     radians in document space: 0 = right, pi/2 = down, a positive sweep is clockwise
//     on screen; reverse=true takes the other way round.
//   - Top: arc from theta-half to theta+half (clockwise), glyphs stand OUTSIDE the
//     circle, baseline on it, reads left to right over the top. Bottom: arc from
//     theta+half to theta-half with reverse=true (counter-clockwise), glyphs stand
//     INSIDE the circle, reads left to right and upright under the bottom. theta is
//     the document angle of the requested clock angle: (clock - 90) degrees.
//   - Transform.createTranslate(c).multiply(createRotate(r)).multiply(createTranslate(-c))
//     applies right to left and a positive angle is clockwise (not needed here).
//   - ShapeStar.innerRadius is a 0-1 fraction of the outer radius (default 0.38 for 5
//     points); maxInnerRadius is about 0.99 for 28 points; set points first.
//
// Validation runs before any require(), so a bad option throws without touching
// the document.

import type { HelperInfo } from "./helpers-core.js";

export const SEAL_INDEX: readonly HelperInfo[] = [
  {
    name: "axiArcText",
    signature: "axiArcText(doc, {cx,cy,r,text,font,size,colour,spacing,start,side,name})",
    summary:
      "text on a circle of radius r around cx,cy (px); the baseline sits on the circle. side 'top' (default) reads left to right over the top with the letters outside the circle; side 'bottom' reads left to right and upright under the bottom with the letters inside. start is the angle in degrees of the middle of the text, 0 = 12 o'clock, clockwise (default 0 for top, 180 for bottom). Text longer than the circle (about 0.55 em per character against 2*pi*r) throws before any SDK call. spacing is character tracking (0.2 is already wide); name sets the node's userDescription. Returns the text node",
  },
  {
    name: "axiSeal",
    signature: "axiSeal(doc, {cx,cy,r,top,bottom,centre,font,size,colour,spacing,ring,burst,name})",
    summary:
      "promo seal or stamp centred on cx,cy with outer radius r: burst {points?:24,depth?:0.12,fill?} (a star, true for defaults), ring {fill?,stroke?,strokeWidth?:3,inset?} (a filled disc inside the burst and an optional stroked inner circle inset px in; true for a stroke in colour), top and bottom arc texts at the inner edge of the ring, centre a string, {text,font,size,colour} or an array of such lines stacked and centred (long lines shrink to fit). font is required; size defaults to 0.13*r, colour to #000000. Parts are named <name>-burst, -ring, -ring-inner, -top, -bottom, -centre-<i>. Returns {r, textR, innerR, nodes:{burst,ring,ringInner,top,bottom,centre:[...]}}",
  },
];

/** Internal building blocks, not in the index. */
export const SEAL_INTERNAL: readonly string[] = ["axiArcPath"];

export const SEAL_SOURCE: string = String.raw`
/* ---- seal and arc-text helpers ---- */

// Internal: an open arc as a PolyCurve for text on a circle (cx,cy,r). The arc
// spans spanDeg degrees centred on startDeg (0 = 12 o'clock, clockwise). top runs
// clockwise, bottom runs counter-clockwise (reverse), so both read left to right.
// addArc starts at the current point, hence beginXY on the circle at the first angle.
function axiArcPath(cx, cy, r, side, startDeg, spanDeg) {
  const G = require('/geometry.js');
  if (typeof G.CurveBuilder !== 'function' || typeof G.PolyCurve !== 'function' || typeof G.CurveBuilder.prototype.addArc !== 'function') {
    throw new Error('axiArcText: ' + side + ' text is not supported on this build');
  }
  const bottom = side === 'bottom';
  const theta = (startDeg - 90) * Math.PI / 180;
  const half = spanDeg * Math.PI / 360;
  const a0 = bottom ? theta + half : theta - half;
  const a1 = bottom ? theta - half : theta + half;
  const curve = new G.CurveBuilder().beginXY(cx + r * Math.cos(a0), cy + r * Math.sin(a0)).addArc(a0, a1, r, bottom).createCurve();
  const pc = G.PolyCurve.create();
  pc.addCurve(curve);
  return pc;
}

// Text on a circle. See the index for the options. The text node is created on
// an open arc centred on start and centre aligned, so no measuring or rotating
// is needed. Returns the node, which stays selected.
function axiArcText(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiArcText: options {cx,cy,r,text,font,size} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.cx) || !fin(o.cy)) { throw new Error('axiArcText: cx and cy are required numbers'); }
  if (!fin(o.r) || !(o.r > 0)) { throw new Error('axiArcText: r is required and must be positive'); }
  const side = o.side === undefined ? 'top' : o.side;
  if (side !== 'top' && side !== 'bottom') { throw new Error('axiArcText: side must be top or bottom (got ' + o.side + ')'); }
  if (typeof o.text !== 'string' || o.text === '') { throw new Error('axiArcText: text is required'); }
  if (typeof o.font !== 'string' || o.font === '') { throw new Error('axiArcText: font (a postscript name) is required'); }
  if (!fin(o.size) || !(o.size > 0)) { throw new Error('axiArcText: size is required and must be positive'); }
  if (o.spacing !== undefined && !fin(o.spacing)) { throw new Error('axiArcText: spacing must be a number'); }
  const start0 = o.start === undefined ? (side === 'top' ? 0 : 180) : o.start;
  if (!fin(start0)) { throw new Error('axiArcText: start must be a number of degrees'); }
  const start = ((start0 % 360) + 360) % 360;
  const track = 1 + (o.spacing || 0);
  const need = 0.55 * o.size * o.text.length * track;
  if (need > 2 * Math.PI * o.r) {
    throw new Error('axiArcText: text is too long for the circle (about ' + Math.round(need) + ' px of text on ' + Math.round(2 * Math.PI * o.r) + ' px of circle); shorten it, use a smaller size or a larger r');
  }
  // The arc is generous (0.8 em per character, a quarter more, 20 degrees extra) so the text never runs out of path.
  const span = Math.min(359, Math.max(40, (0.8 * o.size * o.text.length * track / o.r) * 180 / Math.PI * 1.25 + 20));
  const path = axiArcPath(o.cx, o.cy, o.r, side, start, span);
  axiSurface(doc);
  const { CurvePathTextNodeDefinition } = require('/nodes.js');
  const { StoryDelta } = require('/storydelta.js');
  const { ParagraphAlignXType } = require('/paragraphatts.js');
  const sb = axiStyled(doc, { font: o.font, size: o.size, colour: o.colour, spacing: o.spacing }, false);
  sb.applyParagraphDelta(StoryDelta.createAlignX(ParagraphAlignXType.Centre));
  sb.addText(o.text);
  doc.addNode(CurvePathTextNodeDefinition.createFromStoryBuilder(path, sb));
  return axiName(doc.selection.nodes.first, o.name);
}

// Promo seal: burst, ring, arc texts and stacked centre lines. See the index.
// Radii: the burst reaches r, its valleys sit at r - depth*r (the ring disc);
// the stroked inner circle is inset px further in; the top text has its baseline
// at textR = ring - inset - size and the bottom text is placed so both texts fill
// the same band (its baseline is a cap height further out); the centre lines are
// centred and shrunk to fit the free circle innerR.
function axiSeal(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiSeal: options {cx,cy,r,font} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.cx) || !fin(o.cy)) { throw new Error('axiSeal: cx and cy are required numbers'); }
  if (!fin(o.r) || !(o.r > 0)) { throw new Error('axiSeal: r is required and must be positive'); }
  const size = o.size === undefined ? Math.round(o.r * 0.13) : o.size;
  if (!fin(size) || !(size > 0)) { throw new Error('axiSeal: size must be positive'); }
  if (o.font !== undefined && (typeof o.font !== 'string' || o.font === '')) { throw new Error('axiSeal: font must be a postscript name'); }
  if (o.spacing !== undefined && !fin(o.spacing)) { throw new Error('axiSeal: spacing must be a number'); }
  const colour = o.colour || '#000000';
  const given = function (v) { return v !== undefined && v !== null && v !== false; };
  const arcLine = function (v, what) {
    if (!given(v)) { return null; }
    if (typeof v !== 'string' || v === '') { throw new Error('axiSeal: ' + what + ' must be a non-empty string'); }
    return v;
  };
  const top = arcLine(o.top, 'top');
  const bottom = arcLine(o.bottom, 'bottom');
  const lines = [];
  if (given(o.centre)) {
    (Array.isArray(o.centre) ? o.centre : [o.centre]).forEach(function (c, i) {
      const L = typeof c === 'string' ? { text: c } : c;
      if (!L || typeof L !== 'object' || typeof L.text !== 'string' || L.text === '') { throw new Error('axiSeal: centre line ' + i + ' needs text'); }
      const s = L.size === undefined ? size : L.size;
      if (!fin(s) || !(s > 0)) { throw new Error('axiSeal: centre line ' + i + ' size must be positive'); }
      lines.push({ text: L.text, font: L.font || o.font, size: s, colour: L.colour || colour });
    });
  }
  if (((top || bottom) && !o.font) || lines.some(function (l) { return !l.font; })) { throw new Error('axiSeal: font is required'); }
  let burst = null;
  if (given(o.burst)) {
    const b = o.burst === true ? {} : o.burst;
    if (typeof b !== 'object') { throw new Error('axiSeal: burst must be true, false or {points,depth,fill}'); }
    const points = b.points === undefined ? 24 : b.points;
    const depth = b.depth === undefined ? 0.12 : b.depth;
    if (!fin(points) || points < 3 || points > 120 || Math.floor(points) !== points) { throw new Error('axiSeal: burst.points must be a whole number 3..120'); }
    if (!fin(depth) || !(depth > 0) || depth > 0.5) { throw new Error('axiSeal: burst.depth must be above 0 and at most 0.5 (a fraction of r)'); }
    burst = { points: points, depth: depth, fill: b.fill || colour };
  }
  let ring = null;
  if (given(o.ring)) {
    const g = o.ring === true ? {} : o.ring;
    if (typeof g !== 'object') { throw new Error('axiSeal: ring must be true, false or {fill,stroke,strokeWidth,inset}'); }
    const inset = g.inset === undefined ? Math.round(o.r * 0.07) : g.inset;
    if (!fin(inset) || inset < 0) { throw new Error('axiSeal: ring.inset must be 0 or more'); }
    const sw = g.strokeWidth === undefined ? 3 : g.strokeWidth;
    if (!fin(sw) || !(sw > 0)) { throw new Error('axiSeal: ring.strokeWidth must be positive'); }
    ring = { fill: g.fill, stroke: g.stroke || (g.fill ? undefined : colour), strokeWidth: sw, inset: inset };
  }
  const depthPx = burst ? o.r * burst.depth : 0;
  const ringR = o.r - depthPx;
  const inset = ring ? ring.inset : 0;
  const textR = ringR - inset - size;
  const cap = 0.72 * size;
  if ((top || bottom) && !(textR > cap)) { throw new Error('axiSeal: size ' + size + ' is too large for r ' + o.r + ' with this burst and ring; lower size, inset or depth'); }
  const innerR = top || bottom ? textR - 0.25 * size : ringR - inset - 0.1 * o.r;
  // Centre block: first cap top to last baseline, centred on cy; each following baseline is 1.15 x its own size further down.
  let blockH = 0;
  lines.forEach(function (l, i) { blockH += i === 0 ? 0.72 * l.size : 1.15 * l.size; });
  const bases = [];
  let y = o.cy - blockH / 2;
  lines.forEach(function (l, i) {
    y += i === 0 ? 0.72 * l.size : 1.15 * l.size;
    const reach = Math.max(Math.abs(y - 0.72 * l.size - o.cy), Math.abs(y + 0.2 * l.size - o.cy));
    const room = innerR * innerR - reach * reach;
    if (!(room > 0)) { throw new Error('axiSeal: centre line ' + i + ' does not fit inside the seal; lower its size or raise r'); }
    bases.push({ y: y, maxW: 2 * Math.sqrt(room) });
  });

  const part = function (suffix) { return o.name === undefined || o.name === null ? undefined : o.name + '-' + suffix; };
  const nodes = { burst: null, ring: null, ringInner: null, top: null, bottom: null, centre: [] };
  if (burst) {
    axiSurface(doc);
    const { ShapeStar } = require('/shapes.js');
    const { ShapeNodeDefinition } = require('/nodes.js');
    const s = ShapeStar.create();
    s.points = burst.points;
    const cap2 = typeof s.maxInnerRadius === 'number' ? s.maxInnerRadius * 0.999 : 1;
    s.innerRadius = Math.min(1 - burst.depth, cap2);
    doc.addNode(ShapeNodeDefinition.create(s, { x: o.cx - o.r, y: o.cy - o.r, width: 2 * o.r, height: 2 * o.r }, axiHex(burst.fill), null, null));
    nodes.burst = axiName(doc.selection.nodes.first, part('burst'));
  }
  if (ring && ring.fill) {
    nodes.ring = axiEllipse(doc, { x: o.cx - ringR, y: o.cy - ringR, w: 2 * ringR, h: 2 * ringR, fill: ring.fill, name: part('ring') });
  }
  if (ring && ring.stroke) {
    const ir = ringR - inset;
    if (!(ir > 0)) { throw new Error('axiSeal: ring.inset leaves no inner circle'); }
    nodes.ringInner = axiEllipse(doc, { x: o.cx - ir, y: o.cy - ir, w: 2 * ir, h: 2 * ir, stroke: ring.stroke, strokeWidth: ring.strokeWidth, name: part('ring-inner') });
  }
  if (top) {
    nodes.top = axiArcText(doc, { cx: o.cx, cy: o.cy, r: textR, text: top, font: o.font, size: size, colour: colour, spacing: o.spacing, start: 0, side: 'top', name: part('top') });
  }
  let straightBottom = null;
  if (bottom) {
    try {
      nodes.bottom = axiArcText(doc, { cx: o.cx, cy: o.cy, r: textR + cap, text: bottom, font: o.font, size: size, colour: colour, spacing: o.spacing, start: 180, side: 'bottom', name: part('bottom') });
    } catch (e) {
      if (String(e && e.message).indexOf('not supported on this build') < 0) { throw e; }
      straightBottom = bottom;
    }
  }
  lines.forEach(function (l, i) {
    nodes.centre.push(axiText(doc, { x: o.cx, y: bases[i].y, text: l.text, font: l.font, size: l.size, colour: l.colour, spacing: o.spacing, align: 'c', maxW: bases[i].maxW, name: part('centre-' + i) }));
  });
  if (straightBottom !== null) {
    nodes.bottom = axiText(doc, { x: o.cx, y: o.cy + blockH / 2 + 1.15 * size, text: straightBottom, font: o.font, size: size, colour: colour, spacing: o.spacing, align: 'c', name: part('bottom') });
  }
  return { r: o.r, textR: textR, innerR: innerR, nodes: nodes };
}
`;
