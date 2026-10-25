// Web and price templates (og-card, price-post). Same rules as social.ts: kit
// tokens only, no colour or font literal, the shared support code first.

import { tplSource } from "./social.js";

export const OG_CARD: string = tplSource(
  "og-card",
  String.raw`
// Open Graph card, 1200x630: headline, one line, a call to action and the page address.
tplMain('og-card', 1200, 630, function (doc, t) {
  tplKicker(doc, t, 90, 110);
  axiType(doc, 'display', { x: 90, y: 260, text: 'Your headline', colour: t.ink, maxW: 1020, name: 'slot:headline' });
  axiType(doc, 'body', { x: 90, y: 340, text: 'One line that says why this page matters', colour: t.ink, maxW: 1020, name: 'slot:sub' });
  axiRect(doc, { x: 90, y: 380, w: 120, h: 8, fill: t.pop, name: 'divider' });
  tplCta(doc, t, { x: 90, y: 450, w: 340, h: 84 }, 'Read more');
  axiType(doc, 'body', { x: 750, y: 504, text: 'example.com/your-page', colour: t.ink, maxW: 360, name: 'slot:url' });
});
`,
);

export const PRICE_POST: string = tplSource(
  "price-post",
  String.raw`
// Price list post. The table is not a slot: pass ARGS.rows (up to 5 rows of up to 4 cells, header first) to change it.
function tplPriceRows() {
  const given = tplArgs().rows;
  const rows = given === undefined ? [['Session', 'Length', 'Price'], ['Portrait', '30 min', '49'], ['Studio', '60 min', '89'], ['Family', '90 min', '129']] : given;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5) { throw new Error('template price-post: rows must be 1 to 5 rows'); }
  const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (cols < 1 || cols > 4) { throw new Error('template price-post: rows need 1 to 4 cells each'); }
  rows.forEach(function (r, i) {
    if (!Array.isArray(r) || r.length !== cols) { throw new Error('template price-post: row ' + i + ' needs ' + cols + ' cells'); }
    r.forEach(function (c) {
      if (typeof c !== 'string' && !(typeof c === 'number' && isFinite(c))) { throw new Error('template price-post: row ' + i + ' has a cell that is not text or a number'); }
    });
  });
  return rows;
}

tplMain('price-post', 1080, 1080, function (doc, t, rows) {
  tplKicker(doc, t, 90, 110);
  axiType(doc, 'h1', { x: 90, y: 210, text: 'Prices this season', colour: t.ink, maxW: 900, name: 'slot:headline' });
  axiType(doc, 'body', { x: 90, y: 275, text: 'Simple pricing, no surprises', colour: t.ink, maxW: 900, name: 'slot:sub' });
  axiTable(doc, {
    x: 90, y: 320, w: 900, h: rows.length * 100,
    rows: rows,
    font: t.fonts[t.type.body.font],
    size: t.type.body.size,
    colour: t.ink,
    header: { font: t.fonts[t.type.h1.font], size: t.type.body.size, colour: t.ink },
    name: 'price-table'
  });
  axiType(doc, 'body', { x: 90, y: 870, text: 'Prices include tax. Offer ends soon.', colour: t.ink, maxW: 900, name: 'slot:footnote' });
  tplCta(doc, t, { x: 90, y: 910, w: 380, h: 84 }, 'Book now');
}, tplPriceRows);
`,
);
