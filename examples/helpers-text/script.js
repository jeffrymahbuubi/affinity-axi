// Lumen Studio demo for the text helpers: a Helvetica-Bold headline on the
// ig-square artboard and a body paragraph that shrinks until it fits its box.
// Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#1F2A44', name: 'bg' });
axiText(doc, { x: 90, y: 330, text: 'Light for', font: 'Helvetica-Bold', size: 120, colour: '#F2F5F9', name: 'headline' });
axiText(doc, { x: 90, y: 470, text: 'every room', font: 'Helvetica-Bold', size: 120, colour: '#FFC857', name: 'headline-2' });
const fit = axiFitText(doc, {
  x: 90, y: 560, w: 760, h: 260,
  text: 'Lumen Studio designs warm, honest lighting for small spaces. Tell us the room and we send a plan within a day.',
  font: 'Helvetica', size: 64, minSize: 28, colour: '#F2F5F9', leading: 1.35, name: 'body',
});
console.log(JSON.stringify({ added: ['bg', 'headline', 'headline-2', 'body'], bodySize: fit.size, lines: fit.lines }));
