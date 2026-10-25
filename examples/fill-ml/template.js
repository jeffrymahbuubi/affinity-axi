// Template for the `fill-ml` example: one picture slot (slot:photo inside photo-frame) and a
// headline slot. Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
if (!ARGS.out) { throw new Error('ARGS.out (the example folder) is missing; pass it in --args'); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#E9E4DA', name: 'bg' });
axiText(doc, { x: 90, y: 70, text: 'MORNING SHOP', font: 'Helvetica-Bold', size: 34, colour: '#8A5A3C', name: 'kicker' });
// The placeholder photo keeps the slot a picture; fill swaps in the record's photo and cuts it out.
axiImage(doc, { path: ARGS.out + '/../_photos/street-1930s.jpg', x: 90, y: 130, w: 900, h: 640, fit: 'cover', radius: 40, name: 'slot:photo' });
axiRename(doc, 'slot:photo-frame', 'photo-frame'); // the frame is decoration; only the picture is a slot
axiText(doc, { x: 90, y: 850, text: 'Headline goes here', font: 'Helvetica-Bold', size: 72, colour: '#3A2A1E', name: 'slot:headline' });
console.log(JSON.stringify({ slots: axiNames(doc).map((r) => r.name).filter((n) => n.indexOf('slot:') === 0) }));
