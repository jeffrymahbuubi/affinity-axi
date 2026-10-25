// Lumen Studio demo for axiTable: a price table on the ig-square artboard.
// Equal columns, a Helvetica-Bold sky header row, Helvetica body text.
// Run with --with-helpers; the document is found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#1F2A44', name: 'bg' });
axiText(doc, { x: 90, y: 230, text: 'Studio rates', font: 'Helvetica-Bold', size: 110, colour: '#F2F5F9', name: 'headline' });

const rows = [
  ['Room', 'Hourly', 'Half day', 'Day'],
  ['Studio A', '40', '140', '260'],
  ['Studio B', '55', '190', '350'],
  ['Loft', '70', '240', '440'],
  ['Garden room', '35', '120', '220'],
];
axiTable(doc, {
  x: 90, y: 330, w: 900, h: 500, rows: rows,
  font: 'Helvetica', size: 32, colour: '#F2F5F9',
  header: { font: 'Helvetica-Bold', size: 36, colour: '#4C8DFF' },
  name: 'prices',
});
console.log(JSON.stringify({ rows: rows.length, cols: rows[0].length }));
