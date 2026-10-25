// Live probe for the named-helper spread switch (unit H2). Run with --with-helpers.
// It creates its own two-page document (NewDocumentOptions isMultiPage + pageCount 2),
// draws named elements on each page, makes page 0 current and edits the page-1
// elements. For each of the five mutators' underlying operations it logs whether the
// raw edit took effect on a non-current spread, whether it took effect after
// DocumentCommand.createSetCurrentSpread, and what the switch did to the current
// spread and the selection. When axiOnSpread exists it then runs the real mutators
// (axiSetText, axiSetFill, axiSetBox, axiRename, axiDelete) on page 1 and logs the
// readback and the restored current spread. The document is addressed by the variable
// (never Document.current). It never closes anything: finish with
// `doc save <uuid8> <path.af>` then `doc close <uuid8>`.
//
// RESULT (H2, Affinity 3.3.1.4940, 2026-10-26): isMultiPage = true with pageCount = 2 gives
// two spreads in doc.spreads (doc.pageCount 2); draw on a page by making its spread current
// first. With page 0 current, on a page-1 node: setText (node.setText) and rename
// (userDescription) fail with COMMAND_FAILED and change nothing; after
// DocumentCommand.createSetCurrentSpread they work. setFill (setBrushFillDescriptor),
// setBox (applyTransform) and delete (deleteSelection) took effect WITHOUT a switch on these
// shapes (setFill left a one-node selection behind); the wrapper is applied to all five anyway
// so text and other node types are covered. The switch clears the selection; axiOnSpread
// re-selects the nodes that were selected, so a page-0 selection survives a page-1 edit.
// The helpers restore the current spread (cur 0 -> 0) and take no command on page 0.
const { Document, NewDocumentOptions } = require('/document.js');
const { UnitType } = require('/units.js');
const { DocumentCommand } = require('/commands.js');

const o = NewDocumentOptions.createDefault();
o.units = UnitType.Pixel; o.width = 800; o.height = 600; o.dpi = 72;
o.isMultiPage = true; o.pageCount = 2;
const doc = Document.createFromOptions(o);

const out = { uuid: String(doc.sessionUuid), steps: [] };
const spreads = Array.from(doc.spreads);
out.spreadCount = spreads.length;
try { out.pageCount = doc.pageCount; } catch (e) { out.pageCount = 'n/a: ' + String(e.message).slice(0, 60); }

const curIndex = function () {
  const cur = doc.currentSpread;
  for (let i = 0; i < spreads.length; i += 1) {
    if (cur.isSameNode(spreads[i])) { return i; }
  }
  return -1;
};
const setCur = function (i) {
  doc.executeCommand(DocumentCommand.createSetCurrentSpread(spreads[i]));
};
const selLen = function () { return doc.selection.length; };
const state = function () { return { cur: curIndex(), sel: selLen() }; };
const fillOf = function (n) {
  try { return JSON.stringify(n.brushFillInterface.fillDescriptor.fill.colour.rgba8); } catch (e) { return 'err ' + String(e.message).slice(0, 60); }
};
const count = function () { return axiRows(doc).length; };

