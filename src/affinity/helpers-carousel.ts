// Carousel helpers for run --with-helpers: a row of identical numbered slides,
// and a panorama split across slides. Same rules as helpers-core.ts (function
// declarations prefixed axi, requires inside functions, nothing blocking or
// generative, String.raw so no backticks or ${).
//
// Built on axiArtboards, axiOn, axiText, axiRect and axiEllipse. The swipe cue
// is drawn from shapes only (a pill with a chevron made of two rotated bars),
// so it needs no font. axiCarouselSplit copies the master's content with
// axiClone, the clone primitive of helpers-variants.ts, so that family must be
// spliced in as well.

import type { HelperInfo } from "./helpers-core.js";

export const CAROUSEL_INDEX: readonly HelperInfo[] = [
  { name: "axiCarousel", signature: "axiCarousel(doc, {platform|w,h, count, prefix, fill, gap, number, cue})", summary: "count (2-20) identical artboards named <prefix>-01 ... (prefix default slide) in a row, gap px apart (default 100); number {font,size,colour,pos:tl|tr|bl|br,pad} draws i/N on every slide (<slide>-number), cue {colour,glyph,size,pad} draws a vector swipe chevron in a pill on every slide but the last (<slide>-cue, arms <slide>-cue-arm-1/2); both optional, true takes the defaults; returns [{name,x,y,w,h,index}] with index from 1; export with --all-artboards for files in order" },
  { name: "axiCarouselSplit", signature: "axiCarouselSplit(doc, master, {platform|w,h, slides, prefix, overlap, gap, fill})", summary: "split the artboard named master (a panorama at least slides*w - (slides-1)*overlap wide) into slides (2-20) boards named <prefix>-01 ...: each gets a copy of the master's content shifted by -i*(w-overlap) through axiClone; the master is left as it is; returns [{name,x,y,w,h,index}]" },
];

/** Internal building blocks, not in the index. */
export const CAROUSEL_INTERNAL: readonly string[] = ["axiCarouselDecor"];

