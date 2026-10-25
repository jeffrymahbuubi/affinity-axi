// Social post templates (ig-post, ig-story, carousel-cover) and the support
// code every template shares. A template is a String.raw script: it takes every
// colour and font from the injected brand kit (axiToken / axiType) and holds no
// colour or font literal. The command (commands/templates.ts) injects ARGS and
// AXI_BRAND and appends the helpers, then runs the source. Plain JS for
// Affinity's script runtime: no backticks, no dollar-brace, no document-closing
// call (a test scans every source).
//
// Script contract: validate the kit before any document exists, build the
// document, print one JSON line {uuid, slots} (or {uuid, error} when drawing
// failed after the document was created) and never close anything.

/** Shared support: kit checks, palette, document, photo block, CTA pill, result line. */
export const TPL_COMMON: string = String.raw`
/* ---- template support ---- */

function tplArgs() {
  return typeof ARGS === 'undefined' || ARGS === null ? {} : ARGS;
}

function tplLum(hex) {
  const h = String(hex).replace('#', '');
  const ch = function (i) {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}

function tplRatio(a, b) {
  const x = tplLum(a);
  const y = tplLum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// The kit colour with the best contrast against bg.
function tplBest(all, bg) {
  let best = all[0];
  all.forEach(function (c) { if (tplRatio(c, bg) > tplRatio(best, bg)) { best = c; } });
  return best;
}

// Everything a template takes from the kit. Throws before any document exists.
function tplKit(name) {
  const kit = axiBrand();
  ['display', 'h1', 'body'].forEach(function (k) {
    if (!kit.type || !kit.type[k]) { throw new Error('template ' + name + ': the kit needs type.' + k); }
  });
  const keys = Object.keys(kit.colours);
  const col = function (i) { return axiToken('colours.' + keys[i]); };
  const all = keys.map(function (k, i) { return col(i); });
  const bg = col(0);
  const accent = col(keys.length > 1 ? 1 : 0);
  const pop = col(keys.length > 2 ? 2 : (keys.length > 1 ? 1 : 0));
  const ink = tplBest(all, bg);
  if (tplRatio(ink, bg) < 3) { throw new Error('template ' + name + ': no kit colour reads on colours.' + keys[0] + ' (contrast under 3:1); add a light or a dark colour to the kit'); }
  const onPop = tplBest(all, pop);
  if (tplRatio(onPop, pop) < 3) { throw new Error('template ' + name + ': no kit colour reads on colours.' + keys[keys.length > 2 ? 2 : 1] + ' (contrast under 3:1)'); }
  const r = kit.radius || {};
  return {
    name: name,
    brand: kit.name,
    bg: bg,
    accent: accent,
    pop: pop,
    ink: ink,
    onPop: onPop,
    radius: r.md || 0,
    pill: r.pill !== undefined ? r.pill : (r.md || 0),
    fonts: kit.fonts,
    type: kit.type
  };
}

// One artboard named after the template, filled with the kit's first colour.
function tplOpen(t, w, h) {
  const doc = axiDoc(w, h);
  TPL.doc = doc;
  axiArtboard(doc, { name: t.name, x: 0, y: 0, w: w, h: h, fill: t.bg });
  axiOn(doc, t.name);
  return doc;
}

// The brand name in the kit's body style and its pop colour, above the headline.
function tplKicker(doc, t, x, y) {
  axiType(doc, 'body', { x: x, y: y, text: String(t.brand).toUpperCase(), colour: t.pop, name: 'kicker' });
}

// The photo block. With ARGS.photo it is a picture in a rounded frame named
// slot:photo (the frame is renamed photo-frame, so only the picture is a slot);
// without it, a flat accent block that is still a picture frame.
function tplPhoto(doc, t, box) {
  const a = tplArgs();
  if (a.photo) {
    axiImage(doc, { path: a.photo, x: box.x, y: box.y, w: box.w, h: box.h, fit: 'cover', radius: t.radius, name: 'slot:photo' });
    axiRename(doc, 'slot:photo-frame', 'photo-frame');
  } else {
    axiRect(doc, { x: box.x, y: box.y, w: box.w, h: box.h, radius: t.radius, fill: t.accent, frame: true, name: 'slot:photo' });
  }
}

// A pill named slot:cta with its label centred inside (the label is not a slot).
function tplCta(doc, t, box, label) {
  axiRect(doc, { x: box.x, y: box.y, w: box.w, h: box.h, radius: t.pill, fill: t.pop, name: 'slot:cta' });
  axiType(doc, 'body', { x: box.x + box.w / 2, y: box.y + box.h / 2 + t.type.body.size * 0.36, text: label, colour: t.onPop, align: 'c', maxW: box.w - 48, name: 'cta-label' });
}

// The slot:* names the document now holds, without the prefix, in document order.
function tplFinish(doc) {
  const seen = {};
  const slots = [];
  axiNames(doc).forEach(function (r) {
    if (r.name.indexOf('slot:') === 0 && !seen[r.name]) { seen[r.name] = true; slots.push(r.name.slice(5)); }
  });
  console.log(JSON.stringify({ uuid: String(doc.sessionUuid), slots: slots }));
}

// Kit and argument checks run first (a throw leaves nothing open). Drawing
// errors are reported as {uuid, error} so the command can name the document.
function tplMain(name, w, h, build, check) {
  const t = tplKit(name);
  const ctx = check ? check(t) : null;
  try {
    const doc = tplOpen(t, w, h);
    build(doc, t, ctx);
    tplFinish(doc);
  } catch (e) {
    console.log(JSON.stringify({ uuid: TPL.doc ? String(TPL.doc.sessionUuid) : null, error: String(e && e.message ? e.message : e) }));
  }
}

const TPL = { doc: null };
`;

