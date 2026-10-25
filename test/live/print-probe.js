// Live probe for the print helpers (unit P, assumptions A3, A4, A8). Run it
// FIRST, before the helpers are relied on:
//   affinity-axi run test/live/print-probe.js
// It needs no helpers and no existing document: it creates two documents of its
// own (a CMYK A5 flyer with 3 mm bleed, and a plain RGB one to convert) and
// addresses them by variable, never by Document.current. It never closes
// anything: finish with `doc save <uuid8> <path.af>` then `doc close <uuid8>`
// for each uuid it prints.
//
// What it records (one JSON line, read the fields in this order):
//   units       the UnitType member names (Millimetre present?)
//   a5          the flyer: units, dpi, format, widthPixels, heightPixels as read back
//   expando     whether doc.axiPrint = {...} sticks on the document wrapper (A8)
//   convert     doc.format = RasterFormat.CMYKA8 on the RGB document: format before
//               and after (A4)
//   marks       a PolyCurve line built the cropMarks.js way, named and locked
//   guide       doc.addGuide at the trim edge in document px (no throw)
// The bleed itself is checked on the exported file: `print <uuid8> --out ...`
// then exiftool / grep for BleedBox (A3, A5); see the handoff for the result.
//
// RESULT (Affinity 3.3.1.4940, 2026-10-25):
//   A3 PARTLY WRONG: NewDocumentOptions.bleed is read in the document's UNITS, not px
//      (35.43 on a mm document gave a 35.43 mm bleed; 3 gave 3 mm; 24 on a px document
//      gave 24 px). No BleedBox key is ever written. "PDF (press ready)" writes
//      MediaBox = trim + bleed with a TrimBox; PDF/X-1a, X-3, X-4 and "PDF (for print)"
//      export the trim area only (MediaBox = TrimBox, bleed content clipped away).
//   A4 OK: doc.format = CMYKA8 converts an open RGB document (reads back CMYKA8) and the
//      page content exports with k operators.
//   A5 NO: PDF/X-4 and press ready are PDF 1.6/1.7 with page, boxes and output intent in a
//      Flate ObjStm; preflight.ts inflates object streams, so those rows are read, not unknown.
//   A8 OK: doc.axiPrint = {...} sticks and reads back.
//   marks and guides: a PolyCurve line with no fill, locked, and addGuide in document px work.
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { RasterFormat } = require('/rasterobject.js');
const { RGBA8 } = require('/colours.js');
const { ShapeNodeDefinition, PolyCurveNodeDefinition } = require('/nodes.js');
const { ShapeRectangle } = require('/shapes.js');
const { Curve, PolyCurve } = require('/geometry.js');
const { FillDescriptor } = require('/fills.js');
const { LineStyleDescriptor } = require('/linestyle.js');

const dpi = 300;
const px = (mm) => mm / 25.4 * dpi;
const out = { units: Object.keys(UnitType || {}), formats: Object.keys(RasterFormat || {}).slice(0, 12) };

// 1. A5 flyer, 3 mm bleed, CMYK, created in millimetres.
const o = NewDocumentOptions.createDefault();
o.units = UnitType.Millimetre;
o.width = 148;
o.height = 210;
o.dpi = dpi;
// The bleed is given in the document's own UNITS (here millimetres), not in px:
// the first run passed 35.43 (3 mm in px) and the press PDF grew by 35.43 mm per side.
const b = px(3);
o.bleed = { left: 3, top: 3, right: 3, bottom: 3 };
o.rasterFormat = RasterFormat.CMYKA8;
const flyer = Document.createFromOptions(o);
out.a5 = { uuid: String(flyer.sessionUuid), units: String(flyer.units), dpi: flyer.dpi, format: String(flyer.format), widthPixels: flyer.widthPixels, heightPixels: flyer.heightPixels, bleedPx: b };

// A background to the bleed edge and a content block inside the trim.
flyer.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: -b, y: -b, width: flyer.widthPixels + 2 * b, height: flyer.heightPixels + 2 * b }, RGBA8(24, 52, 96, 255), null, null));
flyer.selection.nodes.first.userDescription = 'probe-bleed-bg';
flyer.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: px(10), y: px(10), width: px(128), height: px(60) }, RGBA8(250, 200, 60, 255), null, null));
flyer.selection.nodes.first.userDescription = 'probe-block';

// 1b. A pixel document with a bleed: the number is px at the document dpi.
const po = NewDocumentOptions.createDefault();
po.units = UnitType.Pixel;
po.width = 1080;
po.height = 1080;
po.dpi = 72;
po.bleed = { left: 24, top: 24, right: 24, bottom: 24 };
const pxDoc = Document.createFromOptions(po);
pxDoc.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: -24, y: -24, width: 1128, height: 1128 }, RGBA8(24, 52, 96, 255), null, null));
pxDoc.selection.nodes.first.userDescription = 'probe-bleed-bg';
out.pxDoc = { uuid: String(pxDoc.sessionUuid), units: String(pxDoc.units), widthPixels: pxDoc.widthPixels };

// 2. Expando property on the document wrapper (A8).
try {
  flyer.axiPrint = { trim: { w: flyer.widthPixels, h: flyer.heightPixels }, bleed: b, dpi: dpi };
  const back = flyer.axiPrint;
  out.expando = { set: true, readBack: !!back && back.dpi === dpi };
} catch (e) {
  out.expando = { set: false, error: String(e && e.message ? e.message : e).slice(0, 120) };
}

// 3. One crop mark the cropMarks.js way: PolyCurve line, no fill, solid line, named, locked.
try {
  const poly = PolyCurve.create();
  poly.addCurve(Curve.createLineXY(-px(3) - px(5), 0, -px(3), 0));
  const none = FillDescriptor.createNone();
  const line = FillDescriptor.createSolid(RGBA8(0, 0, 0, 255));
  flyer.addNode(PolyCurveNodeDefinition.create(poly, none, line, LineStyleDescriptor.createDefault(0.25 / 72 * dpi), none));
  const m = flyer.selection.nodes.first;
  m.userDescription = 'probe-mark';
  m.lock();
  out.marks = { ok: true, locked: !!m.isLocked };
} catch (e) {
  out.marks = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 160) };
}

// 4. A guide at the trim edge, document px.
try {
  flyer.addGuide(false, px(0));
  flyer.addGuide(true, px(0));
  out.guide = { ok: true };
} catch (e) {
  out.guide = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 160) };
}

// 5. Convert an RGB document to CMYK (A4).
const r = NewDocumentOptions.createDefault();
r.units = UnitType.Pixel;
r.width = 400;
r.height = 400;
r.dpi = 72;
const rgb = Document.createFromOptions(r);
const before = String(rgb.format);
try {
  rgb.format = RasterFormat.CMYKA8;
  out.convert = { uuid: String(rgb.sessionUuid), before: before, after: String(rgb.format), same: String(rgb.format) === String(RasterFormat.CMYKA8) };
} catch (e) {
  out.convert = { uuid: String(rgb.sessionUuid), before: before, error: String(e && e.message ? e.message : e).slice(0, 160) };
}
rgb.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: 50, y: 50, width: 300, height: 300 }, RGBA8(200, 40, 40, 255), null, null));
rgb.selection.nodes.first.userDescription = 'probe-rgb-rect';

console.log(JSON.stringify(out));
