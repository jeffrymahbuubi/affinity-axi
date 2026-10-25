// Multi-series chart helpers for run --with-helpers: axiGroupedBars, axiStackedBars,
// axiLine, axiLegend. Same rules as helpers-core.ts (function declarations prefixed
// axi, requires inside functions, nothing blocking or generative, String.raw so no
// backticks, dollar-brace or backslash surprises). Charts 1 (helpers-charts.ts) is
// spliced before this file and its axiChartColour is called here, never redeclared;
// bars, rules, dots and legend swatches are axiRect / axiEllipse, text is axiText.
//
// Lines are open stroked polylines: a CurveBuilder polyline (beginXY, then lineToXY
// per point) wrapped in a PolyCurve and drawn with PolyCurveNodeDefinition.create.
// Probed live on 3.3.1.4940 (test/live/polyline-probe.js): the brush and the
// transparency fill must be FillDescriptor.createNone() (null throws, the wrapper
// reads .handle), the pen is FillDescriptor.createSolid(colour) and the style a
// LineStyleDescriptor; the default cap and join are round.
//
// Validation runs before any require() and before any node is added, so a bad
// option throws without touching the document.

import type { HelperInfo } from "./helpers-core.js";

export const CHARTS2_INDEX: readonly HelperInfo[] = [
  {
    name: "axiGroupedBars",
    signature: "axiGroupedBars(doc, {x,y,w,h,series,labels,colours,gap,inner,radius,max,labelFont,labelSize,labelColour,valueLabels,name})",
    summary:
      "grouped bar chart in the box x,y,w,h: one cluster per category, one bar per series. series is 2-6 of {name, values, colour} with equal-length non-negative values; a series without colour takes colours[i] (one of the two is required). labels (one per category, under each cluster) and valueLabels:true need labelFont; labelSize defaults to half the pitch up to 32. gap is the empty share of each category pitch (default 0.25), inner the share of the cluster between bars (default 0.08), radius rounds the bars; max defaults to the largest value (a value above max throws). Names <name>-s<i>-bar-<j>, -label-<j>, -value-s<i>-<j>. Returns {nodes:{bars,labels,values},max}; bars[i][j] and values[i][j] are indexed series then category, a zero value has a null bar",
  },
  {
    name: "axiStackedBars",
    signature: "axiStackedBars(doc, {x,y,w,h,series,labels,colours,gap,radius,max,percent,labelFont,labelSize,labelColour,name})",
    summary:
      "stacked bar chart in the box x,y,w,h: one column per category, segments stacked from the baseline in series order (2-6 series, as axiGroupedBars). max defaults to the largest column total (a total above max throws); percent:true scales every column to the full height (max 100). radius rounds the top segment only. gap defaults to 0.25. Names <name>-s<i>-seg-<j>, -label-<j>. Returns {nodes:{segments,labels},max,totals}; segments[i][j] is null for a zero value, totals are the raw column sums",
  },
  {
    name: "axiLine",
    signature: "axiLine(doc, {x,y,w,h,series,labels,colours,max,min,stroke,dots,grid,gridWeight,labelFont,labelSize,labelColour,name})",
    summary:
      "line chart in the box x,y,w,h: one stroked polyline per series (1-6, each with at least 2 values), points at the category centres so labels line up like bar labels. min defaults to 0 and max to the largest value (a value outside min..max throws); stroke is the line width (default 4); dots is a dot radius (default 0, none); grid is a count of horizontal rules at equal steps up to max (the last sits at max, default 0) drawn first in labelColour at 20% alpha, gridWeight px high (default 1). labels need labelFont. Names <name>-s<i>-line, -s<i>-dot-<j>, -grid-<k>, -label-<j>. Returns {nodes:{lines,dots,grid,labels},max,min}; dots[i][j]",
  },
  {
    name: "axiLegend",
    signature: "axiLegend(doc, {x,y,items,colours,font,size,colour,swatch,gap,columns,name})",
    summary:
      "legend of square swatches with labels, top-left at x,y. items is [{label, colour}] or the series array of the other chart helpers (name is the label); a missing colour takes colours[i]. font is required, size is the text size (default 28), swatch the square side (default size), gap the px between rows (default 0.5 x size), columns splits the items evenly, filled down each column (default 1). Names <name>-swatch-<i>, -label-<i>. Returns {nodes:{swatches,labels},w,h}: the measured size of the whole legend",
  },
];

/** Internal building blocks, not in the index. */
export const CHARTS2_INTERNAL: readonly string[] = ["axiSeriesCheck", "axiPolyline"];

