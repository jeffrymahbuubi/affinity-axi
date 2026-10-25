// Multi-size helpers for run --with-helpers: one design on many boards.
// Same rules as helpers-core.ts (function declarations prefixed axi, requires
// inside functions, nothing blocking or generative, String.raw so no
// backticks, dollar-brace or backslash surprises).
//
//   axiVariants  the verified route: a draw(board) callback runs once per board
//   axiAdapt     copies a master board's content onto new boards (anchor, fit, cover)
//   axiClone     internal: duplicate a node and move the copy into another artboard
//   axiBoardScale internal: pure placement maths, no SDK
//
// SDK facts, live-verified on Affinity 3.3.1.4940 (test/live/clone-probe.js):
//   Node.duplicate(transform) puts the copy beside the original, in spread
//   coordinates, so the transform alone decides where it lands; then
//   DocumentCommand.createMoveNodes(copy.selfSelection, targetArtboard,
//   NodeMoveType.Inside, NodeChildType.Main) re-parents it. MOVE_TYPE = Inside
//   (the other members, After and Before, move the copy beside the artboard and
//   are rejected by the post-move check below).
// Transforms compose right to left: T(a).multiply(S).multiply(T(-b)) applies
// T(-b) first, so a scale about b's point then a move to a is that product.

import type { HelperInfo } from "./helpers-core.js";

export const VARIANTS_INDEX: readonly HelperInfo[] = [
  { name: "axiVariants", signature: "axiVariants(doc, specs, draw, {gap})", summary: "add artboards from specs ([{platform}] or [{name,w,h,fill}], as axiArtboards) and call draw(board) once per board, after axiOn selected it; board is {name,x,y,w,h,s} with s = min(w/w0, h/h0) against the first board, so one drawing function lays out every size; returns the boards" },
  { name: "axiAdapt", signature: "axiAdapt(doc, master, specs, {mode:'anchor'|'fit'|'cover', gap})", summary: "add artboards from specs and copy the content of the artboard named master onto each; anchor (default) pins by third: a node whose centre is in the first third keeps its near-edge distance, in the last third its far-edge distance, in the middle third it stays centred, and a node spanning over two thirds of an axis is stretched (text frames are never stretched); fit and cover scale everything uniformly and centre; copies are named name@board; returns [{name,x,y,w,h,s,nodes,clamped}], clamped lists nodes pushed back inside the board (restyle them by name); photos stretch, they are not re-cropped" },
];

/** Internal building blocks, not in the index. */
export const VARIANTS_INTERNAL: readonly string[] = ["axiClone", "axiBoardScale"];

