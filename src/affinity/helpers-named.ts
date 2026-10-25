// Named-element helpers for run --with-helpers: find, edit, rename and delete
// the elements of an existing document by name. Same rules as helpers-core.ts
// (function declarations prefixed axi, requires inside functions, nothing
// blocking or generative, String.raw so no backticks, dollar-brace or
// backslash surprises).
//
// A name is the node's userDescription, the field the Layers panel shows. The
// walk below mirrors the inspect script (src/affinity/inspect-script.ts) on
// purpose, so a ref seen in `inspect` resolves to the same node here:
//   - index paths are spread/child/child ("0/2/1"), children in document order
//   - an artboard's label is its userDescription, falling back to its layer
//     description; a row's artboard is the label of its nearest artboard ancestor
//   - a text node is any node whose text is a string
//
// Refs: "name" | "artboard/name" | "#0/2/1" | {text: RegExp|string}. Edits go
// through document commands that take the node itself as the selection, so the
// user's selection is left as found. Multi-page documents: on a node whose spread
// is not the current one, setText and rename fail with COMMAND_FAILED (live probe:
// test/live/spread-probe.js), so every mutator runs inside axiOnSpread, which makes
// the node's spread current for the edit and puts the previous spread and selection
// back. On a one-spread document, or a node on the current spread, it does nothing.

import type { HelperInfo } from "./helpers-core.js";

export const NAMED_INDEX: readonly HelperInfo[] = [
  { name: "axiNames", signature: "axiNames(doc)", summary: "every named element as [{path,name,type,artboard}] in document order; same rows and paths as `inspect --named`" },
  { name: "axiFind", signature: "axiFind(doc, ref)", summary: "the node for ref: 'name', 'artboard/name', '#0/2/1' (index path) or {text: /regex/}; throws not found, or ambiguous with the candidates and their paths" },
  { name: "axiFindAll", signature: "axiFindAll(doc, ref)", summary: "every node matching ref, as an array (empty when none); never throws on duplicates" },
  { name: "axiSetText", signature: "axiSetText(doc, ref, text)", summary: "replace the text of one text node (keeps its font and size); works on any spread; returns the node" },
  { name: "axiSetFill", signature: "axiSetFill(doc, ref, hex)", summary: "solid fill colour of one node ('#RRGGBB'; for text it colours the text); works on any spread; returns the node" },
  { name: "axiSetBox", signature: "axiSetBox(doc, ref, {x,y,w,h})", summary: "move and resize one node to the given box in document px; every field optional, missing ones are kept; works on any spread; returns the node" },
  { name: "axiRename", signature: "axiRename(doc, ref, name)", summary: "set the node's name (its userDescription); works on any spread; returns the node" },
  { name: "axiDelete", signature: "axiDelete(doc, ref)", summary: "delete one node and what it contains; works on any spread; returns nothing" },
  { name: "axiOpen", signature: "axiOpen(path)", summary: "the Document for an absolute .af path: the one already open, else Document.load" },
];

/** Internal building blocks, not in the index. */
export const NAMED_INTERNAL: readonly string[] = ["axiRows", "axiRowLabel", "axiResolve", "axiOne", "axiNodeBox", "axiSpreadOf", "axiOnSpread", "axiStoryRange"];

