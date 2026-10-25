// Lumen Studio demo for the chart helpers: a mist card with a bar chart of
// bookings per week, a donut with a centre label, and the same 72 percent as a
// progress bar and a ring on an ink panel. Colours are passed explicitly (the
// helpers never read a brand kit). Run with --with-helpers; the document is
// found by the uuid in --args.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const INK = '#1F2A44';
const SKY = '#4C8DFF';
const SUN = '#FFC857';
const MIST = '#F2F5F9';
const BOLD = 'Helvetica-Bold';
const BODY = 'Helvetica';

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: MIST, name: 'card' });
axiText(doc, { x: 90, y: 150, text: 'Studio bookings, October', font: BOLD, size: 68, colour: INK, name: 'headline' });
axiRect(doc, { x: 90, y: 184, w: 160, h: 10, fill: SUN, name: 'rule' });

// Bars: four weeks, ink and sky alternating, value labels above each bar.
axiText(doc, { x: 90, y: 262, text: 'Sessions per week', font: BODY, size: 30, colour: INK, name: 'bars-title' });
const bars = axiBars(doc, {
  x: 90, y: 300, w: 440, h: 260, values: [18, 24, 21, 30], labels: ['W1', 'W2', 'W3', 'W4'],
  colours: [INK, SKY], gap: 0.3, radius: 8, labelFont: BODY, labelSize: 28, labelColour: INK, valueLabels: true, name: 'weeks',
});

// Donut: session types with the total in the hole.
axiText(doc, { x: 810, y: 262, text: 'By session type', font: BODY, size: 30, colour: INK, align: 'c', name: 'donut-title' });
const donut = axiDonut(doc, {
  cx: 810, cy: 430, r: 150, inner: 0.62, values: [52, 31, 17], colours: [SKY, SUN, INK], gap: 2,
  label: { text: '100', sub: 'sessions', font: BOLD, subFont: BODY, colour: INK }, name: 'types',
});
axiText(doc, { x: 810, y: 622, text: 'portrait, product, event', font: BODY, size: 26, colour: INK, align: 'c', name: 'donut-legend' });

// Progress on an ink panel: a bar and a ring, both 72 percent.
axiRect(doc, { x: 0, y: 700, w: 1080, h: 380, fill: INK, name: 'panel' });
axiText(doc, { x: 90, y: 780, text: 'Studio hours booked', font: BODY, size: 30, colour: MIST, name: 'progress-title' });
const progress = axiProgress(doc, {
  x: 90, y: 810, w: 560, h: 44, value: 72, max: 100, track: MIST, fill: SUN, radius: 22,
  label: { font: BOLD, colour: INK }, name: 'hours-bar',
});
axiProgress(doc, {
  value: 72, max: 100, track: MIST, fill: SUN, ring: { cx: 870, cy: 890, r: 120, inner: 0.78 },
  label: { font: BOLD, colour: MIST, size: 56 }, name: 'hours-ring',
});

console.log(JSON.stringify({ bars: bars.nodes.bars.length, slices: donut.nodes.slices.length, progress: progress.fraction }));
