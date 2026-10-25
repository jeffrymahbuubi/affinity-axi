// Pattern-tile helpers for run --with-helpers: axiPattern fills a box with a
// grid of cells, each holding a drawn or duplicated motif, clipped by a
// picture-frame rectangle so the result is seamless when the motif is
// edge-periodic. Same rules as helpers-core.ts (function declarations prefixed
// axi, requires inside functions, nothing blocking or generative, String.raw so
// no backticks, dollar-brace or backslash surprises).
//
//   axiPattern      the grid: draw(doc, cell) per cell, or a motif duplicated per cell
//   axiPatternSeam  reads the rendered edges back and reports how well they match
//   axiCellTransform internal, pure: the Transform that places one cell's content
//
// Vector first: BitmapFill has no repeat mode, so a pattern is real nodes.
// Geometry: cell (i, j) is column i, row j. Its top-left is x + i * tile.w and
// y + j * tile.h; with offset 'half' every odd row is shifted LEFT by tile.w / 2
// (the grid has one extra column and row, so the box stays covered). Cells are
// moved into the frame with DocumentCommand.createMoveNodes (NodeMoveType.Inside,
// the route axiClone verified for artboards; the tile probe checks it for a frame).
// Transforms compose right to left, so a rotation about the cell centre is
// T(c).multiply(R).multiply(S).multiply(T(-c)).
//
// Validation runs before any require() and before any node is added, so a bad
// option throws without touching the document.

import type { HelperInfo } from "./helpers-core.js";

export const PATTERN_INDEX: readonly HelperInfo[] = [
  {
    name: "axiPattern",
    signature: "axiPattern(doc, {x,y,w,h,tile,draw,motif,offset,rotate,scale,clip,fill,name})",
    summary:
      "fill the box x,y,w,h with a grid of tile.w x tile.h cells (one extra column and row; at most 400 cells). Give exactly one of draw(doc, cell) (called once per cell with {x,y,w,h,i,j}, i = column, j = row; it returns the node or array of nodes it made, else the selected node is taken) or motif (a node, name or ref, or an array of them, sitting inside the tile whose top-left is x,y: it is cell 0,0 and is copied to the rest). offset 'half' shifts odd rows left by half a tile (brick or half-drop); rotate is degrees per cell, or {deg, alternate:true} to flip the sign on odd cells; scale multiplies each cell about its centre. clip (default true) puts every cell inside a picture-frame rectangle of the box, filled with fill when given, so motifs crossing the edge are cut cleanly; clip:false leaves the cells loose. Names <name>-frame, <name>-cell-<i>-<j> (and -<k> when a cell holds several nodes). Returns {nodes:{frame,cells},cols,rows,count}; leaves the frame selected",
  },
  {
    name: "axiPatternSeam",
    signature: "axiPatternSeam(doc, node, {samples})",
    summary:
      "render node (the frame from axiPattern) and compare the pixels where a tile would wrap: column 0 against the last column, row 0 against the last row, at samples positions (default 16) along each. left/right use the even/odd sample rows of the left-right seam, top/bottom the even/odd sample columns of the top-bottom seam; each is the largest channel difference 0-255, max the largest of the four. A motif tile is seamless when max is small. Needs pixel readback; throws when this build cannot do it",
  },
];

/** Internal building blocks, not in the index. */
export const PATTERN_INTERNAL: readonly string[] = ["axiCellTransform"];

