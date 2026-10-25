// Lumen Studio demo for `lint`: a small card with two planted problems, a 14 px
// caption (below the 20 px minimum) and a pill in a colour that is not in the
// brand kit. Everything else passes, so `lint` prints two warnings and exits 0.
// Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 60, y: 60, w: 960, h: 960, radius: 32, fill: '#FFC857', name: 'card' });
axiText(doc, { x: 120, y: 300, text: 'Light, measured', font: 'Helvetica-Bold', size: 48, colour: '#1F2A44', name: 'headline' });
axiText(doc, { x: 120, y: 420, text: 'Studio hours 9 to 5', font: 'Helvetica', size: 14, colour: '#1F2A44', name: 'caption' });
axiRect(doc, { x: 120, y: 820, w: 320, h: 96, radius: 48, fill: '#FF00AA', name: 'pill' });

console.log(JSON.stringify({ planted: ['caption 14 px', 'pill #FF00AA'] }));
