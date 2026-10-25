// Demo for `run --with-helpers` (named-element helpers): two artboards that both
// have a `headline` and a `cta`. Shows that a bare name is ambiguous, edits one
// artboard through `og/headline`, renames by index path, resizes and recolours.
// It works only on the document it creates itself and addresses it by that
// variable, never by Document.current. Never closes anything: finish with
// `doc save <uuid8> <path>` then `doc close <uuid8>`.
const doc = axiDoc(2400, 1200);
axiArtboards(doc, [
  { name: 'ig-square', w: 1000, h: 1000, fill: '#F6F1E8' },
  { name: 'og', w: 1200, h: 630, fill: '#F6F1E8' },
], { gap: 100 });
['ig-square', 'og'].forEach(function (ab) {
  const o = axiOn(doc, ab);
  axiRect(doc, { x: o.x + 60, y: o.y + o.h - 200, w: 320, h: 96, fill: '#2F6F5E', radius: 24, name: 'cta' });
  axiText(doc, { x: o.x + 60, y: o.y + 220, text: 'Light measured', font: 'Helvetica-Bold', size: 96, colour: '#1F2A44', name: 'headline' });
});
const out = { uuid: String(doc.sessionUuid) };
out.names = axiNames(doc).map(function (n) { return n.path + ' ' + n.type + ' ' + n.artboard + '/' + n.name; });
try { axiFind(doc, 'headline'); out.ambiguous = 'NOT THROWN'; } catch (e) { out.ambiguous = String(e.message); }
try { axiFind(doc, 'nope'); out.missing = 'NOT THROWN'; } catch (e) { out.missing = String(e.message); }
out.findAll = axiFindAll(doc, 'headline').length;
out.byText = axiFindAll(doc, { text: /^Light/ }).length;
axiSetText(doc, 'og/headline', 'New');
axiSetFill(doc, 'og/headline', '#B5252A');
axiSetFill(doc, 'ig-square/cta', '#E0A84A');
const before = axiNodeBox(axiFind(doc, 'og/cta'));
axiSetBox(doc, 'og/cta', { x: before.x + 400, w: 480 });
out.ctaBefore = before;
out.ctaAfter = axiNodeBox(axiFind(doc, 'og/cta'));
const ctaPath = axiNames(doc).filter(function (n) { return n.artboard === 'ig-square' && n.name === 'cta'; })[0].path;
axiRename(doc, '#' + ctaPath, 'button');
out.renamed = axiNames(doc).filter(function (n) { return n.name === 'button'; }).map(function (n) { return n.path; });
out.texts = axiFindAll(doc, { text: '.' }).map(function (n) { return n.text; });
axiDelete(doc, 'ig-square/headline');
out.afterDelete = axiNames(doc).map(function (n) { return n.artboard + '/' + n.name; });
console.log(JSON.stringify(out));
