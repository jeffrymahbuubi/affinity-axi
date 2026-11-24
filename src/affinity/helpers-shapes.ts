// Shape helpers for run --with-helpers: polygons, bezier paths, pie wedges,
// rotation of any node, and the two-circle lens. Same rules as helpers-core.ts
// (function declarations prefixed axi, requires inside functions, validation
// before the first require, String.raw so no backticks, dollar-brace or
// backslash surprises).
//
// Probe result (Affinity 3.3.3.5004, test/live/vector-probe.js): a polygon ended
// with a plain lineToXY back to its start fills with no outline; addBezierXY
// works; rotation through DocumentCommand.createTransform works on shapes,
// boolean results and text. The polygon is closed with that final lineToXY
// (the run guard rejects the CurveBuilder close call).

import type { HelperInfo } from "./helpers-core.js";

export const SHAPES_INDEX: readonly HelperInfo[] = [
  { name: "axiPolygon", signature: "axiPolygon(doc, points, {fill, fillAlpha, stroke, strokeWidth, closed, name})", summary: "filled and/or stroked polygon through points ([x,y] or {x,y} in document px; at least 3, or 2 with closed:false which needs stroke); fill or stroke is required, strokeWidth defaults to 2, fillAlpha 0-1; closed defaults to true; combine with axiBool subtract to cut notches and holes; returns the node" },
  { name: "axiPath", signature: "axiPath(doc, segments, {fill, fillAlpha, stroke, strokeWidth, name})", summary: "one subpath in document px: segments[0] is ['M',x,y], then ['L',x,y] or ['C',c1x,c1y,c2x,c2y,x,y] (cubic bezier), optionally a last ['Z'] that returns to the start; fill or stroke is required; returns the node" },
  { name: "axiWedge", signature: "axiWedge(doc, {cx, cy, r, start, sweep, inner, fill, name})", summary: "pie slice centred on cx,cy with radius r px; start in degrees clockwise from 12 o'clock (default 0), sweep in degrees clockwise 0 < sweep <= 360, inner 0 to 0.95 is the hole as a share of r (default 0); returns the node" },
  { name: "axiRotate", signature: "axiRotate(doc, ref, degrees, {cx, cy})", summary: "rotate one node (shape, boolean result, text, picture) by degrees, positive clockwise, about the centre of its box or about cx,cy in document px; ref is a name, path or node; 0 changes nothing; returns the node" },
  { name: "axiLens", signature: "axiLens(doc, {cx, cy, r, d, rotate, fill, fillAlpha, name})", summary: "lens (vesica) = the overlap of two circles of radius r whose centres are d px apart on a horizontal line through cx,cy, 0 < d < 2r; upright it is 2r - d wide and 2 * sqrt(r*r - d*d/4) high; rotate degrees clockwise about cx,cy (default 0); returns the node, left selected" },
];

/** Internal building blocks, not in the index. */
export const SHAPES_INTERNAL: readonly string[] = ["axiShapePaint", "axiShapePoint"];

