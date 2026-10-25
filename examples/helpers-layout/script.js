// Lumen Studio demo for the layout helpers: three artboards, one launch post
// per platform. axiPlatform and axiArtboard add the og board under ig-square,
// axiArtboards adds the story board beside them, axiOn selects each board,
// axiFitText shrinks the headline until it fits its box, and axiSafeZone draws
// the Stories bands last so they sit on top. Run with --with-helpers; the
// document is found by the uuid in --args and the folder of this script (it
// holds photo.png) arrives as ARGS.out.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
if (!ARGS.out) { throw new Error('ARGS.out (the folder holding photo.png) is missing; pass it in --args'); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';
const photo = ARGS.out + '/photo.png';
const HEADLINE = 'Light for every room, measured in the studio';

// Boards: og under ig-square (axiPlatform gives its size), then story beside both.
const og = axiPlatform('og');
axiArtboard(doc, { name: 'og', x: 0, y: 1140, w: og.w, h: og.h, fill: SKY });
const story = axiArtboards(doc, [{ platform: 'story', fill: INK }], { gap: 60 })[0];
const sq = axiOn(doc, 'ig-square');
const o = axiOn(doc, 'og');

// A pill: rounded sun rectangle with a centred label.
const pill = (x, y, w, h, label, size) => {
  axiRect(doc, { x: x, y: y, w: w, h: h, fill: SUN, radius: h / 2, name: 'pill' });
  axiText(doc, { x: x + w / 2, y: y + h / 2 + size * 0.36, text: label, font: BOLD, size: size, colour: INK, align: 'c', name: 'pill-label' });
};

// ig-square: photo, translucent caption chip over the sky, fitted headline, pill.
axiOn(doc, 'ig-square');
axiImage(doc, { path: photo, x: sq.x + 60, y: sq.y + 60, w: 960, h: 600, fit: 'cover', radius: 48, focus: { x: 0.72, y: 0.4 }, name: 'photo' });
axiRect(doc, { x: sq.x + 100, y: sq.y + 100, w: 290, h: 72, fill: INK, fillAlpha: 0.6, radius: 36, name: 'chip' });
axiText(doc, { x: sq.x + 245, y: sq.y + 148, text: 'Evening light', font: BOLD, size: 34, colour: MIST, align: 'c', name: 'chip-label' });
const head = axiFitText(doc, { x: sq.x + 60, y: sq.y + 700, w: 960, h: 190, text: HEADLINE, font: BOLD, size: 120, minSize: 48, maxLines: 2, colour: INK, name: 'headline' });
pill(sq.x + 60, sq.y + 940, 320, 80, 'lumen.studio', 36);

// og: photo on the left, headline and pill on the right.
axiOn(doc, 'og');
axiImage(doc, { path: photo, x: o.x, y: o.y, w: 600, h: 630, fit: 'cover', focus: { x: 0.72, y: 0.4 }, name: 'photo' });
axiFitText(doc, { x: o.x + 650, y: o.y + 70, w: 500, h: 320, text: HEADLINE, font: BOLD, size: 120, minSize: 40, maxLines: 4, colour: INK, name: 'headline' });
pill(o.x + 650, o.y + 480, 300, 76, 'lumen.studio', 32);

// story: photo, headline and pill, all between the bands.
axiOn(doc, 'story');
axiImage(doc, { path: photo, x: story.x, y: story.y + 250, w: 1080, h: 920, fit: 'cover', focus: { x: 0.72, y: 0.4 }, name: 'photo' });
axiFitText(doc, { x: story.x + 90, y: story.y + 1210, w: 900, h: 190, text: HEADLINE, font: BOLD, size: 120, minSize: 48, maxLines: 2, colour: MIST, name: 'headline' });
pill(story.x + 90, story.y + 1450, 320, 80, 'lumen.studio', 36);
axiSafeZone(doc, 'story', 'story', { overlay: true });

console.log(JSON.stringify({ artboards: doc.artboards.map((a) => a.description), headline: { size: head.size, lines: head.lines } }));