out.start = state();
if (spreads.length < 2) {
  out.note = 'only ' + spreads.length + ' spread(s); the wrapper is a no-op on one spread and stays';
  console.log(JSON.stringify(out));
} else {
  // Draw: page 1 first (so page 0 ends current with a one-node selection).
  [1, 0].forEach(function (i) {
    setCur(i);
    axiRect(doc, { x: 100, y: 100, w: 200, h: 100, fill: '#4C8DFF', name: 'rect-p' + i });
    axiText(doc, { x: 100, y: 300, text: 'Page ' + i, font: 'Helvetica-Bold', size: 48, colour: '#1F2A44', name: 'text-p' + i });
    if (i === 1) {
      ['rect2-p1', 'rect3-p1', 'rect4-p1'].forEach(function (nm, k) {
        axiRect(doc, { x: 350, y: 100 + k * 120, w: 120, h: 80, fill: '#E0A84A', name: nm });
      });
    }
  });
  out.children = spreads.map(function (s) { return Array.from(s.children).length; });
  out.afterDraw = state();

  const step = function (label, raw, read) {
    const t = { label: label };
    setCur(0);
    t.before = state();
    t.read0 = read();
    try { raw(); t.rawError = null; } catch (e) { t.rawError = String(e.message).slice(0, 100); }
    t.afterRaw = state();
    t.read1 = read();
    t.rawTookEffect = t.read1 !== t.read0;
    if (!t.rawTookEffect) {
      setCur(1);
      t.afterSwitch = state();
      try { raw(); t.switchError = null; } catch (e) { t.switchError = String(e.message).slice(0, 100); }
      setCur(0);
      t.afterRestore = state();
      t.read2 = read();
      t.switchedTookEffect = t.read2 !== t.read1;
    }
    out.steps.push(t);
  };

  const { FillDescriptor } = require('/fills.js');
  const { Transform } = require('/geometry.js');

  const nText = axiFind(doc, 'text-p1');
  step('setText', function () { nText.setText('Edited raw'); }, function () { return nText.text; });

  const nFill = axiFind(doc, 'rect-p1');
  step('setFill', function () { doc.setBrushFillDescriptor(FillDescriptor.createSolid(axiHex('#B5252A')), nFill); }, function () { return fillOf(nFill); });

  const nBox = axiFind(doc, 'rect2-p1');
  step('setBox', function () { doc.applyTransform(Transform.createTranslate(40, 0), nBox); }, function () { return JSON.stringify(axiNodeBox(nBox)); });

  const nName = axiFind(doc, 'rect3-p1');
  step('rename', function () { nName.userDescription = 'renamed-raw'; }, function () { return String(nName.userDescription); });

  const nDel = axiFind(doc, 'rect4-p1');
  step('delete', function () { doc.deleteSelection(nDel); }, function () { return String(count()); });

  // Real mutators, when the helpers carry the spread switch.
  if (typeof axiOnSpread === 'function') {
    setCur(0);
    const real = { before: state() };
    const check = function (label, fn, read) {
      setCur(0);
      const b = state();
      let err = null;
      try { fn(); } catch (e) { err = String(e.message).slice(0, 100); }
      real[label] = { error: err, before: b, after: state(), value: read() };
    };
    check('axiSetText', function () { axiSetText(doc, 'text-p1', 'Edited by helper'); }, function () { return axiFind(doc, 'text-p1').text; });
    check('axiSetFill', function () { axiSetFill(doc, 'rect-p1', '#2F6F5E'); }, function () { return fillOf(axiFind(doc, 'rect-p1')); });
    check('axiSetBox', function () { axiSetBox(doc, 'rect2-p1', { x: 500, y: 60, w: 150, h: 90 }); }, function () { return JSON.stringify(axiNodeBox(axiFind(doc, 'rect2-p1'))); });
    check('axiRename', function () { axiRename(doc, 'rect2-p1', 'box-p1'); }, function () { return String(axiFind(doc, 'box-p1').userDescription); });
    const before = count();
    check('axiDelete', function () { axiDelete(doc, 'box-p1'); }, function () { return before + '->' + count(); });
    // Page 0 edits must not switch anything.
    check('page0 axiSetText', function () { axiSetText(doc, 'text-p0', 'Edited p0'); }, function () { return axiFind(doc, 'text-p0').text; });
    // Selection: one page-0 node selected, a page-1 edit must leave it selected.
    setCur(0);
    doc.selection = [axiFind(doc, 'text-p0')];
    const keep = { before: state() };
    axiSetText(doc, 'text-p1', 'Edited again');
    axiSetFill(doc, 'text-p1', '#B5252A');
    keep.after = state();
    keep.selectedName = Array.from(doc.selection.nodes).map(function (n) { return String(n.userDescription); });
    real.selectionKept = keep;
    out.real = real;
  }
  out.end = state();
  console.log(JSON.stringify(out));
}
