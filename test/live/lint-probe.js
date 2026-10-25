// Live probe for `lint` (unit F1). Run with --with-helpers and
// --args '{"uuid":"<document uuid>"}'; the document is the gallery demo document
// (examples/_brand/demo-doc.js: 1080x1080, artboard ig-square filled #F2F5F9).
// It never closes anything and never touches Document.current. Finish with
// `inspect <uuid8>` and read the three answers off the rows, then
// `doc save <uuid8> <path.af>` and `doc close <uuid8>`.
//
// It draws, in this order, on ig-square:
//   probe-rect  a filled rectangle (#888888)           -> path 0/0/1 expected
//   probe-text  a 48 px text (#777777) on top of it    -> path 0/0/2 expected
// and the artboard itself already carries a fill (#F2F5F9).
//
// Questions (KTD2, KTD3, A3 of the round-4 plan):
//   (a) stacking order: does the rect row come before the text row in `inspect`?
//   (b) font size unit: what does `font` print for the 48 px text?
//   (c) does the Artboard row carry the artboard's fill?
//
// RESULT (unit F1, Affinity 3.3.1.4940 demo document, 2026-10-26):
//   (a) A1 holds: rows list lower nodes first. inspect printed
//         0/0/0,Shape,probe-rect,200 300 600 300,,,#888888
//         0/0/1,ArtText,probe-text,240 325 199 35,Probe 48,Helvetica-Bold 48,#777777
//       so the rect (drawn first) comes before the text; lint.ts BELOW_IS_EARLIER = true.
//   (b) A2 holds: `font` prints "Helvetica-Bold 48" for a 48 px text on a 72 dpi px document,
//       so the size is px and fontPx() only parses it (the dpi/72 scale is a no-op there).
//   (c) A3 holds: the Artboard row carries the artboard fill ("0/0,Artboard,ig-square,...,#F2F5F9").
//   Note: children paths restart at 0 under an artboard (0/0/0 is the first child).
const { Document } = require('/document.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('probe document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 200, y: 300, w: 600, h: 300, fill: '#888888', name: 'probe-rect' });
axiText(doc, { x: 240, y: 360, text: 'Probe 48', font: 'Helvetica-Bold', size: 48, colour: '#777777', name: 'probe-text' });

console.log(JSON.stringify({ uuid: String(doc.sessionUuid), drawn: ['probe-rect', 'probe-text'] }));
