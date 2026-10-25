// Live probe for axiPattern / axiPatternSeam (unit X). Run with --with-helpers and
// --args '{"uuid":"<document uuid>"}'; the document is the gallery demo document
// (examples/_brand/demo-doc.js). It never closes anything and never touches
// Document.current: finish with `doc save <uuid8> <path.af>` then `doc close <uuid8>`.
//
// It answers three questions, one JSON line:
//   A6  can a duplicated node (and a freshly drawn node) be moved into a
//       picture-frame rectangle with createMoveNodes (NodeMoveType.Inside)?
//       -> frame.moved / frame.drawn, with the copy's parent name
//   A7  can NodeRenderingEngine + PixelReaderRGBA8 read the rendered frame?
//       -> readback {w,h,pixels,error}
//   the helpers themselves: a 3x3 axiPattern and axiPatternSeam on it.
//
// RESULT (unit X, Affinity 3.3.1.4940, 2026-10-26):
//   A6 holds: a duplicated node and a freshly drawn node both move into a picture-frame
//      rectangle with createMoveNodes(selfSelection, frame, NodeMoveType.Inside,
//      NodeChildType.Main); frame.children grows, copy.parent isSameNode the frame, and the
//      render clips the children to the frame (frame.moved/drawn true, copyIsChild true).
//   A7 holds: NodeRenderingEngine.createDefault(frame, RGBA8).createCompatibleBitmap(true)
//      gives a bitmap of the frame's size at 1:1 (240x240 for a 240x240 frame) and
//      PixelReaderRGBA8 readPixel returns {r,g,b,alpha} ints; reader.dispose() is fine.
//      The seam metric discriminates: a 1080 wide frame of a 180 disc grid reads max 0, a
//      1000 wide one (period does not divide the width) reads max 166. axiPatternSeam
//      therefore stays in the public index.
const { Document } = require('/document.js');
const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');
const { Transform } = require('/geometry.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('probe document not found: ' + want); }

const msg = (e) => String(e && e.message ? e.message : e).slice(0, 200);
const out = { uuid: String(doc.sessionUuid) };
const inFrame = (frame, n) => Array.from(frame.children).some((c) => c.isSameNode(n));

axiOn(doc, 'ig-square');

// 1. A frame with a motif copy and a drawn node moved into it.
const frame = axiRect(doc, { x: 400, y: 400, w: 240, h: 240, fill: '#F2F5F9', frame: true, name: 'probe-frame' });
const motif = axiRect(doc, { x: 40, y: 40, w: 120, h: 120, fill: '#4C8DFF', name: 'probe-motif' });
out.frame = { pictureFrame: !!frame.pictureFrameEnabled, children0: Array.from(frame.children).length };
try {
  const copy = motif.duplicate(Transform.createTranslate(400, 400));
  copy.userDescription = 'probe-copy';
  doc.executeCommand(DocumentCommand.createMoveNodes(copy.selfSelection, frame, NodeMoveType.Inside, NodeChildType.Main));
  out.frame.moved = inFrame(frame, copy);
  out.frame.copyParent = String(copy.parent ? copy.parent.userDescription : null);
  out.frame.copyIsChild = !!(copy.parent && copy.parent.isSameNode(frame));
} catch (e) { out.frame.movedError = msg(e); }
try {
  const drawn = axiRect(doc, { x: 560, y: 560, w: 160, h: 160, fill: '#FFC857', name: 'probe-drawn' });
  doc.executeCommand(DocumentCommand.createMoveNodes(drawn.selfSelection, frame, NodeMoveType.Inside, NodeChildType.Main));
  out.frame.drawn = inFrame(frame, drawn);
} catch (e) { out.frame.drawnError = msg(e); }
out.frame.children1 = Array.from(frame.children).length;

// 2. Pixel readback of the frame at its four edges.
out.readback = {};
try {
  const { NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
  const { PixelReaderRGBA8 } = require('/pixelaccessor.js');
  const bitmap = NodeRenderingEngine.createDefault(frame, RasterFormat.RGBA8).createCompatibleBitmap(true);
  const rd = PixelReaderRGBA8.create(bitmap);
  const w = bitmap.width;
  const h = bitmap.height;
  out.readback.w = w;
  out.readback.h = h;
  out.readback.pixels = { left: rd.readPixel(0, Math.floor(h / 2)), right: rd.readPixel(w - 1, Math.floor(h / 2)), top: rd.readPixel(Math.floor(w / 2), 0), bottom: rd.readPixel(Math.floor(w / 2), h - 1), centre: rd.readPixel(Math.floor(w / 2), Math.floor(h / 2)) };
  rd.dispose();
} catch (e) { out.readback.error = msg(e); }

// 3. The helpers, on a second frame: 3x3 cells of 120, half-drop, draw callback.
out.helpers = {};
try {
  const r = axiPattern(doc, {
    x: 700, y: 100, w: 240, h: 240, tile: { w: 120, h: 120 }, offset: 'half', fill: '#1F2A44', name: 'probe-pattern',
    draw: (d, c) => axiEllipse(d, { x: c.x + 30, y: c.y + 30, w: 60, h: 60, fill: '#FFC857' }),
  });
  out.helpers.pattern = { cols: r.cols, rows: r.rows, count: r.count, cells: r.nodes.cells.length, frameChildren: Array.from(r.nodes.frame.children).length };
  try { out.helpers.seam = axiPatternSeam(doc, r.nodes.frame, { samples: 8 }); } catch (e) { out.helpers.seamError = msg(e); }
} catch (e) { out.helpers.patternError = msg(e); }

console.log(JSON.stringify(out));
