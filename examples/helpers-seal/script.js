// Lumen Studio demo for the seal helpers: an ink card with a promo seal in the
// middle. axiSeal draws a honey burst, a mist ring with a thin inner circle, text
// on the top and bottom arcs (the bottom text reads left to right and upright)
// and two centre lines that shrink to fit. Run with --with-helpers; the document
// is found by the uuid in --args.
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

const seal = axiSeal(doc, {
  cx: 540, cy: 540, r: 300,
  top: 'LUMEN STUDIO',
  bottom: 'EST. 2026',
  centre: [{ text: '-20%', font: BOLD, size: 150 }, 'studio hours'],
  font: BOLD, size: 40, colour: INK, spacing: 0.15,
  burst: { points: 28, depth: 0.1, fill: SUN },
  ring: { fill: MIST, stroke: INK, strokeWidth: 4, inset: 24 },
  name: 'seal',
});

const parts = ['burst', 'ring', 'top', 'bottom', 'centre'].filter((k) => seal.nodes[k] && (!Array.isArray(seal.nodes[k]) || seal.nodes[k].length));
console.log(JSON.stringify({ parts: parts }));
