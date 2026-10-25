// Lumen Studio demo for the print helpers: a proof sheet for a square card.
// axiPrintSheet adds an artboard of the trim size plus bleed plus slug, eight
// locked crop marks in the slug and guides at the trim and bleed edges; the
// card art runs out to the bleed box, the text stays inside the trim. The demo
// document is a 72 dpi pixel document, so the sheet is sized in px (24 px bleed,
// 48 px slug). A print document made with axiPrintDoc({unit: 'mm', bleed: 3,
// cmyk: true}) would size it in millimetres. Run with --with-helpers; the
// document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';
const BODY = 'Helvetica';

const sheet = axiPrintSheet(doc, { name: 'card-proof', w: 360, h: 360, unit: 'px', bleed: 24, slug: 48, guides: true });
const t = sheet.trim;
const b = sheet.bleed;

axiOn(doc, 'card-proof');
axiRect(doc, { x: b.x, y: b.y, w: b.w, h: b.h, fill: INK, name: 'card-bg' });
axiRect(doc, { x: b.x, y: t.y + t.h - 90, w: b.w, h: 90 + (b.y + b.h - (t.y + t.h)), fill: SKY, name: 'card-band' });
axiRect(doc, { x: t.x + 28, y: t.y + 40, w: 72, h: 8, fill: SUN, name: 'card-rule' });
axiText(doc, { x: t.x + 28, y: t.y + 120, text: 'Lumen Studio', font: BOLD, size: 44, colour: MIST, name: 'card-title' });
axiText(doc, { x: t.x + 28, y: t.y + 160, text: 'Portrait and product sessions', font: BODY, size: 18, colour: MIST, name: 'card-sub' });

console.log(JSON.stringify({ marks: sheet.marks.length }));
