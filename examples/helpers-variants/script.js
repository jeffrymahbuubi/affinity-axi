// Lumen Studio demo for the multi-size helpers: one launch post designed once on
// the ig-square master, then adapted to the story and og boards. axiAdapt copies
// the master's content with the default anchor rule (the background stretches,
// the logo stays top-left, the headline stays centred, the call to action stays
// at the bottom). If this Affinity build cannot move a copy between artboards,
// axiAdapt throws a message that points to axiVariants, and the script draws the
// same layout on each new board with one function instead. Run with
// --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';

// The whole design as one function of a board {x,y,w,h}: edge distances in px,
// so the master and the variants share the same recipe.
const layout = (b) => {
  axiOn(doc, b.name);
  axiRect(doc, { x: b.x, y: b.y, w: b.w, h: b.h, fill: INK, name: 'bg' });
  axiRect(doc, { x: b.x + 60, y: b.y + 60, w: 240, h: 72, fill: SUN, radius: 36, name: 'logo' });
  axiText(doc, { x: b.x + 180, y: b.y + 106, text: 'lumen', font: BOLD, size: 36, colour: INK, align: 'c', name: 'logo-label' });
  axiFitText(doc, { x: b.x + 140, y: b.y + b.h / 2 - 140, w: b.w - 280, h: 280, text: 'Light for every room', font: BOLD, size: 110, minSize: 40, maxLines: 2, colour: MIST, align: 'c', name: 'headline' });
  axiRect(doc, { x: b.x + 60, y: b.y + b.h - 180, w: 400, h: 100, fill: SUN, radius: 50, name: 'cta' });
  axiText(doc, { x: b.x + 260, y: b.y + b.h - 114, text: 'Book a session', font: BOLD, size: 40, colour: INK, align: 'c', name: 'cta-label' });
};

const specs = [{ platform: 'story' }, { platform: 'og' }];
const master = axiOn(doc, 'ig-square');
layout(master);

const out = { route: 'adapt', mode: 'anchor', boards: [], clamped: [] };
try {
  const boards = axiAdapt(doc, 'ig-square', specs);
  out.boards = boards.map((b) => b.name + ' ' + b.w + 'x' + b.h);
  boards.forEach((b) => b.clamped.forEach((n) => out.clamped.push(n)));
} catch (e) {
  if (String(e.message).indexOf('axiVariants') < 0) { throw e; }
  // Clean up boards a half-finished adapt left behind, then draw each size.
  specs.forEach((s) => axiFindAll(doc, s.platform).forEach((n) => n.delete()));
  const boards = axiVariants(doc, specs, layout);
  out.route = 'variants';
  out.boards = boards.map((b) => b.name + ' ' + b.w + 'x' + b.h);
}
out.names = axiNames(doc).filter((n) => /^(headline|cta)/.test(n.name)).map((n) => n.artboard + '/' + n.name);
console.log(JSON.stringify(out));
