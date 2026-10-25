// Lumen Studio template for `fill`: a post whose fillable elements are named
// slot:<key> (headline, price, photo, cta). The kicker line is a plain
// "headline" element on purpose: fill never touches names without the slot:
// prefix, so it stays as designed. Run with --with-helpers; the document is
// found by the uuid in --args and the folder of this script arrives as ARGS.out.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
if (!ARGS.out) { throw new Error('ARGS.out (the folder holding photo.png) is missing; pass it in --args'); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#1F2A44', name: 'bg' });
axiText(doc, { x: 90, y: 70, text: 'LUMEN STUDIO', font: 'Helvetica-Bold', size: 34, colour: '#4C8DFF', name: 'headline' });
axiImage(doc, { path: ARGS.out + '/photo.png', x: 90, y: 130, w: 900, h: 560, fit: 'cover', radius: 40, name: 'slot:photo' });
axiRename(doc, 'slot:photo-frame', 'photo-frame'); // the frame is decoration; only the picture is a slot
axiText(doc, { x: 90, y: 730, text: 'Headline goes here', font: 'Helvetica-Bold', size: 72, colour: '#F2F5F9', name: 'slot:headline' });
axiText(doc, { x: 90, y: 860, text: 'Price', font: 'Helvetica', size: 48, colour: '#F2F5F9', name: 'slot:price' });
axiRect(doc, { x: 90, y: 950, w: 360, h: 80, radius: 40, fill: '#4C8DFF', name: 'slot:cta' });
axiText(doc, { x: 270, y: 1001, text: 'Book a session', font: 'Helvetica-Bold', size: 30, colour: '#1F2A44', align: 'c', name: 'cta-label' });
console.log(JSON.stringify({ slots: axiNames(doc).map((r) => r.name).filter((n) => n.indexOf('slot:') === 0) }));
