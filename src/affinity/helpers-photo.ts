// Photo helpers for run --with-helpers: bake live filters into pixels, document
// snapshots, and straightening a tilted photo. Same rules as helpers-core.ts:
// function declarations only, prefixed axi, every require() inside a function,
// no document-closing call, no generative API. The block is String.raw: keep
// backticks, ${ and backslashes out of it.
//
// SDK used: DocumentCommand.createRasteriseObjects (the live filters under a
// pixel layer become pixels), DocumentCommand.createAddDocumentSnapshot and
// createRestoreDocumentSnapshot with Document.snapshots (each has a description),
// DocumentCommand.createTransform with a composed Transform (translate * rotate *
// scale * translate, a document-space transform that leaves the frame alone). Snapshots are
// session state: they live while the document stays open and the SDK has no way
// to revert except restoring one, so a script must never close the master.

import type { HelperInfo } from "./helpers-core.js";

export const PHOTO_INDEX: readonly HelperInfo[] = [
  { name: "axiBake", signature: "axiBake(doc, ref, {snapshot})", summary: "turn a pixel layer's live filters and adjustments into pixels (ref as axiFind, or a node; a picture frame bakes the picture inside it); snapshot true (default) first saves the document snapshot 'bake:<name>' (a repeat gets ':2', ':3', ...) so axiRestore can undo it; rasterising replaces the node, so the returned node is found again by its name; slow on large photos (about 6 s at 12 MP)" },
  { name: "axiSnapshot", signature: "axiSnapshot(doc, name)", summary: "save a named document snapshot of the current state; name a non-empty string, throws when a snapshot of that name exists; returns name; snapshots last while the document stays open" },
  { name: "axiRestore", signature: "axiRestore(doc, name)", summary: "restore the named document snapshot (throws listing the known names when none matches); node references taken before the restore are stale, find them again by name; returns name" },
  { name: "axiStraighten", signature: "axiStraighten(doc, ref, degrees, {crop})", summary: "rotate a photo by degrees (positive clockwise, 0 < |degrees| <= 10) about the centre of its picture frame (axiImage fit cover with frame:true) and scale it up in the same transform so it still covers the frame; the frame never changes; scale s = |cos| + max(W,H)/min(W,H) * |sin|; crop false skips the scale (wedges show until a later crop); a bare pixel layer uses its artboard (else the document) as the box; ref as axiFind or a node, the picture or its frame; call it once per photo; returns {node: the picture, lost: 1 - 1/s^2, the share of the picture area now outside the frame, 0..1}" },
];

/** Internal building blocks, not in the index. */
export const PHOTO_INTERNAL: readonly string[] = ["axiCoverScale", "axiPhotoNode", "axiPhotoTarget", "axiSnapshotNamed"];

