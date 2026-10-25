// Lumen Studio demo for the QR helper: an ink card with a headline, a URL code
// on a mist square at the bottom left and a WhatsApp code at the bottom right.
// The codes are native vector shapes (ink modules on mist), so they stay sharp
// at any export size. Run with --with-helpers; the document is found by the
// uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: INK, name: 'card' });
axiFitText(doc, { x: 90, y: 90, w: 900, h: 330, text: 'Scan for the studio light guide', font: BOLD, size: 120, minSize: 60, maxLines: 3, colour: MIST, name: 'headline' });
axiRect(doc, { x: 90, y: 450, w: 160, h: 10, fill: SUN, name: 'rule' });

// URL code: 360 px on a mist square with a 36 px quiet zone.
axiQR(doc, { x: 100, y: 540, size: 360, payload: { type: 'url', url: 'https://example.com/lumen' }, fill: INK, bg: MIST, quiet: 36, name: 'lumen-url' });
axiText(doc, { x: 280, y: 1000, text: 'The light guide', font: BOLD, size: 34, colour: MIST, align: 'c', name: 'url-label' });

// WhatsApp code: 200 px, default quiet zone (10 percent).
axiQR(doc, { x: 780, y: 700, size: 200, payload: { type: 'whatsapp', number: '+15550100123', content: 'Hi Lumen' }, fill: INK, bg: MIST, name: 'lumen-wa' });
axiText(doc, { x: 880, y: 960, text: 'Chat with us', font: BOLD, size: 34, colour: MIST, align: 'c', name: 'wa-label' });

console.log(JSON.stringify({ codes: ['lumen-url', 'lumen-wa'] }));
