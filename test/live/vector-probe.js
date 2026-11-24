// Live probe for the 0.5.2 vector helpers (axiClip, axiPolygon, axiPath, axiRotate,
// axiLens; plan docs/plans/2026-11-24-helpers-plan.md, unit U0). It needs no
// document: it creates its own 1200x900 scratch document and logs {uuid} first.
// Run from tools/affinity-axi with the helpers appended:
//   affinity-axi run test/live/vector-probe.js --with-helpers --full
// then `affinity-axi render <uuid8>` and look at it (each case sits in its own grid
// cell, nodes are named probe-<case>). The script logs one JSON line per case,
// {case, threw, error, ...}, closes nothing and saves nothing: close the scratch
// document by hand with Don't Save.
//
// Clip cases draw a 200x200 parent (fill #F2F5F9) and a 300x300 red child over it, move
// the child into the parent with createMoveNodes(NodeMoveType.Inside), read the
// parent's bitmap and log {isChild, w, h, cornerAlpha, centre, pass}. pass = isChild,
// bitmap 200x200, cornerAlpha < 16, centre red.
// Other cases are information: the logged box, bitmap size and flags say what each
// helper may rely on (see the probe table of the plan for what each result decides).
//
// RESULT (Affinity 3.3.3.5004, Windows 11, 2026-11-24; run with --allow-blocking because the
//   close() guard matches CurveBuilder.close() and even a comment):
//   clip-frame-round:   pass (child clipped to 200x200, corner alpha 0, centre red)
//   clip-frame-ellipse: pass (ShapeEllipse with pictureFrameEnabled = true clips)
//   clip-plain-round:   pass (a plain rounded rect clips its moved-in child too)
//   clip-plain-ellipse: pass
//   clip-plain-poly:    pass (a plain PolyCurve clips) -> plain = true
//   clip-frame-poly:    pass (info)
//   poly-close:         pass, CurveBuilder.close() works; bitmap 180x180 = geometry (no outline added)
//   poly-nopen:         pass, closing with lineToXY works; bitmap 180x180 (no outline)
//   path-bezier:        pass, addBezierXY works (box 100x75) -> ship axiPath
//   rotate-command:     pass (200x100 -> 100x200 about the centre)
//   rotate-apply:       pass (same result)
//   rotate-bool:        works; the probe's "box widened" test is wrong for this shape:
//                       240x100 -> 240.4x240.4 is the correct 45 degree box (h grew 100 -> 240)
//   rotate-text:        pass (122x35 -> 35x122)
//   GOTCHA: after createMoveNodes(Inside) the NEXT created node is inserted inside that
//   container (inspect showed every later case nested in the previous frame, so the
//   composite render hid them). axiClip must leave the insertion point outside the frame
//   (e.g. select the frame's parent / spread, or move later nodes out), and a test must
//   check that a shape drawn after axiClip is a sibling of the frame, not its child.
const { Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');
const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');

const doc = axiDoc(1200, 900);
console.log(JSON.stringify({ uuid: String(doc.sessionUuid).slice(0, 8), full: String(doc.sessionUuid) }));

const CELL = 290;
let slot = 0;
function cell() {
  const i = slot;
  slot += 1;
  return { x: 40 + (i % 4) * CELL, y: 40 + Math.floor(i / 4) * CELL };
}

function report(label, run) {
  try {
    const extra = run() || {};
    console.log(JSON.stringify(Object.assign({ case: label, threw: false, error: null }, extra)));
  } catch (e) {
    console.log(JSON.stringify({ case: label, threw: true, error: String(e && e.message ? e.message : e) }));
  }
}

const same = function (a, b) { return a === b || (typeof a.isSameNode === 'function' && a.isSameNode(b)); };

// Render a node and read size, one corner pixel and the centre pixel.
function readback(node) {
  const { NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
  const { PixelReaderRGBA8 } = require('/pixelaccessor.js');
  let reader = null;
  try {
    const bitmap = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8).createCompatibleBitmap(true);
    reader = PixelReaderRGBA8.create(bitmap);
    const w = bitmap.width;
    const h = bitmap.height;
    const c = reader.readPixel(2, 2);
    const m = reader.readPixel(Math.floor(w / 2), Math.floor(h / 2));
    return { w: w, h: h, cornerAlpha: c.alpha, centre: { r: m.r, g: m.g, b: m.b, a: m.alpha } };
  } finally {
    if (reader) { reader.dispose(); }
  }
}

// Draw the red child over the parent, move it Inside, read the parent back.
function clipCase(label, makeParent) {
  report(label, function () {
    const o = cell();
    const parent = makeParent(o.x + 50, o.y + 50, 'probe-' + label);
    const child = axiRect(doc, { x: o.x, y: o.y, w: 300, h: 300, fill: '#FF0000', name: 'probe-' + label + '-child' });
    doc.executeCommand(DocumentCommand.createMoveNodes(child.selfSelection, parent, NodeMoveType.Inside, NodeChildType.Main));
    const isChild = Array.from(parent.children).some(function (c) { return same(c, child); });
    const out = { isChild: isChild, pictureFrameEnabled: parent.pictureFrameEnabled };
    if (isChild) { Object.assign(out, readback(parent)); }
    out.pass = isChild && out.w === 200 && out.h === 200 && out.cornerAlpha < 16 && !!out.centre && out.centre.r > 200 && out.centre.g < 60 && out.centre.b < 60;
    return out;
  });
}

function triangle(x, y, frame, name) {
  const { CurveBuilder, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const { FillDescriptor } = require('/fills.js');
  const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
  const b = new CurveBuilder().beginXY(x + 100, y).lineToXY(x + 200, y + 200).lineToXY(x, y + 200).lineToXY(x + 100, y);
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  const none = FillDescriptor.createNone();
  const def = PolyCurveNodeDefinition.create(pc, FillDescriptor.createSolid(axiHex('#F2F5F9')), none, LineStyleDescriptor.create(LineStyle.create({ weight: 1 })), none);
  if (frame) { def.pictureFrameEnabled = true; }
  doc.addNode(def);
  return axiName(doc.selection.nodes.first, name);
}

function ellipseFrame(x, y, name) {
  const { ShapeEllipse } = require('/shapes.js');
  const { ShapeNodeDefinition } = require('/nodes.js');
  const def = ShapeNodeDefinition.create(ShapeEllipse.create(), { x: x, y: y, width: 200, height: 200 }, axiHex('#F2F5F9'), null, null);
  def.pictureFrameEnabled = true;
  doc.addNode(def);
  return axiName(doc.selection.nodes.first, name);
}

clipCase('clip-frame-round', function (x, y, name) {
  return axiRect(doc, { x: x, y: y, w: 200, h: 200, radius: 60, fill: '#F2F5F9', frame: true, name: name });
});
clipCase('clip-frame-ellipse', function (x, y, name) { return ellipseFrame(x, y, name); });
clipCase('clip-plain-round', function (x, y, name) {
  return axiRect(doc, { x: x, y: y, w: 200, h: 200, radius: 60, fill: '#F2F5F9', name: name });
});
clipCase('clip-plain-ellipse', function (x, y, name) {
  return axiEllipse(doc, { x: x, y: y, w: 200, h: 200, fill: '#F2F5F9', name: name });
});
clipCase('clip-plain-poly', function (x, y, name) { return triangle(x, y, false, name); });
clipCase('clip-frame-poly', function (x, y, name) { return triangle(x, y, true, name); });

// A solid triangle with the pen set to FillDescriptor.createNone() and weight 1
// (the no-stroke form axiPolygon and axiPath use). closeWith: 'close' calls
// CurveBuilder.close(), 'line' ends with a lineToXY back to the first point.
function polyCase(label, closeWith) {
  report(label, function () {
    const { CurveBuilder, PolyCurve } = require('/geometry.js');
    const { PolyCurveNodeDefinition } = require('/nodes.js');
    const { FillDescriptor } = require('/fills.js');
    const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
    const o = cell();
    axiSurface(doc);
    const b = new CurveBuilder().beginXY(o.x + 100, o.y + 20).lineToXY(o.x + 200, o.y + 200).lineToXY(o.x + 20, o.y + 200);
    let closed = 'lineToXY';
    if (closeWith === 'close') {
      try { b.close(); closed = 'close()'; } catch (e) { closed = 'close() threw: ' + String(e && e.message ? e.message : e); }
    } else {
      b.lineToXY(o.x + 100, o.y + 20);
    }
    const pc = PolyCurve.create();
    pc.addCurve(b.createCurve());
    const none = FillDescriptor.createNone();
    doc.addNode(PolyCurveNodeDefinition.create(pc, FillDescriptor.createSolid(axiHex('#2F6FED')), none, LineStyleDescriptor.create(LineStyle.create({ weight: 1 })), none));
    const n = axiName(doc.selection.nodes.first, 'probe-' + label);
    const r = readback(n);
    return { closed: closed, box: axiNodeBox(n), bitmap: { w: r.w, h: r.h }, centre: r.centre };
  });
}
polyCase('poly-close', 'close');
polyCase('poly-nopen', 'line');

report('path-bezier', function () {
  const { CurveBuilder, PolyCurve } = require('/geometry.js');
  const { PolyCurveNodeDefinition } = require('/nodes.js');
  const { FillDescriptor } = require('/fills.js');
  const { LineStyle, LineStyleDescriptor } = require('/linestyle.js');
  const o = cell();
  axiSurface(doc);
  const b = new CurveBuilder().beginXY(o.x + 20, o.y + 20).addBezierXY(o.x + 20, o.y + 120, o.x + 120, o.y + 120, o.x + 120, o.y + 20).lineToXY(o.x + 20, o.y + 20);
  const pc = PolyCurve.create();
  pc.addCurve(b.createCurve());
  const none = FillDescriptor.createNone();
  doc.addNode(PolyCurveNodeDefinition.create(pc, FillDescriptor.createSolid(axiHex('#2F6FED')), none, LineStyleDescriptor.create(LineStyle.create({ weight: 1 })), none));
  const n = axiName(doc.selection.nodes.first, 'probe-path-bezier');
  return { box: axiNodeBox(n) };
});

// Rotate n about its box centre; mode 'command' = DocumentCommand.createTransform,
// 'apply' = doc.applyTransform(xf, n).
function rotateNode(n, angle, mode) {
  const b = axiNodeBox(n);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const xf = Transform.createTranslate(cx, cy).multiply(Transform.createRotate(angle)).multiply(Transform.createTranslate(-cx, -cy));
  if (mode === 'apply') { doc.applyTransform(xf, n); }
  else { doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, n), xf)); }
}

