// Lumen Studio demo for the named-element helpers: build a card with named
// elements, then change it by name only (text, fill, box) and show that an
// ambiguous name is refused. Run with --with-helpers; the document is found
// by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#1F2A44', name: 'bg' });
axiText(doc, { x: 90, y: 360, text: 'Draft headline', font: 'Helvetica-Bold', size: 84, colour: '#F2F5F9', name: 'headline' });
axiRect(doc, { x: 90, y: 820, w: 360, h: 110, radius: 55, fill: '#4C8DFF', name: 'cta' });
axiRect(doc, { x: 630, y: 820, w: 360, h: 110, radius: 55, fill: '#4C8DFF', name: 'cta' });

// Edit by name, as a later session would after `inspect --named`.
axiSetText(doc, 'headline', 'Light for every room');
axiSetFill(doc, 'bg', '#24324F');
axiSetFill(doc, '#0/0/3', '#FFC857');
axiSetBox(doc, '#0/0/3', { w: 420 });

let ambiguous = '';
try { axiFind(doc, 'cta'); } catch (e) { ambiguous = String(e.message).split(';')[0]; }

console.log(JSON.stringify({ named: axiNames(doc).map((r) => r.name).filter(Boolean), ambiguous }));
