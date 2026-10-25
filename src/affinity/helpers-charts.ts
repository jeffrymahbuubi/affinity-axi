// Chart helpers for run --with-helpers: axiBars, axiDonut, axiProgress. Same
// rules as helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks,
// dollar-brace or backslash surprises).
//
// Bars and progress are axiRect nodes. Slices are ShapePie nodes set up before
// ShapeNodeDefinition.create (the way axiQR configures its shape): startAngle,
// then sweep, then innerRadius (Affinity's own hint says startAngle first and
// never closePie()). Probed live on 3.3.1.4940 (test/live/pie-probe.js):
//   - the three properties survive creation, so no doc.setShape fallback;
//   - the node box is the full bounding square of the circle, however small
//     the slice, so the rect passed to create() is {cx-r, cy-r, 2r, 2r};
//   - a sweep of 2*PI renders a full ring, and innerRadius is a 0-1 fraction;
//   - the angle runs the opposite way on screen from the SDK hint: a slice
//     drawn with startAngle s and sweep w covers the screen-clockwise interval
//     [-(s+w), -s] measured from 3 o'clock. axiPieSlice therefore takes the
//     screen angle (radians, 0 = 3 o'clock, clockwise) and converts.
//
// Validation runs before any require() and before any node is added, so a bad
// option throws without touching the document.

import type { HelperInfo } from "./helpers-core.js";

export const CHARTS_INDEX: readonly HelperInfo[] = [
  {
    name: "axiBars",
    signature: "axiBars(doc, {x,y,w,h,values,labels,colours,colour,gap,radius,max,horizontal,labelFont,labelSize,labelColour,valueLabels,name})",
    summary:
      "bar chart in the box x,y,w,h (the bars only; labels sit outside it, under each bar or left of it when horizontal). values: non-negative numbers or {value,label,colour}; max defaults to the largest value (a value above max throws); colours cycles per bar, else colour is used for all (one is required); gap is the share of each pitch left empty (default 0.3); radius rounds the bars; horizontal grows bars to the right from x. labels (one per bar) and valueLabels:true need labelFont; labelSize defaults to half the pitch up to 32. Names <name>-bar-<i>, -label-<i>, -value-<i>. Returns {nodes:{bars,labels,values},max}; a zero value has a null bar",
  },
  {
    name: "axiDonut",
    signature: "axiDonut(doc, {cx,cy,r,inner,values,colours,start,gap,label,name})",
    summary:
      "donut or pie of ShapePie slices around cx,cy with radius r. values must be positive numbers; colours (at least one) cycles; inner is the hole as a fraction of r, 0 to 0.95 (default 0.6, 0 is a pie); start is degrees clockwise from 12 o'clock (default 0); gap removes degrees from each slice (ignored for a single value, which is a full ring). label {text, sub, font, size, colour, subFont, subSize} draws a centred value and caption in the hole. Names <name>-slice-<i>, -label, -sub. Returns {nodes:{slices,label,sub},total}",
  },
  {
    name: "axiProgress",
    signature: "axiProgress(doc, {x,y,w,h,value,max,track,fill,radius,label,font,size,labelColour,ring,name})",
    summary:
      "progress as a bar (track plus fill of width w*fraction) or, with ring:{cx,r,cy,inner}, a ring of two ShapePie slices (inner default 0.8). fraction is value/max clamped to 0-1 (max defaults to 1, so pass max:100 for percentages); track is optional, fill (or colour) is required. label: a string, {text,font,size,colour}, false for none; by default the percentage is drawn when a font is given (label.font or font). In a bar it sits right of the fill if there is room, else inside the fill; in a ring it is centred. Names <name>-track, -fill, -label. Returns {nodes:{track,fill,label},fraction}",
  },
];

/** Internal building blocks, not in the index. */
export const CHARTS_INTERNAL: readonly string[] = ["axiPieSlice", "axiChartColour"];

