// Clip helper for run --with-helpers: axiClip crops nodes to a rounded or
// elliptical frame. Same rules as helpers-core.ts (function declarations
// prefixed axi, requires inside functions, nothing blocking or generative,
// String.raw so no backticks, dollar-brace or backslash surprises).
//
// Live probe (test/live/vector-probe.js, Affinity 3.3.3.5004): a node moved into a
// shape with DocumentCommand.createMoveNodes(n.selfSelection, frame,
// NodeMoveType.Inside, NodeChildType.Main) is cut at the shape's outline, for
// picture-frame rectangles and ellipses and for plain rounded rectangles,
// ellipses and polycurves alike. So an existing frame may be any shape node.
//
// Insertion point: after a move Inside, the NEXT node the script creates lands inside
// that container. axiClip therefore ends by selecting the frame's PARENT (artboard,
// layer or spread), the same reset axiSurface does for picture frames, so later nodes
// are siblings of the frame. Pass {select: true} to keep the frame selected instead
// (for export --selection); a plain shape selected that way still needs its parent
// selected by hand before more drawing.
//
// Validation runs before any require() and before any node is created.

import type { HelperInfo } from "./helpers-core.js";

export const CLIP_INDEX: readonly HelperInfo[] = [
  {
    name: "axiClip",
    signature: "axiClip(doc, frame, content, {name, select})",
    summary: "crop nodes to a shape: frame is a spec {shape:'rect'|'ellipse', x,y,w,h, radius, fill, fillAlpha, stroke, strokeWidth} (a new picture frame) or an existing frame node, name or #path (an axiRect with frame:true, or any closed shape); content is a node or name, an array of them, or a function(doc) that draws and returns its nodes; the nodes keep their position and are cut at the frame's outline, rounded corners included; returns {frame, nodes}; the frame's parent is left selected so later shapes are siblings, not clipped children (select:true keeps the frame selected)",
  },
];

/** Internal building blocks, not in the index. */
export const CLIP_INTERNAL: readonly string[] = ["axiClipFrame"];

export const CLIP_SOURCE: string = String.raw`
/* ---- clip helpers ---- */

// Internal: the frame node for axiClip. A spec object makes a new picture frame
// (rect through axiRect, ellipse through ShapeEllipse); a node, name or #path is
// resolved with axiFind. Spec fields are validated by the caller.
function axiClipFrame(doc, frame, name) {
  if (frame && typeof frame === 'object' && !frame.isNode) {
    const spec = Object.assign({}, frame, { frame: true, name: name !== undefined && name !== null ? name : frame.name });
    if (spec.shape === 'ellipse') {
      axiSurface(doc);
      const { ShapeEllipse } = require('/shapes.js');
      const { ShapeNodeDefinition } = require('/nodes.js');
      const st = axiStroke(spec);
      const def = ShapeNodeDefinition.create(ShapeEllipse.create(), { x: spec.x, y: spec.y, width: spec.w, height: spec.h }, spec.fill ? axiHex(spec.fill, spec.fillAlpha) : null, st[0], st[1]);
      def.pictureFrameEnabled = true;
      doc.addNode(def);
      return axiName(doc.selection.nodes.first, spec.name);
    }
    return axiRect(doc, spec);
  }
  const node = typeof frame === 'string' ? axiFind(doc, frame) : frame;
  if (name !== undefined && name !== null) { node.userDescription = String(name); }
  return node;
}

// Crop nodes to a frame. frame: a spec {shape:'rect'|'ellipse', x, y, w, h, radius,
// fill, fillAlpha, stroke, strokeWidth, name} for a new picture frame, or an existing
// shape node / name / #path. content: a node or name, an array of them, or
// function(doc) that draws and returns its nodes (nothing returned: the selection).
// The nodes keep their coordinates and are cut at the frame's outline. Returns
// {frame, nodes}. Afterwards the frame's parent is selected (see the file header);
// {select: true} selects the frame.
function axiClip(doc, frame, content, o) {
  const opts = o || {};
  const isSpec = frame && typeof frame === 'object' && !frame.isNode;
  if (!isSpec && typeof frame !== 'string' && !(frame && typeof frame === 'object' && frame.isNode)) {
    throw new Error('axiClip: frame must be a spec {shape,x,y,w,h} or a picture frame (axiRect with frame:true, or the parent of a framed axiImage)');
  }
  if (isSpec) {
    const shape = frame.shape === undefined ? 'rect' : frame.shape;
    if (shape !== 'rect' && shape !== 'ellipse') { throw new Error('axiClip: shape must be rect or ellipse'); }
    for (const k of ['x', 'y', 'w', 'h']) {
      if (typeof frame[k] !== 'number' || !isFinite(frame[k])) { throw new Error('axiClip: x, y, w and h must be numbers, w and h positive'); }
    }
    if (frame.w <= 0 || frame.h <= 0) { throw new Error('axiClip: x, y, w and h must be numbers, w and h positive'); }
  }
  const isFn = typeof content === 'function';
  const items = Array.isArray(content) ? content : [content];
  if (!isFn) {
    if (items.length === 0) { throw new Error('axiClip: content must be a node, a name, an array of them or a function'); }
    for (const c of items) {
      if (typeof c !== 'string' && !(c && typeof c === 'object' && c.isNode)) { throw new Error('axiClip: content must be a node, a name, an array of them or a function'); }
    }
  }
  const name = opts.name !== undefined && opts.name !== null ? opts.name : (isSpec ? frame.name : undefined);

  const box = axiClipFrame(doc, frame, name);
  if (box.parent) { doc.selection = box.parent; }
  axiSurface(doc);
  let made;
  if (isFn) {
    const r = content(doc);
    made = Array.isArray(r) ? r : (r ? [r] : []);
    if (made.length === 0 && doc.selection.nodes.first) { made = [doc.selection.nodes.first]; }
    if (made.length === 0) { throw new Error('axiClip: draw made no node'); }
  } else {
    made = items.map(function (c) { return typeof c === 'string' ? axiFind(doc, c) : c; });
  }
  const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');
  const same = function (a, b) { return a === b || (typeof a.isSameNode === 'function' && a.isSameNode(b)); };
  made.forEach(function (n) {
    doc.executeCommand(DocumentCommand.createMoveNodes(n.selfSelection, box, NodeMoveType.Inside, NodeChildType.Main));
    if (!Array.from(box.children).some(function (c) { return same(c, n); })) {
      throw new Error('axiClip: cannot move a node into the frame on this Affinity build');
    }
  });
  doc.selection = (opts.select || !box.parent) ? box : box.parent;
  return { frame: box, nodes: made };
}
`;
