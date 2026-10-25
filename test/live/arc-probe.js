// Live probe for the seal helpers (axiArcText / axiSeal). Run with --with-helpers.
// It creates its own document and addresses it through the variable, never through
// Document.current, and never closes anything: finish with
// `doc save <uuid8> <path.af>` then `doc close <uuid8>`.
//
// It prints one JSON line and leaves a render to look at (markers at 0, 90, 180 and
// 270 degrees show where each text should be centred).
//
// RESULT (Affinity 3.3.1.4940, 2026-10-26; the first run also surveyed an Ellipse
// path text and CurveBuilder.addArc for 16 variants):
//   - A text node on a path (ShapePathText on an Ellipse, CurvePathText) reports the
//     box of the PATH from baseBox and getSpreadBaseBox, never the text's own box, so
//     a measure-and-rotate scheme cannot work. The text is placed by geometry: an open
//     arc centred on the wanted angle with the text centre aligned.
//   - addArc(a0, a1, r, reverse) starts at the CURRENT point (beginXY first); document
//     angles: 0 = right, 90 = down, positive sweep is clockwise on screen. reverse=true
//     takes the other way round (180 -> 0 passes through 90, i.e. under the centre).
//   - top  : a0 = theta - half, a1 = theta + half, reverse false. Reads left to right,
//            letters outside the circle, baseline on it. Verified at 0 and 90 degrees.
//   - bottom: a0 = theta + half, a1 = theta - half, reverse true. Reads left to right,
//            upright, letters inside the circle. Verified at 180 and 270 degrees.
//            theta = clock angle - 90 degrees.
//   - Centre alignment centres the text on the middle of the arc (markers agree).
//   - Transform.createTranslate(c).multiply(createRotate(r)).multiply(createTranslate(-c))
//     applies right to left and positive is clockwise: (100,50) about (100,100) by 90
//     degrees lands on (150,100).
//   - ShapeStar.innerRadius is a 0-1 fraction of the outer radius (5 points default
//     0.382, maxInnerRadius 0.809; 28 points max 0.9937; innerRadius 0.85 reads back
//     0.85). Set points first, then innerRadius.
const { ShapeStar } = require('/shapes.js');
const { CurvePathTextNodeDefinition, ShapeNodeDefinition } = require('/nodes.js');
const { CurveBuilder, PolyCurve, Transform } = require('/geometry.js');
const { StoryDelta } = require('/storydelta.js');
const { ParagraphAlignXType } = require('/paragraphatts.js');

const doc = axiDoc(1000, 1000);
const out = { uuid: String(doc.sessionUuid) };
const CX = 500;
const CY = 500;
const R = 300;
const r2 = function (v) { return Math.round(v * 100) / 100; };
const box = function (b) { return { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) }; };
const pt = function (p) { return { x: r2(p.x), y: r2(p.y) }; };

axiRect(doc, { x: 0, y: 0, w: 1000, h: 1000, fill: '#F2F5F9', name: 'probe-bg' });
axiEllipse(doc, { x: CX - R, y: CY - R, w: 2 * R, h: 2 * R, stroke: '#4C8DFF', strokeWidth: 1, name: 'probe-guide' });

// 1. Transform order and rotation direction. T(c) x R x T(-c) applied to a point
// straight above the pivot: clockwise on screen lands to its right.
{
  const rad = Math.PI / 2;
  const a = Transform.createTranslate(100, 100).multiply(Transform.createRotate(rad)).multiply(Transform.createTranslate(-100, -100));
  const b = Transform.createTranslate(-100, -100).multiply(Transform.createRotate(rad)).multiply(Transform.createTranslate(100, 100));
  out.xf = { tRt: pt(a.applyToPoint({ x: 100, y: 50 })), tRtReversed: pt(b.applyToPoint({ x: 100, y: 50 })), note: 'expect (150,100) when the written order applies right to left and positive is clockwise' };
}

// 2. Star radii.
{
  const s = ShapeStar.create();
  const before = { points: s.points, inner: s.innerRadius, max: s.maxInnerRadius, circleIn: s.circleInnerRadius, circleOut: s.circleOuterRadius };
  s.points = 28;
  s.innerRadius = 0.85;
  const after = { points: s.points, inner: s.innerRadius, max: s.maxInnerRadius, circleIn: s.circleInnerRadius, circleOut: s.circleOuterRadius };
  doc.addNode(ShapeNodeDefinition.create(s, { x: CX - 420, y: CY - 420, width: 840, height: 840 }, axiHex('#FFC857'), null, null));
  axiName(doc.selection.nodes.first, 'probe-star');
  out.star = { before: before, after: after, nodeBox: box(axiMeasure(doc)) };
}

// 3. Text on open arcs, centre aligned, at four angles (see RESULT above).
const story = function (text, size) {
  const sb = axiStyled(doc, { font: 'Helvetica-Bold', size: size, colour: '#1F2A44' }, false);
  sb.applyParagraphDelta(StoryDelta.createAlignX(ParagraphAlignXType.Centre));
  sb.addText(text);
  return sb;
};
const arcText = function (text, size, startDeg, side, spanDeg, name) {
  const theta = (startDeg - 90) * Math.PI / 180;
  const half = spanDeg * Math.PI / 360;
  const a0 = side === 'top' ? theta - half : theta + half;
  const a1 = side === 'top' ? theta + half : theta - half;
  const cb = new CurveBuilder().beginXY(CX + R * Math.cos(a0), CY + R * Math.sin(a0));
  const c = cb.addArc(a0, a1, R, side === 'bottom').createCurve();
  const pc = PolyCurve.create();
  pc.addCurve(c);
  doc.addNode(CurvePathTextNodeDefinition.createFromStoryBuilder(pc, story(text, size)));
  const n = doc.selection.nodes.first;
  n.userDescription = name;
  const sp = n.getSpreadBaseBox(false);
  return { from: pt(c.getPoint(0)), to: pt(c.getPoint(-1)), box: { x: r2(sp.x), y: r2(sp.y), w: r2(sp.width), h: r2(sp.height) } };
};
const marker = function (startDeg, rr, colour, name) {
  const t = startDeg * Math.PI / 180;
  axiEllipse(doc, { x: CX + rr * Math.sin(t) - 6, y: CY - rr * Math.cos(t) - 6, w: 12, h: 12, fill: colour, name: name });
};
out.text = {
  top0: arcText('TOP ARC TEXT', 48, 0, 'top', 120, 'probe-top0'),
  right90: arcText('RIGHT SIDE', 48, 90, 'top', 120, 'probe-right90'),
  bottom180: arcText('BOTTOM ARC', 48, 180, 'bottom', 120, 'probe-bottom180'),
  left270: arcText('LEFT SIDE', 48, 270, 'bottom', 120, 'probe-left270'),
};
[0, 90, 180, 270].forEach(function (a) { marker(a, R - 40, '#4C8DFF', 'probe-mark-' + a); });
out.note = 'compare each marker with the middle of its text in the render';
console.log(JSON.stringify(out));
