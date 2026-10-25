// Table helper for run --with-helpers: axiTable draws a native table text node
// from an array of rows. Same rules as helpers-core.ts (function declarations
// prefixed axi, requires inside functions, nothing blocking or generative,
// String.raw so no backticks, dollar-brace or backslash surprises).
//
// A table text node keeps its whole content in one story. Cells are separated
// by a TableCell hard break, in row-major order, so a cell is a story range
// [start, nextStart - 1). Cells are filled last to first: a range before the
// one being edited never moves while the story grows. Columns and rows are
// equal; widths and cell fills are not exposed (the summary says so).

import type { HelperInfo } from "./helpers-core.js";

export const TABLE_INDEX: readonly HelperInfo[] = [
  { name: "axiTable", signature: "axiTable(doc, {x,y,w,h,rows,font,size,colour,header,align,name})", summary: "native table at x,y of size w,h from rows (array of equal-length arrays; numbers are stringified, at most 400 cells); equal columns; the first row is the header unless header:false, and header:{font,size,colour} restyles it; align l|c|r|j; name sets the node's userDescription; returns the node, no cell fills or column widths" },
];

/** Internal building blocks, not in the index. */
export const TABLE_INTERNAL: readonly string[] = ["axiCellStarts", "axiCellRange"];

export const TABLE_SOURCE: string = String.raw`
/* ---- table helper ---- */

// Internal: story position of the first glyph of every cell. The cell count
// equals the result length; the last cell ends at story.length and has no
// trailing break glyph.
function axiCellStarts(story) {
  const { HardBreakType } = require('/story.js');
  const starts = [0];
  for (let i = 0; i < story.length; i++) {
    const ht = story.getHardBreakType(i);
    if (ht && ht.value === HardBreakType.TableCell.value) { starts.push(i + 1); }
  }
  return starts;
}

// Internal: a selection holding the table with the story range [begin, end)
// selected. It is a separate Selection object, so the document's own selection
// is left as it is.
function axiCellRange(doc, table, begin, end) {
  const { Selection, TextSelection } = require('/selections.js');
  const sel = Selection.create(doc, table);
  sel.addSubSelectionForNode(table, TextSelection.create([{ begin: begin, end: end }]));
  return sel;
}

// Native table text node with equal columns. rows is an array of equal-length
// arrays (numbers become strings); the first row is the header unless
// header:false. font and size style the whole table, header:{font,size,colour}
// restyles the first row. No cell fills and no column widths: the SDK exposes
// neither here. Returns the node.
function axiTable(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiTable: options are required'); }
  const rows = o.rows;
  if (!Array.isArray(rows) || rows.length === 0) { throw new Error('axiTable: rows must be a non-empty array of arrays'); }
  const cols = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (cols === 0) { throw new Error('axiTable: row 0 must be a non-empty array'); }
  for (let r = 0; r < rows.length; r++) {
    if (!Array.isArray(rows[r])) { throw new Error('axiTable: row ' + r + ' is not an array'); }
    if (rows[r].length !== cols) { throw new Error('axiTable: row ' + r + ' has ' + rows[r].length + ' cells, expected ' + cols); }
  }
  if (cols * rows.length > 400) { throw new Error('axiTable: ' + (cols * rows.length) + ' cells; at most 400 (split the table)'); }
  const num = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!num(o.x) || !num(o.y)) { throw new Error('axiTable: x and y are required numbers'); }
  if (!num(o.w) || !num(o.h) || o.w <= 0 || o.h <= 0) { throw new Error('axiTable: w and h must be positive numbers'); }
  if (typeof o.font !== 'string' || o.font === '') { throw new Error('axiTable: font (a postscript name) is required'); }
  if (!num(o.size) || o.size <= 0) { throw new Error('axiTable: size must be a positive number'); }
  const hexOk = function (v) { return typeof v === 'string' && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v); };
  if (o.colour !== undefined && !hexOk(o.colour)) { throw new Error('axiTable: colour must be a hex string like #RRGGBB'); }
  let head = o.header;
  if (head === undefined || head === null || head === true) { head = {}; }
  if (head !== false) {
    if (typeof head !== 'object') { throw new Error('axiTable: header must be false or {font,size,colour}'); }
    if (head.font !== undefined && (typeof head.font !== 'string' || head.font === '')) { throw new Error('axiTable: header.font must be a postscript name'); }
    if (head.size !== undefined && (!num(head.size) || head.size <= 0)) { throw new Error('axiTable: header.size must be a positive number'); }
    if (head.colour !== undefined && !hexOk(head.colour)) { throw new Error('axiTable: header.colour must be a hex string like #RRGGBB'); }
  }
  if (o.align !== undefined && ['l', 'c', 'r', 'j'].indexOf(o.align) < 0) { throw new Error('axiTable: align must be l, c, r or j'); }

  axiSurface(doc);
  const { TableTextNodeDefinition } = require('/nodes.js');
  const { StoryDelta } = require('/storydelta.js');
  const { FontField } = require('/fonts.js');
  const { GlyphAttDoubleType } = require('/glyphatts.js');
  const { FillDescriptor } = require('/fills.js');
  doc.addNode(TableTextNodeDefinition.create({ x: o.x, y: o.y, width: o.w, height: o.h }, { width: cols, height: rows.length }));
  const table = doc.selection.nodes.first;

  const texts = [];
  for (const row of rows) {
    for (const cell of row) { texts.push(cell === null || cell === undefined ? '' : String(cell)); }
  }
  let starts = axiCellStarts(table.story);
  if (starts.length !== texts.length) { throw new Error('axiTable: expected ' + texts.length + ' cells, the table has ' + starts.length); }
  for (let k = texts.length - 1; k >= 0; k--) {
    if (texts[k] === '') { continue; }
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : table.story.length;
    doc.setText(texts[k], axiCellRange(doc, table, starts[k], end));
  }

  const style = function (font, size, colour, sel) {
    const deltas = [];
    if (font) { deltas.push(StoryDelta.createFont(FontField.PostscriptName | FontField.FamilyName, axiFont(font))); }
    if (size) { deltas.push(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, size)); }
    if (colour) { deltas.push(StoryDelta.createBrushFill(FillDescriptor.createSolid(axiHex(colour)))); }
    if (deltas.length > 0) { doc.formatText(StoryDelta.createComposite(deltas), sel); }
  };
  starts = axiCellStarts(table.story);
  style(o.font, o.size, o.colour, axiCellRange(doc, table, 0, table.story.length));
  if (o.align) {
    const { ParagraphAlignXType } = require('/paragraphatts.js');
    const ax = { l: ParagraphAlignXType.Left, c: ParagraphAlignXType.Centre, r: ParagraphAlignXType.Right, j: ParagraphAlignXType.JustifyLeft }[o.align];
    doc.formatText(StoryDelta.createAlignX(ax), axiCellRange(doc, table, 0, table.story.length));
  }
  if (head !== false && rows.length > 0) {
    const hend = rows.length > 1 ? starts[cols] - 1 : table.story.length;
    style(head.font, head.size, head.colour, axiCellRange(doc, table, 0, hend));
  }
  return axiName(table, o.name);
}
`;