export const SHAPES_SOURCE: string = String.raw`
/* ---- shape helpers ---- */

// Internal: [x, y] from a point given as [x,y] or {x,y}; throws for anything else.
function axiShapePoint(who, p, i) {
  const x = Array.isArray(p) ? p[0] : (p && p.x);
  const y = Array.isArray(p) ? p[1] : (p && p.y);
  if (typeof x !== 'number' || !isFinite(x) || typeof y !== 'number' || !isFinite(y)) { throw new Error(who + ': point ' + i + ' needs numbers x and y'); }
  return [x, y];
}

// Internal: [brush, pen, style, transparency] descriptors for
// PolyCurveNodeDefinition.create from o.fill, o.fillAlpha, o.stroke and
// o.strokeWidth. Never null: a missing fill is a none brush, a missing stroke a
// none pen with a 1 px line style.
function axiShapePaint(o) {
  const { FillDescriptor } = require('/fills.js');
  const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
  const none = FillDescriptor.createNone();
  const width = o.strokeWidth === undefined ? 2 : o.strokeWidth;
  const brush = o.fill ? FillDescriptor.createSolid(axiHex(o.fill, o.fillAlpha)) : none;
  const pen = o.stroke ? FillDescriptor.createSolid(axiHex(o.stroke)) : none;
  const style = LineStyleDescriptor.create(LineStyle.create({ weight: o.stroke ? width : 1 }));
  return [brush, pen, style, none];
}

// Polygon through points ([x,y] or {x,y}, document px). closed (default true)
// needs 3 points and ends with a line back to the first point; closed:false
// needs 2 points and a stroke. fill and/or stroke is required.
function axiPolygon(doc, points, o) {
  const opts = o || {};
  const closed = opts.closed === undefined ? true : opts.closed;
  if (typeof closed !== 'boolean') { throw new Error('axiPolygon: closed must be true or false'); }
  if (!Array.isArray(points) || points.length < (closed ? 3 : 2)) { throw new Error('axiPolygon: at least ' + (closed ? 3 : 2) + ' points are required'); }
  const pts = points.map(function (p, i) { return axiShapePoint('axiPolygon', p, i); });
  if (!opts.fill && !opts.stroke) { throw new Error('axiPolygon: fill or stroke is required'); }
  if (!closed && !opts.stroke) { throw new Error('axiPolygon: closed:false needs stroke'); }
  const width = opts.strokeWidth === undefined ? 2 : opts.strokeWidth;
  if (typeof width !== 'number' || !isFinite(width) || !(width > 0)) { throw new Error('axiPolygon: strokeWidth must be positive'); }
  const paint = axiShapePaint(opts);
  axiSurface(doc);
  const { CurveBuilder, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const b = new CurveBuilder().beginXY(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i += 1) { b.lineToXY(pts[i][0], pts[i][1]); }
  if (closed) { b.lineToXY(pts[0][0], pts[0][1]); }
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  doc.addNode(PolyCurveNodeDefinition.create(pc, paint[0], paint[1], paint[2], paint[3]));
  return axiName(doc.selection.nodes.first, opts.name);
}

// One subpath from segments: ['M',x,y] first, then ['L',x,y] or
// ['C',c1x,c1y,c2x,c2y,x,y], optionally a last ['Z'] (a line back to the start
// when the pen is elsewhere). fill and/or stroke is required.
function axiPath(doc, segments, o) {
  const opts = o || {};
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const first = Array.isArray(segments) ? segments[0] : null;
  if (!Array.isArray(first) || first[0] !== 'M' || first.length !== 3 || !fin(first[1]) || !fin(first[2])) { throw new Error("axiPath: the first segment must be ['M', x, y]"); }
  const need = { L: 3, C: 7 };
  segments.forEach(function (s, i) {
    if (i === 0) { return; }
    const ok = Array.isArray(s) && ((s[0] === 'Z' && s.length === 1 && i === segments.length - 1) || (need[s[0]] === s.length && s.slice(1).every(fin)));
    if (!ok) { throw new Error('axiPath: segment ' + i + ' must be L, C or a final Z'); }
  });
  if (!opts.fill && !opts.stroke) { throw new Error('axiPath: fill or stroke is required'); }
  const width = opts.strokeWidth === undefined ? 2 : opts.strokeWidth;
  if (!fin(width) || !(width > 0)) { throw new Error('axiPath: strokeWidth must be positive'); }
  const paint = axiShapePaint(opts);
  axiSurface(doc);
  const { CurveBuilder, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const b = new CurveBuilder().beginXY(first[1], first[2]);
  let px = first[1];
  let py = first[2];
  for (let i = 1; i < segments.length; i += 1) {
    const s = segments[i];
    if (s[0] === 'L') { b.lineToXY(s[1], s[2]); px = s[1]; py = s[2]; }
    else if (s[0] === 'C') { b.addBezierXY(s[1], s[2], s[3], s[4], s[5], s[6]); px = s[5]; py = s[6]; }
    else if (px !== first[1] || py !== first[2]) { b.lineToXY(first[1], first[2]); }
  }
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  doc.addNode(PolyCurveNodeDefinition.create(pc, paint[0], paint[1], paint[2], paint[3]));
  return axiName(doc.selection.nodes.first, opts.name);
}

// One pie slice (or ring segment when inner > 0). start is degrees clockwise
// from 12 o'clock (default 0), sweep degrees clockwise, 0 < sweep <= 360.
function axiWedge(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiWedge: options {cx,cy,r,sweep,fill} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.cx) || !fin(o.cy)) { throw new Error('axiWedge: cx and cy are required numbers'); }
  if (!fin(o.r) || !(o.r > 0)) { throw new Error('axiWedge: r is required and must be positive'); }
  const start = o.start === undefined ? 0 : o.start;
  if (!fin(start)) { throw new Error('axiWedge: start must be a finite number of degrees'); }
  if (!fin(o.sweep) || !(o.sweep > 0) || o.sweep > 360) { throw new Error('axiWedge: sweep must be above 0 and at most 360'); }
  const inner = o.inner === undefined ? 0 : o.inner;
  if (!fin(inner) || inner < 0 || inner > 0.95) { throw new Error('axiWedge: inner must be 0 to 0.95'); }
  if (typeof o.fill !== 'string') { throw new Error('axiWedge: fill (a hex colour) is required'); }
  return axiPieSlice(doc, o.cx, o.cy, o.r, inner, (start - 90) * Math.PI / 180, o.sweep * Math.PI / 180, o.fill, o.name);
}

// Rotate one node by degrees (positive clockwise) about the centre of its box,
// or about {cx, cy}. Works on shapes, boolean results, text and pictures.
// 0 returns the node untouched.
function axiRotate(doc, ref, degrees, o) {
  const opts = o || {};
  if (typeof degrees !== 'number' || !isFinite(degrees)) { throw new Error('axiRotate: degrees must be a finite number'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if ((opts.cx !== undefined && !fin(opts.cx)) || (opts.cy !== undefined && !fin(opts.cy))) { throw new Error('axiRotate: cx and cy must be finite numbers'); }
  const node = axiNodesOf(doc, [ref], 'axiRotate')[0];
  if (degrees === 0) { return node; }
  const { Transform } = require('/geometry.js');
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  const box = axiNodeBox(node);
  const cx = opts.cx === undefined ? box.x + box.w / 2 : opts.cx;
  const cy = opts.cy === undefined ? box.y + box.h / 2 : opts.cy;
  const xf = Transform.createTranslate(cx, cy).multiply(Transform.createRotate(degrees * Math.PI / 180)).multiply(Transform.createTranslate(-cx, -cy));
  const back = axiOnSpread(doc, node);
  try { doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, node), xf)); } finally { back(); }
  return node;
}

// Lens: the overlap of two circles of radius r centred (cx - d/2, cy) and
// (cx + d/2, cy), 0 < d < 2r. Upright it is 2r - d wide and 2*sqrt(r*r - d*d/4)
// high. rotate (degrees clockwise about cx,cy) turns it afterwards.
function axiLens(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiLens: options {cx,cy,r,d,fill} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.cx) || !fin(o.cy)) { throw new Error('axiLens: cx and cy are required numbers'); }
  if (!fin(o.r) || !(o.r > 0)) { throw new Error('axiLens: r is required and must be positive'); }
  if (!fin(o.d) || !(o.d > 0) || !(o.d < 2 * o.r)) { throw new Error('axiLens: d must be above 0 and below 2 * r'); }
  if (o.rotate !== undefined && !fin(o.rotate)) { throw new Error('axiLens: rotate must be a finite number of degrees'); }
  if (typeof o.fill !== 'string') { throw new Error('axiLens: fill (a hex colour) is required'); }
  const a = axiEllipse(doc, { x: o.cx - o.d / 2 - o.r, y: o.cy - o.r, w: 2 * o.r, h: 2 * o.r, fill: o.fill, fillAlpha: o.fillAlpha });
  const b = axiEllipse(doc, { x: o.cx + o.d / 2 - o.r, y: o.cy - o.r, w: 2 * o.r, h: 2 * o.r, fill: o.fill, fillAlpha: o.fillAlpha });
  const node = axiBool(doc, 'intersect', [a, b], { name: o.name });
  if (o.rotate) { axiRotate(doc, node, o.rotate, { cx: o.cx, cy: o.cy }); }
  return node;
}
`;