export const PATTERN_SOURCE: string = String.raw`
/* ---- pattern helpers ---- */

// Internal, pure apart from loading Transform: the transform that moves content
// sitting in the cell whose top-left is from to the cell, then rotates deg
// degrees and scales by k about the cell centre. cell is {x,y,w,h}; from is
// {x,y}. Returns null when it would change nothing.
function axiCellTransform(cell, deg, k, from) {
  const { Transform } = require('/geometry.js');
  const dx = cell.x - from.x;
  const dy = cell.y - from.y;
  if (dx === 0 && dy === 0 && deg === 0 && k === 1) { return null; }
  let xf = Transform.createTranslate(dx, dy);
  if (deg !== 0 || k !== 1) {
    const cx = from.x + cell.w / 2;
    const cy = from.y + cell.h / 2;
    xf = xf.multiply(Transform.createTranslate(cx, cy));
    if (deg !== 0) { xf = xf.multiply(Transform.createRotate(deg * Math.PI / 180)); }
    if (k !== 1) { xf = xf.multiply(Transform.createScale(k, k)); }
    xf = xf.multiply(Transform.createTranslate(-cx, -cy));
  }
  return xf;
}

// Fill the box x,y,w,h with a grid of tile cells. See the index entry for the
// options. Every cell is a real node (or several), so the result stays editable.
function axiPattern(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiPattern: options {x,y,w,h,tile} and draw or motif are required'); }
  const fin = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!fin(o.x) || !fin(o.y)) { throw new Error('axiPattern: x and y are required numbers'); }
  if (!fin(o.w) || !(o.w > 0) || !fin(o.h) || !(o.h > 0)) { throw new Error('axiPattern: w and h are required and must be positive'); }
  if (!o.tile || typeof o.tile !== 'object' || !fin(o.tile.w) || !(o.tile.w > 0) || !fin(o.tile.h) || !(o.tile.h > 0)) { throw new Error('axiPattern: tile {w,h} is required and must be positive'); }
  const hasDraw = o.draw !== undefined && o.draw !== null;
  const hasMotif = o.motif !== undefined && o.motif !== null;
  if (hasDraw === hasMotif) { throw new Error('axiPattern: pass exactly one of draw (a function) or motif (a node or ref)'); }
  if (hasDraw && typeof o.draw !== 'function') { throw new Error('axiPattern: draw must be a function draw(doc, cell)'); }
  const offset = o.offset === undefined ? 'none' : o.offset;
  if (offset !== 'none' && offset !== 'half') { throw new Error("axiPattern: offset must be 'none' or 'half' (got " + JSON.stringify(o.offset) + ')'); }
  let baseDeg = 0;
  let flip = false;
  if (o.rotate !== undefined && o.rotate !== null) {
    if (typeof o.rotate === 'object') { baseDeg = o.rotate.deg; flip = o.rotate.alternate === true; }
    else { baseDeg = o.rotate; }
    if (!fin(baseDeg)) { throw new Error('axiPattern: rotate must be degrees (a number) or {deg, alternate}'); }
  }
  const k = o.scale === undefined ? 1 : o.scale;
  if (!fin(k) || !(k > 0)) { throw new Error('axiPattern: scale must be a positive number'); }
  if (o.clip !== undefined && typeof o.clip !== 'boolean') { throw new Error('axiPattern: clip must be true or false'); }
  const clip = o.clip !== false;
  if (o.fill !== undefined && (typeof o.fill !== 'string' || !/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(o.fill))) { throw new Error('axiPattern: fill must be a hex string (got ' + JSON.stringify(o.fill) + ')'); }
  const tw = o.tile.w;
  const th = o.tile.h;
  const cols = Math.ceil(o.w / tw) + 1;
  const rows = Math.ceil(o.h / th) + 1;
  if (cols * rows > 400) { throw new Error('axiPattern: ' + cols + ' x ' + rows + ' = ' + (cols * rows) + ' cells is above the limit of 400; use a larger tile or a smaller box'); }

  const motifs = hasMotif ? axiNodesOf(doc, Array.isArray(o.motif) ? o.motif : [o.motif], 'axiPattern') : null;
  const nm = function (part) { return o.name ? o.name + '-' + part : undefined; };
  const frame = clip ? axiRect(doc, { x: o.x, y: o.y, w: o.w, h: o.h, fill: o.fill, frame: true, name: nm('frame') }) : null;

  const cellAt = function (i, j) {
    return { x: o.x + i * tw - (offset === 'half' && j % 2 === 1 ? tw / 2 : 0), y: o.y + j * th, w: tw, h: th, i: i, j: j };
  };
  const degAt = function (i, j) { return flip && (i + j) % 2 === 1 ? -baseDeg : baseDeg; };
  const groups = [];
  const origin = { x: o.x, y: o.y };
  const identity = motifs ? require('/geometry.js').Transform.createIdentity() : null;
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const cell = cellAt(i, j);
      if (motifs) {
        if (i === 0 && j === 0) { continue; }
        const xf = axiCellTransform(cell, degAt(i, j), k, origin);
        groups.push({ i: i, j: j, nodes: motifs.map(function (n) { return n.duplicate(xf || identity); }) });
      } else {
        const r = o.draw(doc, { x: cell.x, y: cell.y, w: tw, h: th, i: i, j: j });
        let made = Array.isArray(r) ? r : (r ? [r] : []);
        if (made.length === 0 && doc.selection.nodes.first) { made = [doc.selection.nodes.first]; }
        if (made.length === 0) { throw new Error('axiPattern: draw made no node for cell ' + i + ',' + j); }
        const xf = axiCellTransform(cell, degAt(i, j), k, { x: cell.x, y: cell.y });
        if (xf) { made.forEach(function (n) { doc.applyTransform(xf, n); }); }
        groups.push({ i: i, j: j, nodes: made });
      }
    }
  }
  if (motifs) {
    // The originals are cell 0,0; copy first, transform last.
    const xf0 = axiCellTransform(cellAt(0, 0), degAt(0, 0), k, origin);
    if (xf0) { motifs.forEach(function (n) { doc.applyTransform(xf0, n); }); }
    groups.unshift({ i: 0, j: 0, nodes: motifs });
  }

  const same = function (a, b) { return a === b || (typeof a.isSameNode === 'function' && a.isSameNode(b)); };
  const cells = [];
  groups.forEach(function (g) {
    g.nodes.forEach(function (n, idx) {
      if (frame) {
        const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');
        doc.executeCommand(DocumentCommand.createMoveNodes(n.selfSelection, frame, NodeMoveType.Inside, NodeChildType.Main));
        if (!Array.from(frame.children).some(function (c) { return same(c, n); })) {
          throw new Error('axiPattern: cannot move a cell into the frame on this Affinity build; pass clip:false');
        }
      }
      if (o.name) { n.userDescription = o.name + '-cell-' + g.i + '-' + g.j + (g.nodes.length > 1 ? '-' + idx : ''); }
      cells.push(n);
    });
  });
  if (frame) { doc.selection = frame; }
  return { nodes: { frame: frame, cells: cells }, cols: cols, rows: rows, count: cols * rows };
}

// Render node and compare the pixels where a tile would wrap. Each of left,
// right, top, bottom is the largest channel difference (0-255) over its share
// of the samples; max is the largest of the four.
function axiPatternSeam(doc, node, o) {
  const opts = o || {};
  if (!node || typeof node !== 'object' || !node.isNode) { throw new Error('axiPatternSeam: node must be a document node (the frame from axiPattern)'); }
  const samples = opts.samples === undefined ? 16 : opts.samples;
  if (typeof samples !== 'number' || !isFinite(samples) || samples < 2 || Math.floor(samples) !== samples) { throw new Error('axiPatternSeam: samples must be a whole number of 2 or more'); }
  let reader = null;
  try {
    const { NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
    const { PixelReaderRGBA8 } = require('/pixelaccessor.js');
    const bitmap = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8).createCompatibleBitmap(true);
    reader = PixelReaderRGBA8.create(bitmap);
    const w = bitmap.width;
    const h = bitmap.height;
    const diff = function (a, b) {
      return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.alpha - b.alpha));
    };
    const at = function (k, span) { return Math.min(span - 1, Math.floor((k + 0.5) * span / samples)); };
    const out = { left: 0, right: 0, top: 0, bottom: 0 };
    for (let s = 0; s < samples; s += 1) {
      const y = at(s, h);
      const x = at(s, w);
      const horizontal = diff(reader.readPixel(0, y), reader.readPixel(w - 1, y));
      const vertical = diff(reader.readPixel(x, 0), reader.readPixel(x, h - 1));
      const sideH = s % 2 === 0 ? 'left' : 'right';
      const sideV = s % 2 === 0 ? 'top' : 'bottom';
      out[sideH] = Math.max(out[sideH], horizontal);
      out[sideV] = Math.max(out[sideV], vertical);
    }
    out.max = Math.max(out.left, out.right, out.top, out.bottom);
    return out;
  } catch (e) {
    throw new Error('axiPatternSeam: pixel readback failed [' + String(e && e.message ? e.message : e) + ']');
  } finally {
    if (reader) { reader.dispose(); }
  }
}
`;
