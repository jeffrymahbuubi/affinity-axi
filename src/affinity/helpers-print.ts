// Print helpers for run --with-helpers: axiMm, axiPrintDoc, axiPrintSheet. Same
// rules as helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks,
// dollar-brace or backslash surprises).
//
// PROBE RESULTS (test/live/print-probe.js, Affinity 3.3.1.4940, 2026-10-25):
//   - NewDocumentOptions.bleed is given in the document's own UNITS, not in px:
//     bleed 3 on a Millimetre document is 3 mm; bleed 24 on a Pixel document is
//     24 px. (Passing 35.43 "px" to a mm document made a 35 mm bleed.) The helper
//     therefore passes the bleed through unchanged and converts only for doc.axiPrint.
//   - Document.widthPixels is in px at the document dpi (A5 at 300 dpi = 1748.03),
//     so a node coordinate is a px at doc.dpi: axiMm = mm / 25.4 * dpi.
//   - rasterFormat CMYKA8 at creation, and doc.format = CMYKA8 on an open RGB
//     document, both read back as CMYKA8 (the page content exports with k operators).
//   - doc.axiPrint = {...} sticks on the document wrapper and reads back, so the
//     helper attaches it (a script keeps the same wrapper).
//   - Crop marks are PolyCurve lines, built as Affinity's cropMarks.js does:
//     PolyCurveNodeDefinition.create(poly, none, solid, LineStyleDescriptor, none),
//     then named and locked. addGuide takes positions in document px.
//   - Export presets decide the bleed, not the document: "PDF (press ready)" writes
//     MediaBox = trim + bleed with a TrimBox (no BleedBox key), while "PDF/X-1a:2003",
//     "PDF/X-3:2003", "PDF/X-4" and "PDF (for print)" export the trim area only
//     (MediaBox = TrimBox, or no TrimBox); the bleed content is clipped away.
//
// Validation runs before any require() and before any node is added, so a bad
// option throws without touching the document.

import type { HelperInfo } from "./helpers-core.js";

export const PRINT_INDEX: readonly HelperInfo[] = [
  {
    name: "axiMm",
    signature: "axiMm(doc, mm)",
    summary: "millimetres to document px at the document dpi (mm / 25.4 * dpi); 3 mm at 300 dpi is 35.43 px",
  },
  {
    name: "axiPrintDoc",
    signature: "axiPrintDoc({w,h,unit,dpi,bleed,cmyk})",
    summary:
      "new print document: unit 'mm' (default) or 'px', w and h the trim size in that unit, dpi default 300, bleed on all four sides in the SAME unit (default 0; set at creation, because it cannot be added later), cmyk:true makes it a CMYK document. Draw backgrounds out to the bleed (x or y from -bleed px) and keep content inside the trim. Returns the document with doc.axiPrint = {trim:{w,h}, bleed, dpi} in px. Export with `print <doc> --out f.pdf --preset 'PDF (press ready)'` to keep the bleed: the PDF/X presets export the trim area only",
  },
  {
    name: "axiPrintSheet",
    signature: "axiPrintSheet(doc, {name,x,y,w,h,unit,bleed,slug,marks,markLength,markOffset,markWeight,markColour,guides})",
    summary:
      "proof sheet: one white artboard (default name print-sheet; placed after the existing artboards, or at x,y) of the trim size w,h (unit 'mm' default, or 'px') plus bleed plus slug on every side. marks (default true) draws eight locked crop-mark lines named <name>-mark-1..8 in the slug: markLength default 5 mm, markOffset default 3 mm from the bleed edge, markWeight default 0.25 pt, markColour default #000000; the slug must be at least markOffset + markLength (default is that plus 2 mm). guides:true adds guides at the trim and bleed edges. bleed default 3 (in unit). Returns {sheet, bleed, trim, marks} where the boxes are {x,y,w,h} in spread px and marks is the array of mark nodes. Marks are for proofs; press PDFs carry bleed, not marks",
  },
];

/** Internal building blocks, not in the index. */
export const PRINT_INTERNAL: readonly string[] = ["axiMarkLines"];

