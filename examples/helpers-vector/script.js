// Lumen Studio demo for the vector helpers: a wordmark outlined into curves on
// ig-square, and a mark on its own 512x512 artboard built with boolean ops
// (a rounded square joined to a circle, with a smaller circle cut out). Run with
// --with-helpers; the document is found by the uuid in --args.
//
// The mark is built last on purpose: axiBool leaves its result selected, so
// `export <doc> "SVG (for export)" mark.svg --selection` exports exactly the mark
// as pure vector, and `export --artboard mark --square 32` makes the favicon.
// Subtract keeps the lowest shape of the stack and cuts the ones above it out,
// so the shape to keep is drawn first.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const MIST = '#F2F5F9';

// Wordmark: live text first, then converted to curves under the same name.
axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: INK, name: 'bg' });
axiText(doc, { x: 540, y: 620, text: 'lumen', font: 'Helvetica-Bold', size: 280, colour: MIST, align: 'c', name: 'wordmark' });
const word = axiOutline(doc, 'wordmark');

// Mark: union of a rounded square and a circle, minus a smaller circle.
const mark = axiArtboards(doc, [{ name: 'mark', w: 512, h: 512, fill: MIST }], { gap: 100 })[0];
axiOn(doc, 'mark');
axiRect(doc, { x: mark.x + 96, y: mark.y + 136, w: 280, h: 280, fill: SKY, radius: 72, name: 'mark-base' });
axiEllipse(doc, { x: mark.x + 216, y: mark.y + 96, w: 200, h: 200, fill: SKY, name: 'mark-moon' });
axiBool(doc, 'union', ['mark-base', 'mark-moon'], { name: 'mark-body' });
axiEllipse(doc, { x: mark.x + 176, y: mark.y + 196, w: 112, h: 112, fill: SKY, name: 'mark-hole' });
axiBool(doc, 'subtract', ['mark-body', 'mark-hole'], { name: 'logo-mark' });

console.log(JSON.stringify({ mark: 'union-subtract', outlined: typeof word.text !== 'string' }));
