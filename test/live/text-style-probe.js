// Live probe for review findings R21/R22 (unit U4). Run with --with-helpers.
// Two modes:
//   fresh (default): axiDoc(800, 400); head = axiText Helvetica-Bold 84 #1F2A44 named
//     slot:head, sub = axiText Helvetica 32 #1F2A44 named slot:sub. Logs read() for each
//     after (a) axiSetFill on sub, (b) axiSetText on head, (c) axiSetFill then axiSetText
//     on sub. read() = first glyph run {font, size, fill} (as inspect-script.ts) plus the
//     node-level brush fill tag. The doc is left open: finish with
//     `doc save <uuid8> <path.af>` then `doc close <uuid8>`.
//   reopen: when the runner prepends `const AXI_REOPEN = '<abs path.af>';` the saved file
//     is opened by path and axiSetText is run on slot:head again (the live failure was
//     after a save/reopen).
// (d) the `fill` run with {"text":"...","fill":"#hex"} on a text slot is driven from the
// CLI against a saved copy of the fresh document; see the RESULT block below.
// The document is addressed by variable or path, never Document.current.
//
// RESULT (U4, Affinity 3.3.1.4940, 2026-10-26). Readings are glyph run 0 {font size fill}.
// BEFORE the fix (helpers as at 35afba9: axiSetFill = setBrushFillDescriptor(desc, node),
// axiSetText = node.setText):
//   start             head Helvetica-Bold 84 #1f2a44 | sub Helvetica 32 #1f2a44 (node brush NoFill)
//   (a) axiSetFill sub  -> sub fill #b5252a, font/size kept, node brush still NoFill. R21b NOT
//       reproduced: setBrushFillDescriptor on a text node does set the glyph fill.
//   (b) axiSetText head -> head "Helvetica 32 #b5252a": font AND size dropped to the sub's
//       style and the fill took the last colour set. R22 CONFIRMED: setText restyles from the
//       document's current text style, not from the node's own first run.
//   (c) axiSetFill then axiSetText sub -> sub fill #2f6f5e kept, text "Both", font kept
//       (the sub already matched the current style, so it hid the bug).
// AFTER the fix (axiSetFill on text = StoryDelta.createBrushFill via doc.formatText over
// axiStoryRange; axiSetText captures font/height/brushFill, doc.setText, reapplies):
//   (a) sub #b5252a Helvetica 32; (b) head "Changed" Helvetica-Bold 84 #1f2a44;
//   (c) head unchanged, sub "Both" Helvetica 32 #2f6f5e.
//   reopen (doc saved, opened by path): axiSetText head -> Helvetica-Bold 84 #1f2a44 kept;
//   axiSetFill sub -> #b5252a.
// (d) `fill` on the saved copy with [{"head": {"text": "Filled", "colour": "#B5252A"},
//   "sub": "Plain"}] then `doc open` + `inspect --named`: head "Filled" Helvetica-Bold 84
//   #B5252A, sub "Plain" Helvetica 32 #2F6F5E (colour is a synonym of fill; a plain string
//   on a text slot is text, so CSV cannot change a text colour).
const read = function (n) {
  const hex = function (c) { return '#' + [c.r, c.g, c.b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); };
  const r = { text: n.text };
  for (const run of n.story.getGlyphAttRunsFrom(0)) {
    const a = run.glyphAtts;
    r.font = String(a.font.postscriptName);
    r.size = Math.round(Number(a.height) * 100) / 100;
    try { r.fill = hex(a.brushFill.fill.colour.rgba8); } catch (e) { r.fill = 'err ' + String(e.message).slice(0, 40); }
    break;
  }
  try {
    const f = n.brushFillInterface.fillDescriptor.fill;
    let c = '';
    try { c = ' ' + hex(f.colour.rgba8); } catch (e) { c = ''; }
    r.nodeBrush = String(f[Symbol.toStringTag]) + c;
  } catch (e) { r.nodeBrush = 'err ' + String(e.message).slice(0, 40); }
  return r;
};
const out = { steps: [] };
const log = function (label, doc) {
  out.steps.push({ label: label, head: read(axiFind(doc, 'slot:head')), sub: read(axiFind(doc, 'slot:sub')) });
};
let doc;
if (typeof AXI_REOPEN === 'string') {
  doc = axiOpen(AXI_REOPEN);
  out.mode = 'reopen';
  out.uuid = String(doc.sessionUuid);
  log('reopened', doc);
  axiSetText(doc, 'slot:head', 'Changed after reopen');
  log('axiSetText head', doc);
  axiSetFill(doc, 'slot:sub', '#B5252A');
  log('axiSetFill sub', doc);
} else {
  doc = axiDoc(800, 400);
  out.mode = 'fresh';
  out.uuid = String(doc.sessionUuid);
  axiText(doc, { x: 40, y: 120, text: 'Headline', font: 'Helvetica-Bold', size: 84, colour: '#1F2A44', name: 'slot:head' });
  axiText(doc, { x: 40, y: 220, text: 'Subline', font: 'Helvetica', size: 32, colour: '#1F2A44', name: 'slot:sub' });
  log('start', doc);
  axiSetFill(doc, 'slot:sub', '#B5252A');
  log('(a) axiSetFill sub', doc);
  axiSetText(doc, 'slot:head', 'Changed');
  log('(b) axiSetText head', doc);
  axiSetFill(doc, 'slot:sub', '#2F6F5E');
  axiSetText(doc, 'slot:sub', 'Both');
  log('(c) axiSetFill then axiSetText sub', doc);
}
console.log(JSON.stringify(out, null, 1));
