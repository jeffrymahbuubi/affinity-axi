// Live probe for the chart helpers (R4, KTD7): does a ShapePie keep startAngle,
// sweep and innerRadius set BEFORE ShapeNodeDefinition.create, and what box
// does the node get? Run with --with-helpers on a demo document:
//   affinity-axi run test/live/pie-probe.js --with-helpers --args '{"uuid":"<uuid8>"}'
// It draws four pies on the first artboard, re-reads the shape of each created
// node and logs one JSON line per case: the values set, the values read back,
// the node box and the shape type. Nothing is closed or saved by the script.
//
// RESULT (Affinity 3.3.1.4940, 2026-10-26):
//   - startAngle, sweep and innerRadius set before ShapeNodeDefinition.create
//     SURVIVE creation (read back from node.shape), so no doc.setShape fallback.
//   - The node box is the full bounding square (2r x 2r) whatever the slice.
//   - A sweep of 2*PI renders a complete ring; innerRadius is a 0-1 fraction.
//   - The angle direction is the MIRROR of the SDK hint: a slice stored with
//     startAngle s and sweep w covers the screen-clockwise interval
//     [-(s+w), -s] from 3 o'clock (quarter -PI/2,+PI/2 drew the 3-to-6 o'clock
//     quadrant, not 12-to-3). axiPieSlice converts: stored = -(start + sweep).
const { Document } = require('/document.js');
const { ShapePie } = require('/shapes.js');
const { ShapeNodeDefinition } = require('/nodes.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('probe document not found: ' + want); }

axiOn(doc, 'ig-square');

function readBack(node) {
  const s = node.shape;
  return { type: String(s && s.toString ? s.toString() : s), start: s.startAngle, sweep: s.sweep, inner: s.innerRadius, end: s.endAngle };
}

function slice(label, cx, cy, r, start, sweep, inner, fill) {
  const pie = ShapePie.create();
  pie.startAngle = start;
  pie.sweep = sweep;
  pie.innerRadius = inner;
  const set = { start: pie.startAngle, sweep: pie.sweep, inner: pie.innerRadius };
  doc.addNode(ShapeNodeDefinition.create(pie, { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r }, axiHex(fill), null, null));
  const node = doc.selection.nodes.first;
  node.userDescription = 'probe-' + label;
  console.log(JSON.stringify({ case: label, asked: { start: start, sweep: sweep, inner: inner }, beforeCreate: set, afterCreate: readBack(node), box: axiMeasure(doc) }));
  return node;
}

// A quarter ring from 12 o'clock, a half disc, a three-quarter ring, and a full ring.
slice('quarter-ring', 270, 270, 200, -Math.PI / 2, Math.PI / 2, 0.6, '#4C8DFF');
slice('half-disc', 810, 270, 200, -Math.PI / 2, Math.PI, 0, '#FFC857');
slice('three-quarter-ring', 270, 810, 200, -Math.PI / 2, 1.5 * Math.PI, 0.6, '#1F2A44');
slice('full-ring', 810, 810, 200, -Math.PI / 2, 2 * Math.PI, 0.6, '#4C8DFF');