export const PRINT_SOURCE: string = String.raw`
/* ---- print helpers ---- */

// Millimetres to px at the document dpi. A 300 dpi document has 11.81 px per mm.
function axiMm(doc, mm) {
  if (typeof mm !== 'number' || !isFinite(mm)) { throw new Error('axiMm: mm must be a number (got ' + JSON.stringify(mm) + ')'); }
  const dpi = doc && doc.dpi;
  if (typeof dpi !== 'number' || !(dpi > 0)) { throw new Error('axiMm: the document has no dpi'); }
  return mm / 25.4 * dpi;
}

// New print document. w and h are the TRIM size and bleed is added on all four
// sides, both in unit ('mm' default, or 'px' at dpi). The bleed is handed to
// NewDocumentOptions unchanged: it is read in the document's own units. cmyk
// sets the raster format to CMYKA8 before the document exists. doc.axiPrint
// carries the trim size, bleed and dpi in px for the rest of the script.
function axiPrintDoc(o) {
  if (!o || typeof o !== 'object') { throw new Error('axiPrintDoc: options {w,h} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const unit = o.unit === undefined ? 'mm' : o.unit;
  if (unit !== 'mm' && unit !== 'px') { throw new Error('axiPrintDoc: unit must be mm or px (got ' + JSON.stringify(o.unit) + ')'); }
  if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error('axiPrintDoc: w and h are required and must be positive'); }
  const dpi = o.dpi === undefined ? 300 : o.dpi;
  if (!fin(dpi) || !(dpi >= 1) || dpi > 2400) { throw new Error('axiPrintDoc: dpi must be between 1 and 2400 (got ' + JSON.stringify(o.dpi) + ')'); }
  const bleed = o.bleed === undefined ? 0 : o.bleed;
  if (!fin(bleed) || bleed < 0) { throw new Error('axiPrintDoc: bleed must be 0 or more, in ' + unit + ' (got ' + JSON.stringify(o.bleed) + ')'); }
  if (o.cmyk !== undefined && typeof o.cmyk !== 'boolean') { throw new Error('axiPrintDoc: cmyk must be true or false'); }
  const { Document, NewDocumentOptions } = require('/document.js');
  const { UnitType } = require('/units.js');
  const op = NewDocumentOptions.createDefault();
  op.units = unit === 'mm' ? UnitType.Millimetre : UnitType.Pixel;
  op.width = o.w;
  op.height = o.h;
  op.dpi = dpi;
  if (bleed > 0) { op.bleed = { left: bleed, top: bleed, right: bleed, bottom: bleed }; }
  if (o.cmyk === true) {
    const { RasterFormat } = require('/rasterobject.js');
    op.rasterFormat = RasterFormat.CMYKA8;
  }
  const doc = Document.createFromOptions(op);
  const k = unit === 'mm' ? dpi / 25.4 : 1;
  doc.axiPrint = { trim: { w: o.w * k, h: o.h * k }, bleed: bleed * k, dpi: dpi };
  return doc;
}

// Internal: stroked, unfilled, locked straight lines. lines is [{x1,y1,x2,y2,name}]
// in spread px; weight is in px. One PolyCurve node per line, built the way
// Affinity's own crop-mark script builds them. Returns the nodes.
function axiMarkLines(doc, lines, weight, colour) {
  const { Curve, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const { FillDescriptor } = require('/fills.js');
  const { LineStyleDescriptor } = require('/linestyle.js');
  const none = FillDescriptor.createNone();
  const ink = FillDescriptor.createSolid(axiHex(colour));
  return lines.map(function (l) {
    const poly = PolyCurve.create();
    poly.addCurve(Curve.createLineXY(l.x1, l.y1, l.x2, l.y2));
    doc.addNode(PolyCurveNodeDefinition.create(poly, none, ink, LineStyleDescriptor.createDefault(weight), none));
    const node = doc.selection.nodes.first;
    axiName(node, l.name);
    node.lock();
    return node;
  });
}

// Proof sheet for a trim size: an artboard of trim + bleed + slug on every side,
// optional crop marks in the slug and guides at the trim and bleed edges. All
// lengths are in unit ('mm' default, or 'px'); markWeight is in points. Content
// goes at the returned trim box, backgrounds out to the bleed box.
function axiPrintSheet(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiPrintSheet: options {w,h} are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  const unit = o.unit === undefined ? 'mm' : o.unit;
  if (unit !== 'mm' && unit !== 'px') { throw new Error('axiPrintSheet: unit must be mm or px (got ' + JSON.stringify(o.unit) + ')'); }
  if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error('axiPrintSheet: w and h are required and must be positive'); }
  const name = o.name === undefined ? 'print-sheet' : o.name;
  if (typeof name !== 'string' || name === '') { throw new Error('axiPrintSheet: name must be a non-empty string'); }
  const u = function (v) { return unit === 'mm' ? axiMm(doc, v) : v; };
  const num = function (key, dflt, lo) {
    const v = o[key] === undefined ? dflt : o[key];
    if (!fin(v) || v < lo) { throw new Error('axiPrintSheet: ' + key + ' must be ' + (lo > 0 ? 'positive' : '0 or more') + ' (got ' + JSON.stringify(o[key]) + ')'); }
    return v;
  };
  const bleed = num('bleed', unit === 'mm' ? 3 : axiMm(doc, 3), 0);
  const marks = o.marks === undefined ? true : o.marks;
  if (typeof marks !== 'boolean') { throw new Error('axiPrintSheet: marks must be true or false'); }
  const markLength = num('markLength', unit === 'mm' ? 5 : axiMm(doc, 5), 1e-9);
  const markOffset = num('markOffset', unit === 'mm' ? 3 : axiMm(doc, 3), 0);
  const need = markOffset + markLength;
  const slug = num('slug', marks ? need + (unit === 'mm' ? 2 : axiMm(doc, 2)) : 0, 0);
  if (marks && slug < need - 1e-9) { throw new Error('axiPrintSheet: slug ' + slug + ' ' + unit + ' is smaller than markOffset + markLength; use at least ' + need + ' ' + unit); }
  const weightPt = num('markWeight', 0.25, 1e-9);
  const colour = o.markColour === undefined ? '#000000' : o.markColour;
  if (typeof colour !== 'string' || !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colour)) { throw new Error('axiPrintSheet: markColour must be a hex string (got ' + JSON.stringify(colour) + ')'); }
  if (o.guides !== undefined && typeof o.guides !== 'boolean') { throw new Error('axiPrintSheet: guides must be true or false'); }
  if ((o.x !== undefined && !fin(o.x)) || (o.y !== undefined && !fin(o.y))) { throw new Error('axiPrintSheet: x and y must be numbers'); }
  if ((o.x === undefined) !== (o.y === undefined)) { throw new Error('axiPrintSheet: give both x and y, or neither'); }

  const tw = u(o.w);
  const th = u(o.h);
  const bl = u(bleed);
  const sl = u(slug);
  const edge = bl + sl;
  const sw = tw + 2 * edge;
  const sh = th + 2 * edge;
  const spec = { name: name, w: sw, h: sh, fill: '#FFFFFF' };
  let origin;
  if (o.x !== undefined) {
    axiArtboard(doc, { name: name, x: o.x, y: o.y, w: sw, h: sh, fill: '#FFFFFF' });
    origin = { x: o.x, y: o.y };
  } else {
    origin = axiArtboards(doc, [spec])[0];
  }
  const trim = { x: origin.x + edge, y: origin.y + edge, w: tw, h: th };
  const bleedBox = { x: trim.x - bl, y: trim.y - bl, w: tw + 2 * bl, h: th + 2 * bl };
  const sheet = { x: origin.x, y: origin.y, w: sw, h: sh };
  axiOn(doc, name);

  let made = [];
  if (marks) {
    const len = u(markLength);
    const gap = bl + u(markOffset);
    const x0 = trim.x;
    const x1 = trim.x + tw;
    const y0 = trim.y;
    const y1 = trim.y + th;
    const lines = [
      [x0 - gap, y0, x0 - gap - len, y0], [x0, y0 - gap, x0, y0 - gap - len],
      [x1 + gap, y0, x1 + gap + len, y0], [x1, y0 - gap, x1, y0 - gap - len],
      [x0 - gap, y1, x0 - gap - len, y1], [x0, y1 + gap, x0, y1 + gap + len],
      [x1 + gap, y1, x1 + gap + len, y1], [x1, y1 + gap, x1, y1 + gap + len],
    ].map(function (l, i) { return { x1: l[0], y1: l[1], x2: l[2], y2: l[3], name: name + '-mark-' + (i + 1) }; });
    made = axiMarkLines(doc, lines, weightPt / 72 * doc.dpi, colour);
  }
  if (o.guides === true) {
    axiOn(doc, name);
    [trim.y, trim.y + th, bleedBox.y, bleedBox.y + bleedBox.h].forEach(function (p) { doc.addGuide(true, p); });
    [trim.x, trim.x + tw, bleedBox.x, bleedBox.x + bleedBox.w].forEach(function (p) { doc.addGuide(false, p); });
  }
  return { sheet: sheet, bleed: bleedBox, trim: trim, marks: made };
}
`;
