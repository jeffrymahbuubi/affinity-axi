// Lumen Studio demo for the multi-series chart helpers: a mist card with a legend
// under the headline, grouped bars (three series over four quarters) beside the
// same data as 100 percent stacked bars, and a two-series line chart with dots and
// grid rules on an ink panel. Colours are passed explicitly (the helpers never read
// a brand kit). Run with --with-helpers; the document is found by the uuid in --args.
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

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const SERIES = [
  { name: 'Portrait', values: [12, 18, 15, 22], colour: SKY },
  { name: 'Product', values: [8, 11, 14, 16], colour: SUN },
  { name: 'Event', values: [3, 5, 4, 9], colour: INK },
];

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: MIST, name: 'card' });
axiText(doc, { x: 90, y: 130, text: 'Sessions by quarter', font: BOLD, size: 64, colour: INK, name: 'headline' });
axiRect(doc, { x: 90, y: 160, w: 160, h: 10, fill: SUN, name: 'rule' });

// One legend for the three series, under the headline.
axiLegend(doc, { x: 90, y: 196, items: SERIES, columns: 3, font: BODY, size: 26, colour: INK, name: 'legend' });

// Grouped bars: three series over four quarters.
axiText(doc, { x: 90, y: 290, text: 'Sessions per quarter', font: BODY, size: 28, colour: INK, name: 'grouped-title' });
const grouped = axiGroupedBars(doc, {
  x: 90, y: 316, w: 470, h: 230, series: SERIES, labels: QUARTERS, max: 24, gap: 0.3, inner: 0.06, radius: 5,
  labelFont: BODY, labelSize: 26, labelColour: INK, name: 'grouped',
});

// The same numbers as shares: every column fills the height.
axiText(doc, { x: 620, y: 290, text: 'Share of sessions', font: BODY, size: 28, colour: INK, name: 'stacked-title' });
axiStackedBars(doc, {
  x: 620, y: 316, w: 370, h: 230, series: SERIES, labels: QUARTERS, percent: true, gap: 0.3, radius: 10,
  labelFont: BODY, labelSize: 26, labelColour: INK, name: 'stacked',
});

// Two lines with dots and four grid rules on an ink panel.
axiRect(doc, { x: 0, y: 650, w: 1080, h: 430, fill: INK, name: 'panel' });
axiText(doc, { x: 90, y: 716, text: 'Portrait vs product', font: BODY, size: 28, colour: MIST, name: 'line-title' });
axiLegend(doc, { x: 560, y: 690, items: SERIES.slice(0, 2), columns: 2, font: BODY, size: 26, colour: MIST, name: 'line-legend' });
const lines = axiLine(doc, {
  x: 130, y: 760, w: 820, h: 210, series: SERIES.slice(0, 2), labels: QUARTERS, max: 24, stroke: 6, dots: 9, grid: 4,
  labelFont: BODY, labelSize: 26, labelColour: MIST, name: 'trend',
});

console.log(JSON.stringify({ groups: grouped.nodes.bars[0].length, series: grouped.nodes.bars.length, points: lines.nodes.dots[0].length + lines.nodes.dots[1].length }));
