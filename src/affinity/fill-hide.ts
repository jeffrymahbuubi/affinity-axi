// `fill --hide-missing`: script lines spliced into the apply script (inside its try, after the plan loop).
// Every `slot:<key>` row that no edit covers is hidden, and so is each `with:<key>` row on the same artboard
// (for those slots and for the ones the records blanked: edits with hidden: true). The lines use doc, edits,
// out, axiRows, DocumentCommand and Selection from the apply script; the hidden keys land in out.hidden.

export const HIDE_MISSING_LINES: string[] = [
  "    out.hidden = [];",
  "    const hideRows = axiRows(doc);",
  "    const hideCovered = function (r) { return edits.some(function (e) { return e.ref === r.name || e.ref === r.artboard + '/' + r.name; }); };",
  "    const hideSlots = [];",
  "    const hideNode = function (n) { doc.executeCommand(DocumentCommand.createSetVisibility(Selection.create(doc, n), false)); };",
  "    const hideMark = function (board, k) { if (!hideSlots.some(function (s) { return s.board === board && s.k === k; })) { hideSlots.push({ board: board, k: k }); } };",
  "    hideRows.forEach(function (r) {",
  "      if (r.name.indexOf('slot:') === 0 && !hideCovered(r)) { hideNode(r.node); hideMark(r.artboard, r.name.slice(5)); }",
  "    });",
  "    edits.forEach(function (e) {",
  "      if (e.hidden !== true) { return; }",
  "      hideRows.forEach(function (r) {",
  "        if (r.name.indexOf('slot:') === 0 && (e.ref === r.name || e.ref === r.artboard + '/' + r.name)) { hideMark(r.artboard, r.name.slice(5)); }",
  "      });",
  "    });",
  "    hideSlots.forEach(function (s) {",
  "      hideRows.forEach(function (r) { if (r.name === 'with:' + s.k && r.artboard === s.board) { hideNode(r.node); } });",
  "      const several = hideRows.filter(function (r) { return r.name === 'slot:' + s.k; }).length > 1;",
  "      out.hidden.push(several ? s.board + '/' + s.k : s.k);",
  "    });",
];
