// Lumen Studio demo for the pattern helpers: a seamless half-drop background.
// Each 180 px cell draws a sky disc on its top-left corner (the frame cuts the
// discs on the edges into quarters and halves) and a sun dot in its centre;
// odd rows shift by half a tile; an ink label block sits on top so the pattern
// reads as a background. axiPatternSeam then compares the pixels where the
// tile would wrap. Colours are passed explicitly (the helpers never read a
// brand kit). Run with --with-helpers; the document is found by the uuid in
// --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';
const BODY = 'Helvetica';

axiOn(doc, 'ig-square');
const pattern = axiPattern(doc, {
  x: 0, y: 0, w: 1080, h: 1080, tile: { w: 180, h: 180 }, offset: 'half', fill: MIST, name: 'pattern',
  draw: (d, c) => [
    axiEllipse(d, { x: c.x - 36, y: c.y - 36, w: 72, h: 72, fill: SKY }),
    axiEllipse(d, { x: c.x + c.w / 2 - 18, y: c.y + c.h / 2 - 18, w: 36, h: 36, fill: SUN }),
  ],
});
const seam = axiPatternSeam(doc, pattern.nodes.frame, { samples: 16 });

// The label block on top of the pattern.
axiRect(doc, { x: 90, y: 400, w: 900, h: 280, fill: INK, radius: 16, name: 'label-block' });
axiText(doc, { x: 540, y: 550, text: 'Lumen Studio', font: BOLD, size: 110, colour: MIST, align: 'c', maxW: 780, name: 'label' });
axiText(doc, { x: 540, y: 630, text: 'Pattern tiles', font: BODY, size: 40, colour: SUN, align: 'c', name: 'label-sub' });

console.log(JSON.stringify({ cells: pattern.count, seam: seam.max }));
