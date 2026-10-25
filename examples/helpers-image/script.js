// Lumen Studio demo for the image helper: photo.png (next to this script)
// placed with cover fit, rounded corners and a focus point, plus a caption.
// Run with --with-helpers; the document is found by the uuid in --args and the
// folder of this script arrives as ARGS.out.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
if (!ARGS.out) { throw new Error('ARGS.out (the folder holding photo.png) is missing; pass it in --args'); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#F2F5F9', name: 'bg' });
axiImage(doc, { path: ARGS.out + '/photo.png', x: 90, y: 90, w: 900, h: 700, fit: 'cover', radius: 48, focus: { x: 0.72, y: 0.4 }, name: 'photo' });
axiText(doc, { x: 90, y: 900, text: 'Evening light, Lumen Studio', font: 'Helvetica-Bold', size: 56, colour: '#1F2A44', name: 'caption' });
console.log(JSON.stringify({ added: ['bg', 'photo', 'caption'] }));
