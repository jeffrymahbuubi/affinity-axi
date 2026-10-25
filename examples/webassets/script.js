// Lumen Studio demo for `webassets`: the four artboards a website launch needs,
// named the way the command looks for them. `mark` is the square logo mark with
// a fill (it becomes the favicon set, so the fill is the apple-touch-icon
// ground), `og` and `x-card` are the share cards, `hero` is a responsive
// banner exported as hero.png, hero@2x.png, hero.webp and hero@2x.webp. Run with
// --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const SUN = '#FFC857';
const MIST = '#F2F5F9';

// Square mark artboard first, then the cards and the banner to its right
// (sizes come from the platform table: og 1200x630, x-card 1200x600, web-hero 1920x1080).
const mark = axiArtboards(doc, [{ name: 'mark', w: 512, h: 512, fill: MIST }], { gap: 100 })[0];
const boards = axiArtboards(doc, [
  { name: 'og', platform: 'og', fill: INK },
  { name: 'x-card', platform: 'x-card', fill: SKY },
  { name: 'hero', platform: 'web-hero', fill: MIST },
], { gap: 100 });
const og = boards[0];
const xc = boards[1];
const hero = boards[2];

axiOn(doc, 'og');
axiText(doc, { x: og.x + 600, y: og.y + 340, text: 'lumen', font: 'Helvetica-Bold', size: 200, colour: MIST, align: 'c', name: 'og-title' });
axiText(doc, { x: og.x + 600, y: og.y + 440, text: 'light for small studios', font: 'Helvetica', size: 48, colour: SUN, align: 'c', name: 'og-tagline' });

axiOn(doc, 'x-card');
axiText(doc, { x: xc.x + 600, y: xc.y + 330, text: 'lumen', font: 'Helvetica-Bold', size: 200, colour: INK, align: 'c', name: 'x-title' });
axiText(doc, { x: xc.x + 600, y: xc.y + 430, text: 'light for small studios', font: 'Helvetica', size: 48, colour: MIST, align: 'c', name: 'x-tagline' });

axiOn(doc, 'hero');
axiEllipse(doc, { x: hero.x + 1180, y: hero.y + 180, w: 560, h: 560, fill: SUN, name: 'hero-sun' });
axiText(doc, { x: hero.x + 160, y: hero.y + 560, text: 'lumen', font: 'Helvetica-Bold', size: 280, colour: INK, name: 'hero-title' });
axiText(doc, { x: hero.x + 170, y: hero.y + 680, text: 'light for small studios', font: 'Helvetica', size: 64, colour: SKY, name: 'hero-tagline' });

// The mark is built last: axiBool leaves its result selected. Subtract keeps the
// lowest shape of the stack, so the shape to keep is drawn first.
axiOn(doc, 'mark');
axiRect(doc, { x: mark.x + 96, y: mark.y + 136, w: 280, h: 280, fill: SKY, radius: 72, name: 'mark-base' });
axiEllipse(doc, { x: mark.x + 216, y: mark.y + 96, w: 200, h: 200, fill: SKY, name: 'mark-moon' });
axiBool(doc, 'union', ['mark-base', 'mark-moon'], { name: 'mark-body' });
axiEllipse(doc, { x: mark.x + 176, y: mark.y + 196, w: 112, h: 112, fill: SKY, name: 'mark-hole' });
axiBool(doc, 'subtract', ['mark-body', 'mark-hole'], { name: 'logo-mark' });

console.log(JSON.stringify({ artboards: ['mark', 'og', 'x-card', 'hero'] }));
