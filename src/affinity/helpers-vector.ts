// Vector helpers for run --with-helpers: outline text into curves and combine
// shapes with boolean operations, for logos, marks and favicons. Same rules as
// helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks,
// dollar-brace or backslash surprises).
//
// Both helpers leave their result selected on purpose, so `export --selection`
// (for example to "SVG (for export)") works right after the script. Use that
// preset for vectors: "SVG (flatten)" rasterises.

import type { HelperInfo } from "./helpers-core.js";

export const VECTOR_INDEX: readonly HelperInfo[] = [
  { name: "axiOutline", signature: "axiOutline(doc, ref, {name})", summary: "convert a text or shape node to curves (a group of glyph curves for text) so it exports as pure vector; ref is a name, path or node; keeps the original's name or applies name; returns the result, which stays selected" },
  { name: "axiBool", signature: "axiBool(doc, op, refs, {name})", summary: "boolean op on two or more nodes: union | subtract | intersect | xor | divide; subtract keeps the lowest node in the stack and cuts the ones above it; refs are names, paths or nodes; returns the result node (an array for divide), left selected" },
];

/** Internal building blocks, not in the index. */
export const VECTOR_INTERNAL: readonly string[] = ["axiNodesOf", "axiBoolResult"];

export const VECTOR_SOURCE: string = String.raw`
/* ---- vector helpers ---- */

// Internal: resolve refs to nodes. A string (name, artboard/name, #path) or a
// {text: ...} ref goes through axiFind; anything else must be a node already.
function axiNodesOf(doc, refs, who) {
  const out = [];
  for (const r of refs) {
    if (typeof r === 'string' || (r && typeof r === 'object' && !r.isNode && r.text !== undefined && r.text !== null)) {
      out.push(axiFind(doc, r));
    } else if (r && typeof r === 'object' && r.isNode) {
      out.push(r);
    } else {
      throw new Error(who + ': each ref must be a name, artboard/name, #index-path, {text} or a node');
    }
  }
  return out;
}

// Internal: the node(s) a vector command left selected. divide keeps every
// piece (array); the other ops yield one node. Applies name when given; a
// divide with several pieces gets name-1, name-2, ...
function axiBoolResult(doc, op, name) {
  const made = Array.from(doc.selection.nodes);
  if (made.length === 0) { throw new Error('axiBool: ' + op + ' produced no node (are the shapes overlapping?)'); }
  if (name !== undefined && name !== null) {
    made.forEach(function (n, i) {
      n.userDescription = made.length > 1 ? String(name) + '-' + (i + 1) : String(name);
    });
  }
  return op === 'divide' ? made : made[0];
}

// Convert text or a shape to curves. For text the result is a group holding one
// curve node per glyph, so an SVG export has paths and no <text>. The result
// keeps the original's name unless name is given, and stays selected.
function axiOutline(doc, ref, o) {
  const opts = o || {};
  if (ref === undefined || ref === null) { throw new Error('axiOutline: ref is required'); }
  const node = axiNodesOf(doc, [ref], 'axiOutline')[0];
  const { Selection } = require('/selections.js');
  const label = opts.name !== undefined && opts.name !== null ? String(opts.name) : String(node.userDescription || '');
  doc.convertToCurves(Selection.create(doc, node));
  const made = doc.selection.nodes.first;
  if (!made) { throw new Error('axiOutline: convert to curves left nothing selected'); }
  if (label !== '') { made.userDescription = label; }
  return made;
}

// Boolean operation on two or more nodes, given in refs. union merges them,
// intersect keeps the overlap, xor keeps what does not overlap, divide cuts them
// into pieces along every outline, subtract cuts the nodes above the lowest one
// out of it. Checked live: the order of refs does not matter for subtract, the
// stacking order does (the shape drawn first is the one that is kept). The
// result is selected.
function axiBool(doc, op, refs, o) {
  const opts = o || {};
  const ops = ['union', 'subtract', 'intersect', 'xor', 'divide'];
  if (ops.indexOf(op) < 0) { throw new Error('axiBool: unknown op ' + String(op) + '; use ' + ops.join(', ')); }
  if (!Array.isArray(refs) || refs.length < 2) { throw new Error('axiBool: refs must be an array of at least two nodes or names'); }
  const nodes = axiNodesOf(doc, refs, 'axiBool');
  const { Selection } = require('/selections.js');
  const sel = Selection.create(doc, nodes);
  if (op === 'union') { doc.boolOpUnion(sel); }
  else if (op === 'subtract') { doc.boolOpSubtract(sel); }
  else if (op === 'intersect') { doc.boolOpIntersect(sel); }
  else if (op === 'xor') { doc.boolOpXor(sel); }
  else { doc.divideShapes(sel); }
  return axiBoolResult(doc, op, opts.name);
}
`;
