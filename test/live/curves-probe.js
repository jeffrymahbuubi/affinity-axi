// Live probe for Spline.createFromPoints and the axiGrade curves path: does the SDK
// take [x, y] arrays, {x, y} objects, or both? Run with --with-helpers on a scratch
// document that holds an image or pixel layer:
//   affinity-axi run test/live/curves-probe.js --with-helpers --args '{"uuid":"<uuid8>"}'
// It logs one JSON line per case, {case, threw, error}. The first four cases call
// the SDK directly and add nothing to the document. The grade and look cases add
// adjustment layers to the first image or pixel layer found (each with
// {replace: true}); close the scratch document without saving. The script ends no
// document and saves nothing.
//
// RESULT (Affinity 3.3.3.5004, macOS, 2026-11-14):
//   arrays-2, arrays-5: threw INVALID_ARGS (the SDK takes no [x, y] arrays);
//   objects-2, objects-5, grade-master, grade-channels, look-airy, look-warm-soft: ok.
const { Document } = require('/document.js');
const { Spline } = require('/geometry.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('probe document not found: ' + want); }

function firstPicture(node) {
  for (const c of Array.from(node.children)) {
    if (c.isImageNode || c.isRasterNode) { return c; }
    const inner = firstPicture(c);
    if (inner) { return inner; }
  }
  return null;
}

let target = null;
for (const s of Array.from(doc.spreads)) {
  target = target || firstPicture(s);
}
if (!target) { throw new Error('probe document has no image or pixel layer'); }

function report(label, run) {
  try {
    run();
    console.log(JSON.stringify({ case: label, threw: false, error: null }));
  } catch (e) {
    console.log(JSON.stringify({ case: label, threw: true, error: String(e && e.message ? e.message : e) }));
  }
}

const arr2 = [[0, 0], [1, 1]];
const arr5 = [[0, 0], [0.25, 0.3], [0.5, 0.57], [0.75, 0.81], [1, 0.985]];
const obj2 = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
const obj5 = arr5.map((p) => ({ x: p[0], y: p[1] }));

report('arrays-2', () => Spline.createFromPoints(arr2));
report('arrays-5', () => Spline.createFromPoints(arr5));
report('objects-2', () => Spline.createFromPoints(obj2));
report('objects-5', () => Spline.createFromPoints(obj5));

report('grade-master', () => axiGrade(doc, target, { curves: [[0, 0.04], [0.5, 0.57], [1, 0.985]] }, { replace: true }));
report('grade-channels', () => axiGrade(doc, target, { curves: { r: [[0, 0], [1, 0.9]], b: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] } }, { replace: true }));
report('look-airy', () => axiGrade(doc, target, 'airy', { replace: true }));
report('look-warm-soft', () => axiGrade(doc, target, 'warm-soft', { replace: true }));
