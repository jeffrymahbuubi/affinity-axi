// Lumen Studio demo for `print`: a poster drawn on the demo document's ig-square
// artboard. The example's second command exports it with the default preset
// (PDF/X-4) and prints the offline preflight: header, PDF/X version, output
// intent, trim box, bleed, colour, fonts and page count. This document has no
// bleed (a 72 dpi pixel document), so the bleed row is a warning and says so;
// a print document from axiPrintDoc({bleed}) exported with --preset
// "PDF (press ready)" keeps its bleed. Run with --with-helpers; the document is
// found by the uuid in --args.
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

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: MIST, name: 'poster' });
axiRect(doc, { x: 0, y: 0, w: 1080, h: 420, fill: INK, name: 'poster-head' });
axiRect(doc, { x: 90, y: 150, w: 160, h: 12, fill: SUN, name: 'poster-rule' });
axiText(doc, { x: 90, y: 300, text: 'Lumen Studio', font: BOLD, size: 110, colour: MIST, name: 'poster-title' });
axiText(doc, { x: 90, y: 520, text: 'Open studio day', font: BOLD, size: 64, colour: INK, name: 'poster-line' });
axiText(doc, { x: 90, y: 600, text: 'Portraits, products and events', font: BODY, size: 40, colour: INK, name: 'poster-sub' });
axiRect(doc, { x: 90, y: 760, w: 380, h: 96, fill: SKY, radius: 48, name: 'poster-cta' });
axiText(doc, { x: 280, y: 822, text: 'Book a slot', font: BOLD, size: 40, colour: MIST, align: 'c', name: 'poster-cta-label' });

console.log(JSON.stringify({ poster: 'ig-square' }));
