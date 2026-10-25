// Live probe for axiClone: can a duplicated node be re-parented into another
// artboard with DocumentCommand.createMoveNodes? Run with --with-helpers. It
// creates its own two-board document and addresses it by the variable, never by
// Document.current. It never closes anything: finish with
// `doc save <uuid8> <path.af>` then `doc close <uuid8>`.
//
// RESULT (N2, Affinity 3.3.1.4940, 2026-10-25): NodeMoveType members are Inside, After,
// Before. Only Inside re-parents the copy into the target artboard; the copy keeps its
// spread position, so the duplicate transform alone decides where it lands. After and
// Before leave it outside the artboard. Transforms compose right to left (the last
// factor is applied first). axiClone uses Inside, selfSelection and NodeChildType.Main.
const { DocumentCommand, NodeMoveType, NodeChildType } = require('/commands.js');
const { Transform } = require('/geometry.js');
const { Selection } = require('/selections.js');

const doc = axiDoc(1400, 600);
axiArtboards(doc, [{ name: 'a', w: 500, h: 500, fill: '#F2F5F9' }, { name: 'b', w: 500, h: 500, fill: '#1F2A44' }], { gap: 100 });
const a = axiOn(doc, 'a');
const b = axiOn(doc, 'b');
axiOn(doc, 'a');
axiRect(doc, { x: a.x + 40, y: a.y + 60, w: 120, h: 80, fill: '#4C8DFF', name: 'probe-src' });

const out = { uuid: String(doc.sessionUuid), moveTypes: Object.keys(NodeMoveType || {}), tries: [] };
const parentOf = function (label) {
  const hit = doc.artboards.filter(function (ab) {
    return Array.from(ab.node.children).some(function (n) { return String(n.userDescription) === label; });
  }).map(function (ab) { return ab.description; });
  return hit;
};
const boxOf = function (n) {
  const bx = n.getSpreadBaseBox(false);
  return { x: Math.round(bx.x), y: Math.round(bx.y), w: Math.round(bx.width), h: Math.round(bx.height) };
};

// Transform order: T(10,20) x S(2,3) applied to (1,1): scale-first gives (12,23).
const xf = Transform.createTranslate(10, 20).multiply(Transform.createScale(2, 3)).multiply(Transform.createTranslate(-1, -1));
out.xfOrder = [xf.applyToPoint({ x: 1, y: 1 }), xf.applyToPoint({ x: 2, y: 2 })];

let i = 0;
Object.keys(NodeMoveType || {}).forEach(function (member) {
  i += 1;
  const label = 'probe-copy-' + i + '-' + member;
  const t = { move: member };
  try {
    const src = axiFind(doc, 'a/probe-src');
    const copy = src.duplicate(Transform.createTranslate(b.x - a.x, b.y - a.y));
    copy.userDescription = label;
    t.afterDuplicate = parentOf(label);
    const target = doc.artboards.find(function (ab) { return ab.description === 'b'; }).node;
    doc.executeCommand(DocumentCommand.createMoveNodes(copy.selfSelection, target, NodeMoveType[member], NodeChildType.Main));
    t.afterMove = parentOf(label);
    const moved = axiFindAll(doc, 'b/' + label)[0];
    t.box = moved ? boxOf(moved) : null;
    t.ok = t.afterMove.length === 1 && t.afterMove[0] === 'b';
  } catch (e) {
    t.error = String(e && e.message ? e.message : e).slice(0, 160);
    t.ok = false;
  }
  out.tries.push(t);
});
out.working = out.tries.filter(function (t) { return t.ok; }).map(function (t) { return t.move; });
console.log(JSON.stringify(out));