export const VARIANTS_SOURCE: string = String.raw`
/* ---- multi-size helpers ---- */

// Internal: duplicate node with transform (a Transform; none keeps its place)
// and move the copy inside targetArtboardNode (a node, not an ArtboardInterface).
// Returns the copy. The move is checked afterwards, because a wrong target type
// can leave the copy beside the artboard without an error; a failed copy is
// deleted before the error is thrown.
function axiClone(doc, node, targetArtboardNode, transform) {
  if (!node || typeof node.duplicate !== 'function') { throw new Error('axiClone: node must be a document node'); }
  if (!targetArtboardNode || targetArtboardNode.children === undefined) { throw new Error('axiClone: target must be an artboard node'); }
  const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');
  const { Transform } = require('/geometry.js');
  const copy = node.duplicate(transform || Transform.createIdentity());
  const keep = String(copy.userDescription || '');
  const marker = 'axi-clone-' + Math.floor(Math.random() * 1000000000);
  copy.userDescription = marker;
  let moved = false;
  let why = '';
  try {
    doc.executeCommand(DocumentCommand.createMoveNodes(copy.selfSelection, targetArtboardNode, NodeMoveType.Inside, NodeChildType.Main));
    moved = Array.from(targetArtboardNode.children).some(function (n) { return String(n.userDescription) === marker; });
  } catch (e) {
    why = String(e && e.message ? e.message : e);
  }
  if (!moved) {
    try { copy.delete(); } catch (e) { why += ' (the stray copy could not be deleted)'; }
    throw new Error('axiClone: cannot move a copy into another artboard on this Affinity build; use axiVariants(doc, specs, draw)' + (why ? ' [' + why + ']' : ''));
  }
  copy.userDescription = keep;
  return copy;
}

// Internal, pure: where a node of the master lands on a target board.
//   masterBox, targetBox {w,h}; nodeBox {x,y,w,h} relative to the master origin,
//   rigid:true on nodeBox means "never change its size" (text frames).
// mode 'anchor' (default): per axis, by the node centre as a fraction c of the
// master: c < 1/3 keeps the near-edge distance, c > 2/3 keeps the far-edge
// distance, otherwise the centre sits at the same fraction of the target; a
// non-rigid node spanning more than 2/3 of the axis is stretched to keep both
// edge distances; a node that would leave the target is pushed back inside (by
// the master's edge distance when there is room) and flagged. 'fit' and 'cover'
// scale uniformly by min or max of the axis ratios and centre.
// Returns {sx, sy, dx, dy, clamped, box}: scale about the node's top-left by
// sx,sy, then move by dx,dy; box is the resulting {x,y,w,h} on the target.
function axiBoardScale(masterBox, nodeBox, targetBox, mode) {
  const m = mode === undefined ? 'anchor' : mode;
  if (m !== 'anchor' && m !== 'fit' && m !== 'cover') { throw new Error('axiBoardScale: mode must be anchor, fit or cover'); }
  const pos = function (b) { return b && b.w > 0 && b.h > 0; };
  if (!pos(masterBox) || !pos(targetBox)) { throw new Error('axiBoardScale: masterBox and targetBox need positive w and h'); }
  if (!nodeBox || !(nodeBox.w >= 0) || !(nodeBox.h >= 0) || typeof nodeBox.x !== 'number' || typeof nodeBox.y !== 'number') { throw new Error('axiBoardScale: nodeBox needs x, y, w, h'); }
  if (m !== 'anchor') {
    const k = m === 'fit' ? Math.min(targetBox.w / masterBox.w, targetBox.h / masterBox.h) : Math.max(targetBox.w / masterBox.w, targetBox.h / masterBox.h);
    const ox = (targetBox.w - masterBox.w * k) / 2;
    const oy = (targetBox.h - masterBox.h * k) / 2;
    const nx = ox + nodeBox.x * k;
    const ny = oy + nodeBox.y * k;
    return { sx: k, sy: k, dx: nx - nodeBox.x, dy: ny - nodeBox.y, clamped: false, box: { x: nx, y: ny, w: nodeBox.w * k, h: nodeBox.h * k } };
  }
  const axis = function (p, s, big, tl) {
    const near = p;
    const far = big - (p + s);
    if (!nodeBox.rigid && s > big * 2 / 3) {
      const grown = tl - near - far;
      return { pos: near, size: Math.max(1, grown), clamped: grown < 1 };
    }
    const c = (p + s / 2) / big;
    let at = c < 1 / 3 ? near : (c > 2 / 3 ? tl - s - far : c * tl - s / 2);
    let clamped = false;
    if (at < 0 || at + s > tl) {
      clamped = true;
      const inset = Math.min(Math.max(0, Math.min(near, far)), (tl - s) / 2);
      at = Math.min(Math.max(at, inset), tl - s - inset);
    }
    return { pos: at, size: s, clamped: clamped };
  };
  const ax = axis(nodeBox.x, nodeBox.w, masterBox.w, targetBox.w);
  const ay = axis(nodeBox.y, nodeBox.h, masterBox.h, targetBox.h);
  return {
    sx: nodeBox.w > 0 ? ax.size / nodeBox.w : 1,
    sy: nodeBox.h > 0 ? ay.size / nodeBox.h : 1,
    dx: ax.pos - nodeBox.x,
    dy: ay.pos - nodeBox.y,
    clamped: ax.clamped || ay.clamped,
    box: { x: ax.pos, y: ay.pos, w: ax.size, h: ay.size },
  };
}

// Add artboards from specs (as axiArtboards: [{platform}] or [{name,w,h,fill}])
// and call draw(board) once per board, in order, after axiOn selected it, so
// the nodes it adds land inside that board. board is {name,x,y,w,h,s}: x,y is
// the board origin in the spread (draw at board.x + dx) and s = min(w/w0, h/h0)
// against the first board, to scale sizes. Nothing is cloned: this is the
// verified route to many sizes. Returns the boards [{name,x,y,w,h,s}].
function axiVariants(doc, specs, draw, o) {
  const opts = o || {};
  if (!Array.isArray(specs) || specs.length === 0) { throw new Error('axiVariants: specs must be a non-empty array'); }
  if (typeof draw !== 'function') { throw new Error('axiVariants: draw must be a function draw(board)'); }
  const made = axiArtboards(doc, specs, { gap: opts.gap });
  const first = made[0];
  const boards = made.map(function (b) {
    return { name: b.name, x: b.x, y: b.y, w: b.w, h: b.h, s: Math.min(b.w / first.w, b.h / first.h) };
  });
  boards.forEach(function (b) {
    axiOn(doc, b.name);
    draw(b);
  });
  return boards;
}

// Add artboards from specs and copy the content of the artboard named master
// onto each, placed by opts.mode (see axiBoardScale): 'anchor' (default), 'fit'
// or 'cover'. The master's direct children are copied in order (the safe-zone
// bands named axi-safe-zone are skipped); a named copy is named name@board.
// Text frames keep their size in anchor mode and are not re-fitted; a node that
// would leave a board is pushed back in and listed under clamped (by its new
// name), so the script can call axiFitText or restyle it. Throws the axiClone
// error, which points to axiVariants, when this Affinity cannot move a copy.
// Returns [{name,x,y,w,h,s,nodes,clamped}]; nodes counts the copies, s is the
// board size against the master (min of the axis ratios, the real scale in
// fit and cover).
function axiAdapt(doc, master, specs, o) {
  const opts = o || {};
  const mode = opts.mode === undefined ? 'anchor' : opts.mode;
  if (mode !== 'anchor' && mode !== 'fit' && mode !== 'cover') { throw new Error('axiAdapt: mode must be anchor, fit or cover'); }
  if (typeof master !== 'string' || master === '') { throw new Error('axiAdapt: master (an artboard name) is required'); }
  if (!Array.isArray(specs) || specs.length === 0) { throw new Error('axiAdapt: specs must be a non-empty array'); }
  const mab = axiFindArtboard(doc, master);
  const taken = doc.artboards.map(function (a) { return a.description; });
  specs.forEach(function (s) {
    const p = s && s.platform ? axiPlatform(s.platform) : null;
    const name = (s && s.name) || (p && p.key);
    if (!name) { throw new Error('axiAdapt: every spec needs a platform or a name'); }
    if (taken.indexOf(name) >= 0) { throw new Error('axiAdapt: an artboard named ' + name + ' already exists or is listed twice'); }
    taken.push(name);
  });
  const mb = mab.spreadBaseBox;
  const M = { x: mb.x, y: mb.y, w: mb.width, h: mb.height };
  const { Transform } = require('/geometry.js');
  const kids = Array.from(mab.node.children).filter(function (n) { return String(n.userDescription) !== 'axi-safe-zone'; });
  const infos = kids.map(function (n) {
    const b = n.getSpreadBaseBox(false);
    let isText = false;
    try { isText = typeof n.text === 'string'; } catch (e) { isText = false; }
    return { node: n, name: String(n.userDescription || ''), abs: b, rigid: isText };
  });
  const made = axiArtboards(doc, specs, { gap: opts.gap });
  return made.map(function (b) {
    const target = axiFindArtboard(doc, b.name).node;
    const clamped = [];
    infos.forEach(function (it, i) {
      const rel = { x: it.abs.x - M.x, y: it.abs.y - M.y, w: it.abs.width, h: it.abs.height, rigid: it.rigid };
      const r = axiBoardScale({ w: M.w, h: M.h }, rel, { w: b.w, h: b.h }, mode);
      const xf = Transform.createTranslate(b.x + r.box.x, b.y + r.box.y)
        .multiply(Transform.createScale(r.sx, r.sy))
        .multiply(Transform.createTranslate(-it.abs.x, -it.abs.y));
      const copy = axiClone(doc, it.node, target, xf);
      const finalName = it.name === '' ? '' : it.name + '@' + b.name;
      if (finalName !== '') { copy.userDescription = finalName; }
      if (r.clamped) { clamped.push(finalName || 'child ' + i); }
    });
    return { name: b.name, x: b.x, y: b.y, w: b.w, h: b.h, s: mode === 'cover' ? Math.max(b.w / M.w, b.h / M.h) : Math.min(b.w / M.w, b.h / M.h), nodes: infos.length, clamped: clamped };
  });
}
`;