export const PHOTO_SOURCE: string = String.raw`
/* ---- photo helpers ---- */

// Internal: the node for ref. A string goes through axiFind (name, artboard/name,
// #path); null or undefined is the current selection; anything else is a node.
function axiPhotoNode(who, doc, ref) {
  if (typeof ref === 'string') { return axiFind(doc, ref); }
  const n = ref || doc.selection.nodes.first;
  if (!n) { throw new Error(who + ': nothing selected; pass a node or a name'); }
  return n;
}

// Internal: {pic, frame} for ref. pic is the image or pixel layer (ref itself, or
// the picture inside a picture frame); frame is its picture frame or null.
function axiPhotoTarget(who, doc, ref) {
  const n = axiPhotoNode(who, doc, ref);
  if (n.pictureFrameEnabled && !n.isImageNode && !n.isRasterNode) {
    for (const c of n.children) { if (c.isImageNode || c.isRasterNode) { return { pic: c, frame: n }; } }
    throw new Error(who + ': the frame holds no picture');
  }
  if (n.isImageNode || n.isRasterNode) {
    let p = null;
    try { p = n.parent; } catch (e) { p = null; }
    return { pic: n, frame: p && p.pictureFrameEnabled ? p : null };
  }
  throw new Error(who + ': node is not an image, a pixel layer or a picture frame holding one');
}

// Internal: the document snapshot whose description is name, or null.
function axiSnapshotNamed(doc, name) {
  const all = Array.from(doc.snapshots);
  for (const s of all) { if (String(s.description) === name) { return s; } }
  return null;
}

// Save a named document snapshot of the current state. Throws on an empty or
// duplicate name. Returns name.
function axiSnapshot(doc, name) {
  if (typeof name !== 'string' || name.trim() === '') { throw new Error('axiSnapshot: name must be a non-empty string'); }
  if (axiSnapshotNamed(doc, name)) { throw new Error('axiSnapshot: a snapshot named ' + name + ' already exists'); }
  const { DocumentCommand } = require('/commands.js');
  doc.executeCommand(DocumentCommand.createAddDocumentSnapshot(name));
  if (!axiSnapshotNamed(doc, name)) { throw new Error('axiSnapshot: the snapshot ' + name + ' was not created'); }
  return name;
}

// Restore the named document snapshot. Node references from before are stale
// afterwards; find them again by name. Returns name.
function axiRestore(doc, name) {
  if (typeof name !== 'string' || name.trim() === '') { throw new Error('axiRestore: name must be a non-empty string'); }
  const snap = axiSnapshotNamed(doc, name);
  if (!snap) {
    const known = Array.from(doc.snapshots).map(function (s) { return String(s.description); });
    throw new Error('axiRestore: no snapshot named ' + name + '; known: ' + (known.join(', ') || 'none'));
  }
  const { DocumentCommand } = require('/commands.js');
  doc.executeCommand(DocumentCommand.createRestoreDocumentSnapshot(snap));
  return name;
}

// Rasterise a pixel layer with its live filters and adjustments, so the pixels
// hold the result. Snapshot 'bake:<name>' is saved first unless snapshot is false
// (a repeat of the same name gets ':2', ':3', ...). Rasterising replaces the node,
// so the new one is found again by its name, else it is the new selection.
// Returns the new node.
function axiBake(doc, ref, o) {
  const opts = o || {};
  if (opts.snapshot !== undefined && typeof opts.snapshot !== 'boolean') { throw new Error('axiBake: snapshot must be true or false, got ' + opts.snapshot); }
  const pic = axiPhotoTarget('axiBake', doc, ref).pic;
  const name = String(pic.userDescription || '');
  if (opts.snapshot !== false) {
    const base = 'bake:' + (name || (typeof ref === 'string' ? ref : 'photo'));
    let snap = base;
    for (let i = 2; axiSnapshotNamed(doc, snap) && i < 1000; i += 1) { snap = base + ':' + i; }
    axiSnapshot(doc, snap);
  }
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  doc.executeCommand(DocumentCommand.createRasteriseObjects(Selection.create(doc, pic), false, true));
  let out = null;
  if (name !== '') { try { out = axiFind(doc, name); } catch (e) { out = null; } }
  if (!out) { out = doc.selection.nodes.first; }
  if (!out) { throw new Error('axiBake: the rasterised node was not found'); }
  if (name !== '' && String(out.userDescription || '') !== name) { out.userDescription = name; }
  return out;
}

// Internal: the uniform scale s that lets a picture turned by rad about the centre
// of a w by h box still cover that whole box (the box rotated by -rad, shrunk by
// 1/s, then lies inside the box): s = |cos| + max(w, h) / min(w, h) * |sin|.
// 1 at 0 degrees. Pure maths, no SDK call.
function axiCoverScale(w, h, rad) {
  const num = function (v) { return typeof v === 'number' && isFinite(v); };
  if (!num(w) || !num(h) || w <= 0 || h <= 0) { throw new Error('axiCoverScale: w and h must be positive numbers'); }
  if (!num(rad)) { throw new Error('axiCoverScale: rad must be a finite number'); }
  return Math.abs(Math.cos(rad)) + Math.max(w, h) / Math.min(w, h) * Math.abs(Math.sin(rad));
}

// Straighten a photo: turn the picture by degrees (positive clockwise, 0 <
// |degrees| <= 10) about the centre of its frame and scale it up in the same
// transform, so it still covers the frame and no wedge shows. The frame itself
// never changes. The frame box is the picture frame, else the artboard that
// holds a bare pixel layer, else the document. crop false skips the scale (scale
// 1, lost 0; wedges show until a later crop). Call it once per photo: the maths
// assume an upright picture that already covers the frame. Returns {node, lost}:
// node is the picture, lost = 1 - 1 / s^2, the share of the picture's area (0..1)
// that now falls outside the frame.
function axiStraighten(doc, ref, degrees, o) {
  const opts = o || {};
  if (typeof degrees !== 'number' || !isFinite(degrees)) { throw new Error('axiStraighten: degrees must be a finite number, got ' + degrees); }
  if (degrees === 0) { throw new Error('axiStraighten: degrees must not be 0'); }
  if (Math.abs(degrees) > 10) { throw new Error('axiStraighten: degrees must be within -10..10, got ' + degrees); }
  const crop = opts.crop === undefined ? true : opts.crop;
  if (typeof crop !== 'boolean') { throw new Error('axiStraighten: crop must be true or false, got ' + opts.crop); }
  const t = axiPhotoTarget('axiStraighten', doc, ref);
  const { Transform } = require('/geometry.js');
  const { DocumentCommand } = require('/commands.js');
  const { Selection } = require('/selections.js');
  const rad = degrees * Math.PI / 180;
  const box = t.frame ? axiNodeBox(t.frame) : axiBoardBox(doc, t.pic);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const s = crop ? axiCoverScale(box.w, box.h, rad) : 1;
  const xf = Transform.createTranslate(cx, cy).multiply(Transform.createRotate(rad)).multiply(Transform.createScale(s, s)).multiply(Transform.createTranslate(-cx, -cy));
  doc.executeCommand(DocumentCommand.createTransform(Selection.create(doc, t.pic), xf));
  return { node: t.pic, lost: 1 - 1 / (s * s) };
}
`;