export const CHARTS_SOURCE: string = String.raw`
/* ---- chart helpers ---- */

// Internal: the validated hex colour for item i of a chart: colours[i % n],
// else the single colour, else a throw. Checks the format itself so that
// validation can run before any SDK module is loaded. who is the helper name.
function axiChartColour(o, i, who) {
  let c;
  if (Array.isArray(o.colours) && o.colours.length > 0) { c = o.colours[i % o.colours.length]; }
  else if (o.colour !== undefined) { c = o.colour; }
  else { throw new Error(who + ': colours (an array) or colour (one hex) is required'); }
  if (typeof c !== 'string' || !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) { throw new Error(who + ': colour must be a hex string (got ' + JSON.stringify(c) + ')'); }
  return c;
}

// Internal: one pie slice (or a ring when inner > 0) centred on cx,cy with
// radius r. startRad is the SCREEN angle in radians, 0 = 3 o'clock, growing
// clockwise (12 o'clock is -PI/2); sweepRad is positive and at most 2*PI (a
// full ring). Affinity measures the stored angle the other way round, so the
// shape gets startAngle = -(startRad + sweepRad), wrapped into [-PI, PI).
// Properties are set startAngle first, then sweep, then innerRadius, before
// the shape is created; the node box is the full bounding square. Returns the node.
function axiPieSlice(doc, cx, cy, r, inner, startRad, sweepRad, fill, name) {
  axiSurface(doc);
  const { ShapePie } = require('/shapes.js');
  const { ShapeNodeDefinition } = require('/nodes.js');
  const tau = 2 * Math.PI;
  const stored = -(startRad + sweepRad);
  const pie = ShapePie.create();
  pie.startAngle = stored - tau * Math.floor((stored + Math.PI) / tau);
  pie.sweep = sweepRad;
  pie.innerRadius = inner;
  doc.addNode(ShapeNodeDefinition.create(pie, { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }, axiHex(fill), null, null));
  return axiName(doc.selection.nodes.first, name);
}

// Bar chart. The box x,y,w,h holds the bars; labels are placed outside it.
// Vertical bars grow up from y + h, horizontal bars grow right from x.
function axiBars(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiBars: options {x,y,w,h,values} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.x) || !fin(o.y)) { throw new Error('axiBars: x and y are required numbers'); }
  if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error('axiBars: w and h are required and must be positive'); }
  if (!Array.isArray(o.values) || o.values.length === 0) { throw new Error('axiBars: values must be a non-empty array'); }
  const n = o.values.length;
  const items = o.values.map(function (v, i) {
    const it = (v !== null && typeof v === 'object') ? v : { value: v };
    if (!fin(it.value) || it.value < 0) { throw new Error('axiBars: value ' + i + ' must be a number of 0 or more (got ' + JSON.stringify(it.value) + ')'); }
    return it;
  });
  const gap = o.gap === undefined ? 0.3 : o.gap;
  if (!fin(gap) || gap < 0 || gap >= 1) { throw new Error('axiBars: gap must be 0 or more and less than 1 (got ' + o.gap + ')'); }
  const radius = o.radius === undefined ? 0 : o.radius;
  if (!fin(radius) || radius < 0) { throw new Error('axiBars: radius must be 0 or more'); }
  const top = Math.max.apply(null, items.map(function (it) { return it.value; }));
  const max = o.max === undefined ? top : o.max;
  if (!fin(max) || !(max > 0)) { throw new Error('axiBars: max must be a positive number (all values are 0, so pass max)'); }
  if (top > max) { throw new Error('axiBars: value ' + top + ' is above max ' + max); }
  if (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.length !== n)) { throw new Error('axiBars: labels must be an array with one entry per value (' + n + ')'); }
  const colours = items.map(function (it, i) { return axiChartColour({ colours: it.colour ? [it.colour] : o.colours, colour: o.colour }, i, 'axiBars'); });
  const text = items.map(function (it, i) {
    const l = it.label !== undefined ? it.label : (o.labels ? o.labels[i] : undefined);
    return l === undefined || l === null || l === '' ? null : String(l);
  });
  const wantLabels = text.some(function (t) { return t !== null; });
  if ((wantLabels || o.valueLabels) && typeof o.labelFont !== 'string') { throw new Error('axiBars: labelFont is required when labels or valueLabels are used'); }

  const horizontal = o.horizontal === true;
  const pitch = (horizontal ? o.h : o.w) / n;
  const thick = pitch * (1 - gap);
  const size = o.labelSize === undefined ? Math.min(32, Math.round(pitch * 0.5)) : o.labelSize;
  if (!fin(size) || !(size > 0)) { throw new Error('axiBars: labelSize must be positive'); }
  const nm = function (part, i) { return o.name ? o.name + '-' + part + '-' + i : undefined; };
  const num = function (v) { return String(Math.round(v * 100) / 100); };
  const out = { bars: [], labels: [], values: [] };
  items.forEach(function (it, i) {
    const len = (horizontal ? o.w : o.h) * it.value / max;
    const bx = horizontal ? o.x : o.x + i * pitch + (pitch - thick) / 2;
    const by = horizontal ? o.y + i * pitch + (pitch - thick) / 2 : o.y + o.h - len;
    const bw = horizontal ? len : thick;
    const bh = horizontal ? thick : len;
    out.bars.push(len > 0 ? axiRect(doc, { x: bx, y: by, w: bw, h: bh, fill: colours[i], radius: radius || undefined, name: nm('bar', i) }) : null);
    const style = { font: o.labelFont, size: size, colour: o.labelColour };
    if (text[i] !== null) {
      out.labels.push(horizontal
        ? axiText(doc, { x: o.x - size * 0.6, y: by + thick / 2 + size * 0.35, text: text[i], font: style.font, size: size, colour: style.colour, align: 'r', name: nm('label', i) })
        : axiText(doc, { x: bx + thick / 2, y: o.y + o.h + size * 1.35, text: text[i], font: style.font, size: size, colour: style.colour, align: 'c', maxW: pitch * 0.95, name: nm('label', i) }));
    } else { out.labels.push(null); }
    if (o.valueLabels) {
      out.values.push(horizontal
        ? axiText(doc, { x: bx + bw + size * 0.5, y: by + thick / 2 + size * 0.35, text: num(it.value), font: style.font, size: size, colour: style.colour, align: 'l', name: nm('value', i) })
        : axiText(doc, { x: bx + thick / 2, y: by - size * 0.4, text: num(it.value), font: style.font, size: size, colour: style.colour, align: 'c', name: nm('value', i) }));
    }
  });
  return { nodes: out, max: max };
}

// Donut (inner > 0) or pie (inner 0). Slices run clockwise from 12 o'clock plus
// start degrees, each sweeping its share of the circle minus gap degrees.
function axiDonut(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiDonut: options {cx,cy,r,values,colours} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.cx) || !fin(o.cy)) { throw new Error('axiDonut: cx and cy are required numbers'); }
  if (!fin(o.r) || !(o.r > 0)) { throw new Error('axiDonut: r is required and must be positive'); }
  if (!Array.isArray(o.values) || o.values.length === 0) { throw new Error('axiDonut: values must be a non-empty array'); }
  o.values.forEach(function (v, i) {
    if (!fin(v) || !(v > 0)) { throw new Error('axiDonut: value ' + i + ' must be a number above 0 (got ' + JSON.stringify(v) + ')'); }
  });
  if (!Array.isArray(o.colours) || o.colours.length === 0) { throw new Error('axiDonut: colours must be a non-empty array of hex strings'); }
  const inner = o.inner === undefined ? 0.6 : o.inner;
  if (!fin(inner) || inner < 0 || inner >= 0.95) { throw new Error('axiDonut: inner must be 0 or more and less than 0.95 (got ' + o.inner + ')'); }
  const startDeg = o.start === undefined ? 0 : o.start;
  if (!fin(startDeg)) { throw new Error('axiDonut: start must be a number of degrees'); }
  const gapDeg = o.gap === undefined ? 0 : o.gap;
  if (!fin(gapDeg) || gapDeg < 0) { throw new Error('axiDonut: gap must be 0 or more degrees'); }
  const n = o.values.length;
  const total = o.values.reduce(function (a, b) { return a + b; }, 0);
  const tau = 2 * Math.PI;
  const gapRad = n > 1 ? gapDeg * Math.PI / 180 : 0;
  const sweeps = o.values.map(function (v) { return v / total * tau - gapRad; });
  sweeps.forEach(function (s) { if (!(s > 0)) { throw new Error('axiDonut: gap of ' + gapDeg + ' degrees leaves no room for the smallest slice'); } });
  const colours = o.values.map(function (v, i) { return axiChartColour({ colours: o.colours }, i, 'axiDonut'); });
  const L = o.label;
  if (L !== undefined && L !== null && L !== false) {
    if (typeof L !== 'object') { throw new Error('axiDonut: label must be {text, sub, font, size, colour}'); }
    if (typeof L.text !== 'string' || typeof L.font !== 'string') { throw new Error('axiDonut: label needs text and font'); }
    if (L.size !== undefined && (!fin(L.size) || !(L.size > 0))) { throw new Error('axiDonut: label size must be positive'); }
  }
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const slices = [];
  let at = -Math.PI / 2 + startDeg * Math.PI / 180;
  o.values.forEach(function (v, i) {
    slices.push(axiPieSlice(doc, o.cx, o.cy, o.r, inner, at, sweeps[i], colours[i], nm('slice-' + i)));
    at += v / total * tau;
  });
  let label = null;
  let sub = null;
  if (L) {
    const size = L.size === undefined ? Math.max(12, Math.round(o.r * inner * 0.55)) : L.size;
    const subSize = L.subSize === undefined ? Math.round(size * 0.4) : L.subSize;
    const maxW = 2 * o.r * Math.max(inner, 0.5) * 0.85;
    const hasSub = typeof L.sub === 'string' && L.sub !== '';
    const base = hasSub ? o.cy + size * 0.09 : o.cy + size * 0.35;
    label = axiText(doc, { x: o.cx, y: base, text: L.text, font: L.font, size: size, colour: L.colour, align: 'c', maxW: maxW, name: nm('label') });
    if (hasSub) {
      sub = axiText(doc, { x: o.cx, y: base + size * 0.25 + subSize * 0.72, text: L.sub, font: L.subFont || L.font, size: subSize, colour: L.colour, align: 'c', maxW: maxW, name: nm('sub') });
    }
  }
  return { nodes: { slices: slices, label: label, sub: sub }, total: total };
}

// Progress as a bar (default) or a ring. fraction = value / max, clamped to 0-1;
// max defaults to 1. A zero fraction draws no fill. The label is drawn when
// label is a string or object, or when a font is given and label is not false.
function axiProgress(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiProgress: options {value,fill} and a box or ring are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.value) || o.value < 0) { throw new Error('axiProgress: value must be a number of 0 or more'); }
  const max = o.max === undefined ? 1 : o.max;
  if (!fin(max) || !(max > 0)) { throw new Error('axiProgress: max must be a positive number'); }
  const fraction = Math.min(1, o.value / max);
  const fillCol = o.fill !== undefined ? o.fill : o.colour;
  if (fillCol === undefined) { throw new Error('axiProgress: fill (a hex colour) is required'); }
  axiChartColour({ colour: fillCol }, 0, 'axiProgress');
  if (o.track !== undefined && o.track !== null && o.track !== false) { axiChartColour({ colour: o.track }, 0, 'axiProgress'); }
  const hasTrack = o.track !== undefined && o.track !== null && o.track !== false;
  const ring = o.ring;
  if (ring) {
    if (typeof ring !== 'object' || !fin(ring.cx) || !fin(ring.cy) || !fin(ring.r) || !(ring.r > 0)) { throw new Error('axiProgress: ring needs numbers cx, cy and r (r above 0)'); }
    if (ring.inner !== undefined && (!fin(ring.inner) || ring.inner < 0 || ring.inner >= 0.95)) { throw new Error('axiProgress: ring inner must be 0 or more and less than 0.95'); }
  } else {
    if (!fin(o.x) || !fin(o.y)) { throw new Error('axiProgress: x and y are required numbers (or pass ring)'); }
    if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error('axiProgress: w and h are required and must be positive'); }
    if (o.radius !== undefined && (!fin(o.radius) || o.radius < 0)) { throw new Error('axiProgress: radius must be 0 or more'); }
  }
  let text = null;
  let lab = {};
  const L = o.label;
  if (L !== false && L !== null) {
    if (typeof L === 'string') { text = L; }
    else if (L !== undefined && typeof L === 'object') { lab = L; text = typeof L.text === 'string' ? L.text : Math.round(fraction * 100) + '%'; }
    else if (L !== undefined) { throw new Error('axiProgress: label must be a string, {text,font,size,colour} or false'); }
    const lf = lab.font || o.font;
    if (L === undefined) { if (typeof lf === 'string') { text = Math.round(fraction * 100) + '%'; } }
    else if (typeof lf !== 'string') { throw new Error('axiProgress: label needs a font (label.font or font)'); }
  }
  const font = lab.font || o.font;
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const out = { track: null, fill: null, label: null };

  if (ring) {
    const inner = ring.inner === undefined ? 0.8 : ring.inner;
    const tau = 2 * Math.PI;
    if (hasTrack) { out.track = axiPieSlice(doc, ring.cx, ring.cy, ring.r, inner, -Math.PI / 2, tau, o.track, nm('track')); }
    if (fraction > 0) { out.fill = axiPieSlice(doc, ring.cx, ring.cy, ring.r, inner, -Math.PI / 2, fraction * tau, fillCol, nm('fill')); }
    if (text !== null) {
      const size = lab.size !== undefined ? lab.size : (o.size !== undefined ? o.size : Math.max(12, Math.round(ring.r * inner * 0.5)));
      out.label = axiText(doc, { x: ring.cx, y: ring.cy + size * 0.35, text: text, font: font, size: size, colour: lab.colour || o.labelColour, align: 'c', maxW: 2 * ring.r * Math.max(inner, 0.5) * 0.85, name: nm('label') });
    }
    return { nodes: out, fraction: fraction };
  }

  if (hasTrack) { out.track = axiRect(doc, { x: o.x, y: o.y, w: o.w, h: o.h, fill: o.track, radius: o.radius || undefined, name: nm('track') }); }
  const fw = o.w * fraction;
  if (fw > 0) { out.fill = axiRect(doc, { x: o.x, y: o.y, w: fw, h: o.h, fill: fillCol, radius: o.radius || undefined, name: nm('fill') }); }
  if (text !== null) {
    const size = lab.size !== undefined ? lab.size : (o.size !== undefined ? o.size : Math.max(10, Math.min(32, Math.round(o.h * 0.6))));
    const pad = size * 0.5;
    const base = o.y + o.h / 2 + size * 0.35;
    const node = axiText(doc, { x: o.x + fw + pad, y: base, text: text, font: font, size: size, colour: lab.colour || o.labelColour, align: 'l', name: nm('label') });
    const b = axiMeasure(doc);
    if (b.x + b.w > o.x + o.w) {
      // No room right of the fill: right-align inside the fill, or centre in the track when the fill is too short.
      const inside = fw - pad - b.w >= 0;
      axiMove(doc, inside ? o.x + fw - pad - (b.x + b.w) : o.x + o.w / 2 - (b.x + b.w / 2), 0);
    }
    out.label = node;
  }
  return { nodes: out, fraction: fraction };
}
`;
