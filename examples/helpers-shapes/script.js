// Lumen Studio demo for the shape helpers: rounded rectangles and an ellipse
// with hex fills and element names. Run with --with-helpers; the document is
// found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 90, y: 90, w: 900, h: 900, fill: '#1F2A44', radius: 72, name: 'card' });
axiEllipse(doc, { x: 640, y: 150, w: 300, h: 300, fill: '#FFC857', name: 'sun' });
axiRect(doc, { x: 150, y: 560, w: 420, h: 96, fill: '#4C8DFF', radius: 48, name: 'pill' });
axiRect(doc, { x: 150, y: 700, w: 780, h: 8, fill: '#F2F5F9', name: 'rule' });
console.log(JSON.stringify({ added: ['card', 'sun', 'pill', 'rule'] }));
