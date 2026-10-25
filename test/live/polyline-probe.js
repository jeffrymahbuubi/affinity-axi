// Live probe for the multi-series chart helpers (plan unit M, assumption A2): does
// PolyCurveNodeDefinition.create draw an open stroked polyline, and what must the
// five arguments be? Run with --with-helpers on a demo document:
//   affinity-axi run test/live/polyline-probe.js --with-helpers --args '{"uuid":"<uuid8>"}'
// It draws three polylines on the first artboard and logs one JSON line per case:
// whether creation threw, the node type, its box and its curve count. Nothing is
// closed or saved by the script.
//
// RESULT (Affinity 3.3.1.4940, 2026-10-26):
//   - Assumption A2 holds with a correction. PolyCurveNodeDefinition.create(poly,
//     FillDescriptor.createNone(), FillDescriptor.createSolid(colour),
//     LineStyleDescriptor.create(LineStyle.create({weight})), FillDescriptor.createNone())
//     renders an OPEN stroked polyline (type PolyCurveNode, box 400x180 for the
//     three points, round caps and joins by default). No rect fallback is needed.
//   - null in ANY argument throws "Cannot read properties of null (reading
//     'handle')": the JS wrapper reads .handle on all four fill/style arguments
//     (unlike ShapeNodeDefinition.create, which tolerates null). The plan's "null
//     brush fill" is wrong; axiPolyline passes FillDescriptor.createNone() for the
//     brush and the transparency, as the SDK's cropMarks.js example does.
//   - A polygon ended with a final lineToXY back to the start (no close()) takes a
//     solid brush fill and renders as a filled, outlined shape.
//   - The node's box is the geometry box (the stroke width is not added), and
//     node.curves.curveCount is not readable on the node (logged as n/a).
const { Document } = require('/document.js');
const { PolyCurve, CurveBuilder } = require('/geometry.js');
const { PolyCurveNodeDefinition } = require('/nodes.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('probe document not found: ' + want); }

axiOn(doc, 'ig-square');

function polyline(points) {
  const b = new CurveBuilder().beginXY(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) { b.lineToXY(points[i][0], points[i][1]); }
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  return pc;
}

function report(label, make) {
  try {
    doc.addNode(make());
    const node = doc.selection.nodes.first;
    node.userDescription = 'probe-' + label;
    let curves = null;
    try { curves = node.curves.curveCount; } catch (e) { curves = 'n/a'; }
    console.log(JSON.stringify({ case: label, threw: false, type: String(node), box: axiMeasure(doc), curves: curves }));
  } catch (e) {
    console.log(JSON.stringify({ case: label, threw: true, error: String(e && e.message ? e.message : e) }));
  }
}

const none = FillDescriptor.createNone();
const sky = FillDescriptor.createSolid(axiHex('#4C8DFF'));
const style = LineStyleDescriptor.create(LineStyle.create({ weight: 6 }));

// 1. The recommended form: none brush, solid pen, none transparency.
report('descriptors', () => PolyCurveNodeDefinition.create(polyline([[100, 300], [300, 120], [500, 260]]), none, sky, style, none));
// 2. The plan's original form: a null brush fill and a null transparency fill.
report('null-brush', () => PolyCurveNodeDefinition.create(polyline([[100, 600], [300, 420], [500, 560]]), null, sky, style, null));
// 3. A shape finished with a final lineToXY (no close()), filled with a brush.
report('filled-area', () => PolyCurveNodeDefinition.create(polyline([[600, 300], [800, 120], [1000, 260], [1000, 400], [600, 400], [600, 300]]), FillDescriptor.createSolid(axiHex('#FFC857')), sky, style, none));