export const NAMED_SOURCE: string = String.raw`
/* ---- named-element helpers ---- */

// Internal: one row per node of the document, in document order, with the same
// index paths and artboard labels as the inspect script. Row: {node, path, name,
// type, artboard, text}; text is null for nodes that are not text.
function axiRows(doc) {
  const safe = function (fn, dflt) {
    try { const v = fn(); return v === undefined || v === null ? dflt : v; } catch (e) { return dflt; }
  };
  const rows = [];
  const walk = function (parent, prefix, ab) {
    const kids = safe(function () { return Array.from(parent.children); }, []);
    let i = 0;
    for (const n of kids) {
      const path = prefix + '/' + i;
      i += 1;
      const isAb = !!safe(function () { return n.isArtboardEnabled; }, false);
      const name = String(safe(function () { return n.userDescription; }, '') || '');
      const label = isAb ? (name || String(safe(function () { return n.description; }, '') || '')) : name;
      const type = isAb ? 'Artboard' : (String(safe(function () { return n[Symbol.toStringTag]; }, 'Unknown')).replace(/Node$/, '') || 'Unknown');
      const text = safe(function () { return n.text; }, null);
      rows.push({ node: n, path: path, name: name, type: type, artboard: ab, text: typeof text === 'string' ? text : null });
      walk(n, path, isAb ? label : ab);
    }
  };
  let s = 0;
  for (const spread of doc.spreads) {
    walk(spread, String(s), '');
    s += 1;
  }
  return rows;
}

// Internal: how a row is shown in errors, e.g. og/headline (#0/1/1).
function axiRowLabel(r) {
  const who = r.name ? (r.artboard ? r.artboard + '/' : '') + r.name : '(unnamed ' + r.type + ')';
  return who + ' (#' + r.path + ')';
}

// Internal: the rows matching ref. Forms: '#0/2/1' index path; 'name' exact
// userDescription anywhere; 'artboard/name' scoped to the nearest artboard
// ancestor; {text: RegExp|string} text nodes whose text matches (a string is a
// regular expression source).
function axiResolve(doc, ref) {
  const rows = axiRows(doc);
  if (typeof ref === 'string') {
    if (ref === '') { throw new Error('axiFind: ref is empty'); }
    if (ref.charAt(0) === '#') { return rows.filter(function (r) { return '#' + r.path === ref; }); }
    return rows.filter(function (r) {
      return r.name !== '' && (r.name === ref || (r.artboard !== '' && r.artboard + '/' + r.name === ref));
    });
  }
  if (ref && typeof ref === 'object' && ref.text !== undefined && ref.text !== null) {
    let re;
    if (Object.prototype.toString.call(ref.text) === '[object RegExp]') {
      re = new RegExp(ref.text.source, ref.text.flags.replace(/[gy]/g, ''));
    } else {
      try { re = new RegExp(String(ref.text)); } catch (e) { throw new Error('axiFind: {text} is not a valid regular expression: ' + ref.text); }
    }
    return rows.filter(function (r) { return r.text !== null && re.test(r.text); });
  }
  throw new Error('axiFind: ref must be a name, artboard/name, #index-path or {text: /regex/}');
}

// Internal: the single row for ref; throws not found or ambiguous with candidates.
function axiOne(doc, ref) {
  const hits = axiResolve(doc, ref);
  const shown = typeof ref === 'string' ? ref : '{text: ' + String(ref.text) + '}';
  if (hits.length === 1) { return hits[0]; }
  if (hits.length === 0) {
    const named = axiRows(doc).filter(function (r) { return r.name !== ''; }).map(function (r) { return axiRowLabel(r); });
    throw new Error('axiFind: nothing matches ' + shown + '; named elements: ' + (named.slice(0, 12).join(', ') || 'none') + (named.length > 12 ? ' (+' + (named.length - 12) + ' more)' : ''));
  }
  throw new Error('axiFind: ' + shown + ' is ambiguous (' + hits.length + ' matches): ' + hits.map(function (r) { return axiRowLabel(r); }).join(', ') + '; use artboard/name or #path');
}

// Internal: the spread node that holds node (the node itself when it is one), or
// null when no ancestor is a spread.
function axiSpreadOf(node) {
  let n = node;
  for (let i = 0; i < 64 && n; i += 1) {
    let is = false;
    try { is = !!n.isSpreadNode; } catch (e) { is = false; }
    if (is) { return n; }
    try { n = n.parent; } catch (e) { return null; }
  }
  return null;
}

// Internal: makes the spread that holds node the document's current spread, when
// it is not already, and returns restore(): the previous spread (and the
// selection the switch cleared) put back. On a node already on the current
// spread, or on a one-spread document, it runs no command and restore() does
// nothing. Use as: const back = axiOnSpread(doc, node); try { edit } finally { back(); }
function axiOnSpread(doc, node) {
  const none = function () {};
  const spread = axiSpreadOf(node);
  if (!spread) { return none; }
  let cur = null;
  try { cur = doc.currentSpread; } catch (e) { cur = null; }
  if (!cur) { return none; }
  let same;
  try {
    same = cur.isSameNode(spread);
  } catch (e) {
    const all = Array.from(doc.spreads);
    same = all.indexOf(cur) === all.indexOf(spread);
  }
  if (same) { return none; }
  const { DocumentCommand } = require('/commands.js');
  let held = [];
  try { held = Array.from(doc.selection.nodes); } catch (e) { held = []; }
  doc.executeCommand(DocumentCommand.createSetCurrentSpread(spread));
  return function () {
    doc.executeCommand(DocumentCommand.createSetCurrentSpread(cur));
    if (held.length > 0) {
      try { doc.selection = held; } catch (e) { held = []; }
    }
  };
}

// Every named element as [{path,name,type,artboard}], in document order. Same
// rows, paths and artboard labels as inspect --named.
function axiNames(doc) {
  return axiRows(doc).filter(function (r) { return r.name !== ''; }).map(function (r) {
    return { path: r.path, name: r.name, type: r.type, artboard: r.artboard };
  });
}

// The node for ref; throws when nothing matches or more than one does.
function axiFind(doc, ref) {
  return axiOne(doc, ref).node;
}

// Every node matching ref, as an array (empty when none).
function axiFindAll(doc, ref) {
  return axiResolve(doc, ref).map(function (r) { return r.node; });
}

// Internal: a Selection of one text node with its whole story range selected.
// It is a separate Selection object, so the document's own selection is left as is.
function axiStoryRange(doc, node) {
  const { Selection, TextSelection } = require('/selections.js');
  const sel = Selection.create(doc, node);
  sel.addSubSelectionForNode(node, TextSelection.create([{ begin: 0, end: node.story.length }]));
  return sel;
}

// Replace the text of one text node, keeping its first run's font, size and
// fill (setText alone restyles from the document's current text style: live,
// the headline fell to the subline's font and fill). Character spacing and other
// glyph attributes are not captured.
function axiSetText(doc, ref, text) {
  const row = axiOne(doc, ref);
  if (row.text === null) { throw new Error('axiSetText: ' + axiRowLabel(row) + ' is not a text node'); }
  if (typeof text !== 'string') { throw new Error('axiSetText: text must be a string'); }
  const { StoryDelta } = require('/storydelta.js');
  const { FontField } = require('/fonts.js');
  const { GlyphAttDoubleType } = require('/glyphatts.js');
  let first = null;
  for (const run of row.node.story.getGlyphAttRunsFrom(0)) {
    const g = run.glyphAtts;
    first = { font: g.font, height: g.height, brushFill: g.brushFill };
    break;
  }
  const back = axiOnSpread(doc, row.node);
  try {
    doc.setText(text, axiStoryRange(doc, row.node));
    if (first) {
      doc.formatText(StoryDelta.createComposite([
        StoryDelta.createFont(FontField.PostscriptName | FontField.FamilyName, first.font),
        StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, first.height),
        StoryDelta.createBrushFill(first.brushFill),
      ]), axiStoryRange(doc, row.node));
    }
  } finally { back(); }
  return row.node;
}

// Solid fill colour of one node. For text it is the colour of the text, a glyph
// brush fill over the whole story. The node is the command's selection, so the
// user's selection is untouched.
function axiSetFill(doc, ref, hex) {
  const { FillDescriptor } = require('/fills.js');
  const row = axiOne(doc, ref);
  const desc = FillDescriptor.createSolid(axiHex(hex));
  const back = axiOnSpread(doc, row.node);
  try {
    if (row.text !== null) {
      const { StoryDelta } = require('/storydelta.js');
      doc.formatText(StoryDelta.createBrushFill(desc), axiStoryRange(doc, row.node));
    } else { doc.setBrushFillDescriptor(desc, row.node); }
  } finally { back(); }
  return row.node;
}

// Internal: {x,y,w,h} of a node in document px, from its base box run through
// its transform (as axiMeasure does for the selection).
function axiNodeBox(n) {
  const b = n.baseBoxInterface.baseBox;
  const t = n.transform;
  const xs = [];
  const ys = [];
  [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].forEach(function (c) {
    const p = t.applyToPoint({ x: c[0], y: c[1] });
    xs.push(p.x);
    ys.push(p.y);
  });
  const x = Math.min.apply(null, xs);
  const y = Math.min.apply(null, ys);
  return { x: x, y: y, w: Math.max.apply(null, xs) - x, h: Math.max.apply(null, ys) - y };
}

// Move and resize one node to box {x,y,w,h} (document px, x,y the top-left).
// Every field is optional; a missing one keeps the node's current value. The
// node is scaled about its current top-left and then moved there.
function axiSetBox(doc, ref, box) {
  const { Transform } = require('/geometry.js');
  if (!box || typeof box !== 'object') { throw new Error('axiSetBox: box {x,y,w,h} is required'); }
  ['x', 'y', 'w', 'h'].forEach(function (k) {
    if (box[k] !== undefined && !(typeof box[k] === 'number' && isFinite(box[k]))) { throw new Error('axiSetBox: ' + k + ' must be a finite number'); }
  });
  if ((box.w !== undefined && !(box.w > 0)) || (box.h !== undefined && !(box.h > 0))) { throw new Error('axiSetBox: w and h must be positive'); }
  const row = axiOne(doc, ref);
  const cur = axiNodeBox(row.node);
  const nx = box.x === undefined ? cur.x : box.x;
  const ny = box.y === undefined ? cur.y : box.y;
  const sx = box.w === undefined || cur.w === 0 ? 1 : box.w / cur.w;
  const sy = box.h === undefined || cur.h === 0 ? 1 : box.h / cur.h;
  const xf = Transform.createTranslate(nx, ny).multiply(Transform.createScale(sx, sy)).multiply(Transform.createTranslate(-cur.x, -cur.y));
  const back = axiOnSpread(doc, row.node);
  try { doc.applyTransform(xf, row.node); } finally { back(); }
  return row.node;
}

// Set the node's name (its userDescription).
function axiRename(doc, ref, name) {
  if (typeof name !== 'string' || name === '') { throw new Error('axiRename: name must be a non-empty string'); }
  const row = axiOne(doc, ref);
  const back = axiOnSpread(doc, row.node);
  try { row.node.userDescription = name; } finally { back(); }
  return row.node;
}

// Delete one node and what it contains.
function axiDelete(doc, ref) {
  const row = axiOne(doc, ref);
  const back = axiOnSpread(doc, row.node);
  try { doc.deleteSelection(row.node); } finally { back(); }
}

// The Document for an absolute .af path: the one already open (never reloaded),
// else Document.load.
function axiOpen(path) {
  const { Document } = require('/document.js');
  if (typeof path !== 'string' || path.charAt(0) !== '/') { throw new Error('axiOpen: path must be absolute'); }
  const open = Document.all.find(function (d) { return String(d.path || '') === path; });
  return open || Document.load(path);
}
`;
