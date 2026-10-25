// Lumen Studio demo for the carousel helper: five numbered 4:5 slides in a row.
// axiCarousel adds the boards slide-01 .. slide-05 beside ig-square, with an i/N
// counter in the top-right corner and a vector swipe chevron on every slide
// but the last. A headline per slide goes on top, each one named after its
// slide so it can be restyled by name. Export the lot in order with:
//   export <doc> PNG out/{name}.png --all-artboards
// Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';

const HEADLINES = [
  'Five rules of studio light',
  'Start with one soft source',
  'Put the window beside the subject',
  'Bounce light into the shadows',
  'Stop when it feels calm',
];

const slides = axiCarousel(doc, {
  platform: 'ig-portrait',
  count: HEADLINES.length,
  fill: MIST,
  number: { font: 'Helvetica', size: 36, colour: INK, pos: 'tr' },
  cue: { colour: SKY },
});

slides.forEach((s, i) => {
  axiOn(doc, s.name);
  axiFitText(doc, { x: s.x + 90, y: s.y + 420, w: s.w - 180, h: 420, text: HEADLINES[i], font: BOLD, size: 120, minSize: 60, maxLines: 4, colour: INK, name: s.name + '-headline' });
});

console.log(JSON.stringify({ slides: slides.map((s) => s.name) }));