/** Wraps a template body: marker on line 1 (the fake server and run log key on it), then the support code. */
export function tplSource(name: string, body: string): string {
  return `/* affinity-axi:template ${name} */\n${TPL_COMMON}${body}`;
}

export const IG_POST: string = tplSource(
  "ig-post",
  String.raw`
tplMain('ig-post', 1080, 1080, function (doc, t) {
  tplKicker(doc, t, 90, 110);
  tplPhoto(doc, t, { x: 90, y: 150, w: 900, h: 500 });
  axiType(doc, 'h1', { x: 90, y: 740, text: 'Your headline goes here', colour: t.ink, maxW: 900, name: 'slot:headline' });
  axiType(doc, 'body', { x: 90, y: 810, text: 'One supporting line, then the call to action', colour: t.ink, maxW: 900, name: 'slot:sub' });
  tplCta(doc, t, { x: 90, y: 900, w: 380, h: 84 }, 'Book now');
});
`,
);

export const IG_STORY: string = tplSource(
  "ig-story",
  String.raw`
// Content stays between the story safe insets: 250 px from the top, 340 px from the bottom.
tplMain('ig-story', 1080, 1920, function (doc, t) {
  const safe = axiPlatform('story').safe;
  const top = safe.top;
  const bottom = 1920 - safe.bottom;
  tplKicker(doc, t, 90, top + 50);
  tplPhoto(doc, t, { x: 90, y: top + 100, w: 900, h: 760 });
  axiType(doc, 'display', { x: 90, y: top + 1030, text: 'Big headline', colour: t.ink, maxW: 900, name: 'slot:headline' });
  axiType(doc, 'body', { x: 90, y: top + 1120, text: 'One supporting line goes here', colour: t.ink, maxW: 900, name: 'slot:sub' });
  tplCta(doc, t, { x: 90, y: bottom - 100, w: 400, h: 100 }, 'Learn more');
});
`,
);

export const CAROUSEL_COVER: string = tplSource(
  "carousel-cover",
  String.raw`
// 4:5 cover for a carousel; text stays inside the 34 px side insets the grid crop can trim.
tplMain('carousel-cover', 1080, 1350, function (doc, t) {
  tplKicker(doc, t, 90, 130);
  axiType(doc, 'display', { x: 90, y: 280, text: 'Swipe for more', colour: t.ink, maxW: 900, name: 'slot:headline' });
  axiType(doc, 'body', { x: 90, y: 360, text: 'Five things to know, one slide each', colour: t.ink, maxW: 900, name: 'slot:sub' });
  tplPhoto(doc, t, { x: 90, y: 430, w: 900, h: 620 });
  tplCta(doc, t, { x: 90, y: 1130, w: 340, h: 90 }, 'Swipe');
});
`,
);