export const CHARTS2_SOURCE: string = String.raw`
/* ---- multi-series chart helpers ---- */

// Internal: the checks every series chart shares, before anything is drawn.
// Needs the box x,y,w,h, series (lim.minSeries to lim.maxSeries entries of
// {name, values, colour} with equal-length, non-empty, non-negative values), one
// colour per series (its own colour, else colours[i], through axiChartColour),
// and labels (one per category) with labelFont. Returns {n, m, series:[{name,
// values, colour}]}: n series over m categories. who is the helper name.
function axiSeriesCheck(o, who, lim) {
  if (!o || typeof o !== 'object') { throw new Error(who + ': options {x,y,w,h,series} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.x) || !fin(o.y)) { throw new Error(who + ': x and y are required numbers'); }
  if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error(who + ': w and h are required and must be positive'); }
  if (!Array.isArray(o.series) || o.series.length < lim.minSeries || o.series.length > lim.maxSeries) {
    throw new Error(who + ': series must be an array of ' + lim.minSeries + ' to ' + lim.maxSeries + ' entries');
  }
  const m = o.series[0] && Array.isArray(o.series[0].values) ? o.series[0].values.length : 0;
  const series = o.series.map(function (s, i) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.values) || s.values.length === 0) { throw new Error(who + ': series ' + i + ' needs a non-empty values array'); }
    if (s.values.length !== m) { throw new Error(who + ': series ' + i + ' has ' + s.values.length + ' values but series 0 has ' + m + ' (all series need the same length)'); }
    s.values.forEach(function (v, j) {
      if (!fin(v) || v < 0) { throw new Error(who + ': series ' + i + ' value ' + j + ' must be a number of 0 or more (got ' + JSON.stringify(v) + ')'); }
    });
    return { name: s.name !== undefined && s.name !== null ? String(s.name) : 'Series ' + (i + 1), values: s.values, colour: axiChartColour({ colours: s.colour ? [s.colour] : o.colours }, i, who) };
  });
  if (o.labels !== undefined && (!Array.isArray(o.labels) || o.labels.length !== m)) { throw new Error(who + ': labels must be an array with one entry per category (' + m + ')'); }
  if ((o.labels || o.valueLabels) && typeof o.labelFont !== 'string') { throw new Error(who + ': labelFont is required when labels or valueLabels are used'); }
  if (o.labelSize !== undefined && (!fin(o.labelSize) || !(o.labelSize > 0))) { throw new Error(who + ': labelSize must be positive'); }
  if (o.labelColour !== undefined) { axiChartColour({ colour: o.labelColour }, 0, who); }
  return { n: series.length, m: m, series: series };
}

// Internal: an open stroked polyline through points ([x,y] or {x,y}, at least 2) in
// the given stroke hex colour and width, named when name is given. The brush and
// transparency fills are FillDescriptor.createNone() (null throws). Ends with a
// plain lineToXY per point, never a closing call. Returns the node.
function axiPolyline(doc, points, o) {
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!Array.isArray(points) || points.length < 2) { throw new Error('axiPolyline: at least 2 points are required'); }
  const pts = points.map(function (p, i) {
    const x = Array.isArray(p) ? p[0] : (p && p.x);
    const y = Array.isArray(p) ? p[1] : (p && p.y);
    if (!fin(x) || !fin(y)) { throw new Error('axiPolyline: point ' + i + ' needs numbers x and y'); }
    return [x, y];
  });
  if (!o || typeof o.stroke !== 'string') { throw new Error('axiPolyline: stroke (a hex colour) is required'); }
  const width = o.width === undefined ? 4 : o.width;
  if (!fin(width) || !(width > 0)) { throw new Error('axiPolyline: width must be positive'); }
  axiSurface(doc);
  const { CurveBuilder, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const { FillDescriptor } = require('/fills.js');
  const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
  const b = new CurveBuilder().beginXY(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) { b.lineToXY(pts[i][0], pts[i][1]); }
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  const none = FillDescriptor.createNone();
  doc.addNode(PolyCurveNodeDefinition.create(pc, none, FillDescriptor.createSolid(axiHex(o.stroke)), LineStyleDescriptor.create(LineStyle.create({ weight: width })), none));
  return axiName(doc.selection.nodes.first, o.name);
}

// Grouped bars: category pitch w/m, cluster width pitch*(1-gap), bars inside a
// cluster separated by inner*cluster. Bars grow up from y + h.
function axiGroupedBars(doc, o) {
  const chk = axiSeriesCheck(o, 'axiGroupedBars', { minSeries: 2, maxSeries: 6 });
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const n = chk.n;
  const m = chk.m;
  const gap = o.gap === undefined ? 0.25 : o.gap;
  if (!fin(gap) || gap < 0 || gap >= 1) { throw new Error('axiGroupedBars: gap must be 0 or more and less than 1 (got ' + o.gap + ')'); }
  const inner = o.inner === undefined ? 0.08 : o.inner;
  if (!fin(inner) || inner < 0 || (n - 1) * inner >= 1) { throw new Error('axiGroupedBars: inner must be 0 or more and leave room for ' + n + ' bars (got ' + o.inner + ')'); }
  const radius = o.radius === undefined ? 0 : o.radius;
  if (!fin(radius) || radius < 0) { throw new Error('axiGroupedBars: radius must be 0 or more'); }
  let top = 0;
  chk.series.forEach(function (s) { s.values.forEach(function (v) { if (v > top) { top = v; } }); });
  const max = o.max === undefined ? top : o.max;
  if (!fin(max) || !(max > 0)) { throw new Error('axiGroupedBars: max must be a positive number (all values are 0, so pass max)'); }
  if (top > max) { throw new Error('axiGroupedBars: value ' + top + ' is above max ' + max); }

  const pitch = o.w / m;
  const group = pitch * (1 - gap);
  const between = inner * group;
  const bw = (group - (n - 1) * between) / n;
  const size = o.labelSize === undefined ? Math.min(32, Math.round(pitch * 0.5)) : o.labelSize;
  const vsize = o.labelSize === undefined ? Math.min(size, Math.max(10, Math.round(bw * 0.6))) : o.labelSize;
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const num = function (v) { return String(Math.round(v * 100) / 100); };
  const out = { bars: [], labels: [], values: [] };
  const left = function (j, i) { return o.x + j * pitch + (pitch - group) / 2 + i * (bw + between); };
  chk.series.forEach(function (s, i) {
    const row = [];
    s.values.forEach(function (v, j) {
      const len = o.h * v / max;
      row.push(len > 0 ? axiRect(doc, { x: left(j, i), y: o.y + o.h - len, w: bw, h: len, fill: s.colour, radius: radius || undefined, name: nm('s' + i + '-bar-' + j) }) : null);
    });
    out.bars.push(row);
  });
  if (o.labels) {
    o.labels.forEach(function (l, j) {
      if (l === undefined || l === null || l === '') { out.labels.push(null); return; }
      out.labels.push(axiText(doc, { x: o.x + j * pitch + pitch / 2, y: o.y + o.h + size * 1.35, text: String(l), font: o.labelFont, size: size, colour: o.labelColour, align: 'c', maxW: pitch * 0.95, name: nm('label-' + j) }));
    });
  }
  if (o.valueLabels) {
    chk.series.forEach(function (s, i) {
      const row = [];
      s.values.forEach(function (v, j) {
        row.push(axiText(doc, { x: left(j, i) + bw / 2, y: o.y + o.h - o.h * v / max - vsize * 0.4, text: num(v), font: o.labelFont, size: vsize, colour: o.labelColour, align: 'c', name: nm('value-s' + i + '-' + j) }));
      });
      out.values.push(row);
    });
  }
  return { nodes: out, max: max };
}

// Stacked bars: segments stack from y + h in series order. The top non-zero
// segment of a column takes the radius: it is drawn first as a rounded rect that
// reaches radius px into the segment below, and the squared lower segments are
// drawn over that reach, so only its top corners show.
function axiStackedBars(doc, o) {
  const chk = axiSeriesCheck(o, 'axiStackedBars', { minSeries: 2, maxSeries: 6 });
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const n = chk.n;
  const m = chk.m;
  const gap = o.gap === undefined ? 0.25 : o.gap;
  if (!fin(gap) || gap < 0 || gap >= 1) { throw new Error('axiStackedBars: gap must be 0 or more and less than 1 (got ' + o.gap + ')'); }
  const radius = o.radius === undefined ? 0 : o.radius;
  if (!fin(radius) || radius < 0) { throw new Error('axiStackedBars: radius must be 0 or more'); }
  const percent = o.percent === true;
  const totals = [];
  for (let j = 0; j < m; j += 1) { totals.push(chk.series.reduce(function (a, s) { return a + s.values[j]; }, 0)); }
  const top = Math.max.apply(null, totals);
  let max = 100;
  if (!percent) {
    max = o.max === undefined ? top : o.max;
    if (!fin(max) || !(max > 0)) { throw new Error('axiStackedBars: max must be a positive number (all values are 0, so pass max)'); }
    if (top > max) { throw new Error('axiStackedBars: column total ' + top + ' is above max ' + max); }
  }
  const pitch = o.w / m;
  const cw = pitch * (1 - gap);
  const size = o.labelSize === undefined ? Math.min(32, Math.round(pitch * 0.5)) : o.labelSize;
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const out = { segments: [], labels: [] };
  chk.series.forEach(function () { out.segments.push([]); });
  for (let j = 0; j < m; j += 1) {
    const cx = o.x + j * pitch + (pitch - cw) / 2;
    const heights = chk.series.map(function (s) { return percent ? (totals[j] > 0 ? o.h * s.values[j] / totals[j] : 0) : o.h * s.values[j] / max; });
    const tops = [];
    let cum = 0;
    heights.forEach(function (hh) { tops.push(o.y + o.h - cum - hh); cum += hh; });
    let topIdx = -1;
    heights.forEach(function (hh, i) { if (hh > 0) { topIdx = i; } });
    const draw = function (i) {
      if (!(heights[i] > 0)) { out.segments[i][j] = null; return; }
      const round = radius > 0 && i === topIdx;
      const below = heights.slice(0, i).reduce(function (a, hh) { return a + hh; }, 0);
      const reach = round ? Math.min(radius, heights[i], below) : 0;
      out.segments[i][j] = axiRect(doc, { x: cx, y: tops[i], w: cw, h: heights[i] + reach, fill: chk.series[i].colour, radius: round ? radius : undefined, name: nm('s' + i + '-seg-' + j) });
    };
    if (topIdx >= 0) { draw(topIdx); }
    for (let i = 0; i < n; i += 1) { if (i !== topIdx) { draw(i); } }
  }
  if (o.labels) {
    o.labels.forEach(function (l, j) {
      if (l === undefined || l === null || l === '') { out.labels.push(null); return; }
      out.labels.push(axiText(doc, { x: o.x + j * pitch + pitch / 2, y: o.y + o.h + size * 1.35, text: String(l), font: o.labelFont, size: size, colour: o.labelColour, align: 'c', maxW: pitch * 0.95, name: nm('label-' + j) }));
    });
  }
  return { nodes: out, max: max, totals: totals };
}

// Line chart: value v maps to y + h - (v - min) / (max - min) * h, category j to
// the centre of its pitch. Grid rules come first (under everything), then each
// series' polyline followed by its dots, then the labels.
function axiLine(doc, o) {
  const chk = axiSeriesCheck(o, 'axiLine', { minSeries: 1, maxSeries: 6 });
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const m = chk.m;
  if (m < 2) { throw new Error('axiLine: each series needs at least 2 values'); }
  const stroke = o.stroke === undefined ? 4 : o.stroke;
  if (!fin(stroke) || !(stroke > 0)) { throw new Error('axiLine: stroke must be a positive width'); }
  const dots = o.dots === undefined ? 0 : o.dots;
  if (!fin(dots) || dots < 0) { throw new Error('axiLine: dots must be a radius of 0 or more'); }
  const grid = o.grid === undefined ? 0 : o.grid;
  if (!fin(grid) || grid < 0 || Math.floor(grid) !== grid) { throw new Error('axiLine: grid must be a whole number of rules (0 or more)'); }
  const gridWeight = o.gridWeight === undefined ? 1 : o.gridWeight;
  if (!fin(gridWeight) || !(gridWeight > 0)) { throw new Error('axiLine: gridWeight must be positive'); }
  const min = o.min === undefined ? 0 : o.min;
  if (!fin(min)) { throw new Error('axiLine: min must be a number'); }
  let lo = Infinity;
  let top = 0;
  chk.series.forEach(function (s) { s.values.forEach(function (v) { if (v > top) { top = v; } if (v < lo) { lo = v; } }); });
  const max = o.max === undefined ? top : o.max;
  if (!fin(max) || !(max > min)) { throw new Error('axiLine: max must be a number above min ' + min + (o.max === undefined ? ' (pass max)' : '')); }
  if (top > max) { throw new Error('axiLine: value ' + top + ' is above max ' + max); }
  if (lo < min) { throw new Error('axiLine: value ' + lo + ' is below min ' + min); }

  const pitch = o.w / m;
  const size = o.labelSize === undefined ? Math.min(32, Math.round(pitch * 0.5)) : o.labelSize;
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const px = function (j) { return o.x + j * pitch + pitch / 2; };
  const py = function (v) { return o.y + o.h - (v - min) / (max - min) * o.h; };
  const out = { lines: [], dots: [], grid: [], labels: [] };
  for (let k = 0; k < grid; k += 1) {
    const gy = o.y + o.h - o.h * (k + 1) / grid;
    out.grid.push(axiRect(doc, { x: o.x, y: gy - gridWeight / 2, w: o.w, h: gridWeight, fill: o.labelColour || '#000000', fillAlpha: 0.2, name: nm('grid-' + k) }));
  }
  chk.series.forEach(function (s, i) {
    out.lines.push(axiPolyline(doc, s.values.map(function (v, j) { return [px(j), py(v)]; }), { stroke: s.colour, width: stroke, name: nm('s' + i + '-line') }));
    const row = [];
    if (dots > 0) {
      s.values.forEach(function (v, j) {
        row.push(axiEllipse(doc, { x: px(j) - dots, y: py(v) - dots, w: 2 * dots, h: 2 * dots, fill: s.colour, name: nm('s' + i + '-dot-' + j) }));
      });
    }
    out.dots.push(row);
  });
  if (o.labels) {
    o.labels.forEach(function (l, j) {
      if (l === undefined || l === null || l === '') { out.labels.push(null); return; }
      out.labels.push(axiText(doc, { x: px(j), y: o.y + o.h + size * 1.35, text: String(l), font: o.labelFont, size: size, colour: o.labelColour, align: 'c', maxW: pitch * 0.95, name: nm('label-' + j) }));
    });
  }
  return { nodes: out, max: max, min: min };
}

// Legend: rows of a square swatch and a label, filled down each column. The
// size comes from measuring the labels: w from the left edge x to the right-most
// label, h from the first row top to the last row bottom.
function axiLegend(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiLegend: options {x,y,items,font} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.x) || !fin(o.y)) { throw new Error('axiLegend: x and y are required numbers'); }
  if (!Array.isArray(o.items) || o.items.length === 0) { throw new Error('axiLegend: items must be a non-empty array of {label, colour}'); }
  if (typeof o.font !== 'string') { throw new Error('axiLegend: font is required'); }
  const size = o.size === undefined ? 28 : o.size;
  if (!fin(size) || !(size > 0)) { throw new Error('axiLegend: size must be positive'); }
  const swatch = o.swatch === undefined ? size : o.swatch;
  if (!fin(swatch) || !(swatch > 0)) { throw new Error('axiLegend: swatch must be positive'); }
  const gap = o.gap === undefined ? size * 0.5 : o.gap;
  if (!fin(gap) || gap < 0) { throw new Error('axiLegend: gap must be 0 or more'); }
  const columns = o.columns === undefined ? 1 : o.columns;
  if (!fin(columns) || Math.floor(columns) !== columns || columns < 1 || columns > o.items.length) { throw new Error('axiLegend: columns must be a whole number from 1 to ' + o.items.length); }
  if (o.colour !== undefined) { axiChartColour({ colour: o.colour }, 0, 'axiLegend'); }
  const items = o.items.map(function (it, i) {
    const label = it && (it.label !== undefined && it.label !== null ? it.label : it.name);
    if (!it || typeof it !== 'object' || label === undefined || label === null || label === '') { throw new Error('axiLegend: item ' + i + ' needs a label'); }
    return { label: String(label), colour: axiChartColour({ colours: it.colour ? [it.colour] : o.colours }, i, 'axiLegend') };
  });
  const nm = function (part, i) { return o.name ? o.name + '-' + part + '-' + i : undefined; };
  const rows = Math.ceil(items.length / columns);
  const rowH = Math.max(swatch, size);
  const out = { swatches: [], labels: [] };
  let colX = o.x;
  let right = o.x;
  for (let c = 0; c < columns; c += 1) {
    let colRight = colX;
    for (let r = 0; r < rows; r += 1) {
      const i = c * rows + r;
      if (i >= items.length) { break; }
      const top = o.y + r * (rowH + gap);
      out.swatches.push(axiRect(doc, { x: colX, y: top + (rowH - swatch) / 2, w: swatch, h: swatch, fill: items[i].colour, name: nm('swatch', i) }));
      out.labels.push(axiText(doc, { x: colX + swatch + size * 0.5, y: top + rowH / 2 + size * 0.35, text: items[i].label, font: o.font, size: size, colour: o.colour, align: 'l', name: nm('label', i) }));
      const b = axiMeasure(doc);
      colRight = Math.max(colRight, b.x + b.w);
    }
    right = Math.max(right, colRight);
    colX = colRight + size * 1.5;
  }
  return { nodes: out, w: right - o.x, h: rows * rowH + (rows - 1) * gap };
}
`;