export const CAROUSEL_SOURCE: string = String.raw`
// Internal: numbers and swipe cues on boards [{name,x,y,w,h}] from axiArtboards.
// number and cue are false/undefined (skipped), true (defaults) or an options
// object. All options are validated first, so calling it with boards = [] is a
// dry run that throws on bad options without touching the document. The cue is
// a pill (axiEllipse) holding a chevron made of two rounded bars rotated +-45
// degrees; each bar is placed by measuring it after the rotation, so it does not
// matter which point Affinity rotates about. Returns the names of the nodes made.
function axiCarouselDecor(doc, boards, number, cue) {
  const hexOk = function (c) { return typeof c === 'string' && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c); };
  let num = null;
  let cu = null;
  if (number) {
    const n = number === true ? {} : number;
    if (typeof n !== 'object') { throw new Error('axiCarousel: number must be true or an options object'); }
    num = { font: n.font || 'Helvetica', size: n.size === undefined ? 36 : n.size, colour: n.colour || '#1F2A44', pos: n.pos || 'tr', pad: n.pad === undefined ? 48 : n.pad };
    if (['tl', 'tr', 'bl', 'br'].indexOf(num.pos) < 0) { throw new Error('axiCarousel: number.pos must be tl, tr, bl or br'); }
    if (typeof num.font !== 'string') { throw new Error('axiCarousel: number.font must be a postscriptName'); }
    if (!(num.size > 0)) { throw new Error('axiCarousel: number.size must be positive'); }
    if (!(num.pad >= 0)) { throw new Error('axiCarousel: number.pad must be 0 or more'); }
    if (!hexOk(num.colour)) { throw new Error('axiCarousel: number.colour must be a hex colour'); }
  }
  if (cue) {
    const c = cue === true ? {} : cue;
    if (typeof c !== 'object') { throw new Error('axiCarousel: cue must be true or an options object'); }
    cu = { colour: c.colour || '#1F2A44', glyph: c.glyph || '#FFFFFF', size: c.size === undefined ? 96 : c.size, pad: c.pad === undefined ? 24 : c.pad };
    if (!(cu.size > 0)) { throw new Error('axiCarousel: cue.size must be positive'); }
    if (!(cu.pad >= 0)) { throw new Error('axiCarousel: cue.pad must be 0 or more'); }
    if (!hexOk(cu.colour) || !hexOk(cu.glyph)) { throw new Error('axiCarousel: cue.colour and cue.glyph must be hex colours'); }
  }
  const made = [];
  if (boards.length === 0 || (!num && !cu)) { return made; }
  const { Transform } = require('/geometry.js');
  boards.forEach(function (b, i) {
    if (num) {
      axiOn(doc, b.name);
      const left = num.pos === 'tl' || num.pos === 'bl';
      const top = num.pos === 'tl' || num.pos === 'tr';
      axiText(doc, {
        x: left ? b.x + num.pad : b.x + b.w - num.pad,
        y: top ? b.y + num.pad + num.size * 0.72 : b.y + b.h - num.pad,
        text: (i + 1) + '/' + boards.length, font: num.font, size: num.size, colour: num.colour,
        align: left ? 'l' : 'r', name: b.name + '-number',
      });
      made.push(b.name + '-number');
    }
    if (cu && i < boards.length - 1) {
      axiOn(doc, b.name);
      const d = cu.size;
      const cx = b.x + b.w - cu.pad - d / 2;
      const cy = b.y + b.h / 2;
      axiEllipse(doc, { x: cx - d / 2, y: cy - d / 2, w: d, h: d, fill: cu.colour, name: b.name + '-cue' });
      made.push(b.name + '-cue');
      const len = d * 0.34;
      const thick = Math.max(3, d * 0.09);
      const arm = len / Math.SQRT2;
      [[1, -arm / 2], [-1, arm / 2]].forEach(function (a, k) {
        axiRect(doc, { x: cx - len / 2, y: cy - thick / 2, w: len, h: thick, fill: cu.glyph, radius: thick / 2, name: b.name + '-cue-arm-' + (k + 1) });
        doc.applyTransform(Transform.createRotate(a[0] * Math.PI / 4));
        const m = axiMeasure(doc);
        axiMove(doc, cx - (m.x + m.w / 2), cy + a[1] - (m.y + m.h / 2));
        made.push(b.name + '-cue-arm-' + (k + 1));
      });
    }
  });
  return made;
}

// count (2-20) identical artboards named <prefix>-01 ... in a row (platform key,
// or w and h), gap px apart (default 100), each filled with the optional hex
// fill. number and cue (see axiCarouselDecor) add the i/N counter and the swipe
// chevron, both named after the slide so they can be restyled or deleted by name.
// Returns [{name,x,y,w,h,index}] with index counting from 1. Export the whole
// run with: export <doc> PNG out/{name}.png --all-artboards.
function axiCarousel(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiCarousel: options are required ({platform|w,h, count})'); }
  if (typeof o.count !== 'number' || Math.floor(o.count) !== o.count || o.count < 2 || o.count > 20) { throw new Error('axiCarousel: count must be a whole number from 2 to 20'); }
  const prefix = o.prefix === undefined ? 'slide' : o.prefix;
  if (typeof prefix !== 'string' || prefix === '') { throw new Error('axiCarousel: prefix must be a non-empty string'); }
  if (o.gap !== undefined && !(o.gap >= 0)) { throw new Error('axiCarousel: gap must be 0 or more'); }
  if (o.fill !== undefined && !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(o.fill))) { throw new Error('axiCarousel: fill must be a hex colour'); }
  const p = o.platform ? axiPlatform(o.platform) : null;
  const w = o.w || (p && p.w);
  const h = o.h || (p && p.h);
  if (!(w > 0 && h > 0)) { throw new Error('axiCarousel: give a platform key or w and h'); }
  axiCarouselDecor(doc, [], o.number, o.cue);
  const specs = [];
  for (let i = 1; i <= o.count; i++) { specs.push({ name: prefix + '-' + (i < 10 ? '0' : '') + i, w: w, h: h, fill: o.fill }); }
  const boards = axiArtboards(doc, specs, { gap: o.gap });
  axiCarouselDecor(doc, boards, o.number, o.cue);
  return boards.map(function (b, i) { return { name: b.name, x: b.x, y: b.y, w: b.w, h: b.h, index: i + 1 }; });
}

// Split the artboard named master, a panorama at least slides*w - (slides-1)*overlap
// wide, across slides (2-20) new boards named <prefix>-01 ...: board i gets a
// copy of every child of the master moved by -i*(w - overlap) horizontally
// (overlap px of the picture repeat on neighbouring boards; default 0), so the
// picture runs on across the boards. Copies are made with axiClone and the master
// is left as it is; delete or keep it. fill is an optional hex for the new boards
// (an artboard's own fill is not copied). Returns [{name,x,y,w,h,index}].
function axiCarouselSplit(doc, master, o) {
  if (typeof master !== 'string' || master === '') { throw new Error('axiCarouselSplit: master (an artboard name) is required'); }
  if (!o || typeof o !== 'object') { throw new Error('axiCarouselSplit: options are required ({platform|w,h, slides})'); }
  if (typeof o.slides !== 'number' || Math.floor(o.slides) !== o.slides || o.slides < 2 || o.slides > 20) { throw new Error('axiCarouselSplit: slides must be a whole number from 2 to 20'); }
  const prefix = o.prefix === undefined ? 'slide' : o.prefix;
  if (typeof prefix !== 'string' || prefix === '') { throw new Error('axiCarouselSplit: prefix must be a non-empty string'); }
  if (o.gap !== undefined && !(o.gap >= 0)) { throw new Error('axiCarouselSplit: gap must be 0 or more'); }
  if (o.fill !== undefined && !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(o.fill))) { throw new Error('axiCarouselSplit: fill must be a hex colour'); }
  const p = o.platform ? axiPlatform(o.platform) : null;
  const w = o.w || (p && p.w);
  const h = o.h || (p && p.h);
  if (!(w > 0 && h > 0)) { throw new Error('axiCarouselSplit: give a platform key or w and h'); }
  const overlap = o.overlap === undefined ? 0 : o.overlap;
  if (!(overlap >= 0 && overlap < w)) { throw new Error('axiCarouselSplit: overlap must be 0 or more and less than the slide width'); }
  const step = w - overlap;
  const need = o.slides * w - (o.slides - 1) * overlap;
  const m = axiFindArtboard(doc, master);
  const mb = m.spreadBaseBox;
  if (mb.width < need - 0.5) { throw new Error('axiCarouselSplit: ' + master + ' is ' + mb.width + ' px wide; ' + o.slides + ' slides of ' + w + ' px with ' + overlap + ' px overlap need ' + need + ' px'); }
  const kids = Array.from(m.node.children).filter(function (n) { return n.userDescription !== 'axi-safe-zone'; });
  if (kids.length === 0) { throw new Error('axiCarouselSplit: ' + master + ' has no content to split'); }
  const { Transform } = require('/geometry.js');
  const specs = [];
  for (let i = 1; i <= o.slides; i++) { specs.push({ name: prefix + '-' + (i < 10 ? '0' : '') + i, w: w, h: h, fill: o.fill }); }
  const boards = axiArtboards(doc, specs, { gap: o.gap });
  boards.forEach(function (b, i) {
    const target = axiFindArtboard(doc, b.name).node;
    kids.forEach(function (k) {
      axiClone(doc, k, target, Transform.createTranslate(b.x - mb.x - i * step, b.y - mb.y));
    });
  });
  return boards.map(function (b, i) { return { name: b.name, x: b.x, y: b.y, w: b.w, h: b.h, index: i + 1 }; });
}
`;
