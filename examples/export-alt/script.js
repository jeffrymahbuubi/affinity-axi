// Lumen Studio demo for the alt-text stub: a mist card on ig-square with a
// headline and one line below it. `export` reads the document's text top-down
// and prints it as `alt: Light, measured. Studio hours`; edit it before
// publishing. Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#F2F5F9', name: 'bg' });
axiRect(doc, { x: 90, y: 560, w: 120, h: 12, fill: '#FFC857', name: 'rule' });
axiText(doc, { x: 90, y: 440, text: 'Light, measured', font: 'Helvetica-Bold', size: 112, colour: '#1F2A44', name: 'headline' });
axiText(doc, { x: 90, y: 680, text: 'Studio hours', font: 'Helvetica', size: 56, colour: '#1F2A44', name: 'hours' });
console.log(JSON.stringify({ added: ['bg', 'rule', 'headline', 'hours'] }));