function rotateCase(label, mode) {
  report(label, function () {
    const o = cell();
    const n = axiRect(doc, { x: o.x + 20, y: o.y + 60, w: 200, h: 100, fill: '#2F6FED', name: 'probe-' + label });
    const before = axiNodeBox(n);
    rotateNode(n, Math.PI / 2, mode);
    const after = axiNodeBox(n);
    return { before: before, after: after, pass: Math.abs(after.w - before.h) < 1 && Math.abs(after.h - before.w) < 1 };
  });
}
rotateCase('rotate-command', 'command');
rotateCase('rotate-apply', 'apply');

report('rotate-bool', function () {
  const o = cell();
  axiRect(doc, { x: o.x + 20, y: o.y + 60, w: 160, h: 80, fill: '#2F6FED', name: 'probe-rotate-bool-a' });
  axiRect(doc, { x: o.x + 100, y: o.y + 80, w: 160, h: 80, fill: '#2F6FED', name: 'probe-rotate-bool-b' });
  const n = axiBool(doc, 'union', ['probe-rotate-bool-a', 'probe-rotate-bool-b'], { name: 'probe-rotate-bool' });
  const before = axiNodeBox(n);
  rotateNode(n, Math.PI / 4, 'command');
  const after = axiNodeBox(n);
  return { before: before, after: after, pass: after.w > before.w + 1 };
});

report('rotate-text', function () {
  const o = cell();
  const n = axiText(doc, { x: o.x + 20, y: o.y + 140, text: 'Probe', font: 'ArialMT', size: 48, colour: '#2F6FED' });
  axiName(n, 'probe-rotate-text');
  const before = axiNodeBox(n);
  rotateNode(n, Math.PI / 2, 'command');
  const after = axiNodeBox(n);
  return { before: before, after: after, pass: Math.abs(after.w - before.h) < 2 && Math.abs(after.h - before.w) < 2 };
});
