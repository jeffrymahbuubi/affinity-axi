// Demo for `run --with-helpers`: 1200x630 px doc, rounded rect, ellipse, two text lines.
// Uses only axi* helpers. Never closes the document.
const doc = axiDoc(1200, 630);
axiRect(doc, { x: 0, y: 0, w: 1200, h: 630, fill: '#F2F5F9' });
axiRect(doc, { x: 60, y: 60, w: 1080, h: 510, fill: '#1F2A44', radius: 48 });
axiEllipse(doc, { x: 820, y: 120, w: 260, h: 260, fill: '#FFC857' });
axiText(doc, { x: 120, y: 300, text: 'Light for every room', font: 'Helvetica-Bold', size: 80, colour: '#F2F5F9' });
// Second line: placed at the left, then measured and moved so its right edge sits at x = 1080.
axiText(doc, { x: 120, y: 480, text: 'Lumen Studio sessions', font: 'Helvetica', size: 40, colour: '#F2F5F9' });
const b = axiMeasure(doc);
axiMove(doc, 1080 - (b.x + b.w), 0);
const a = axiMeasure(doc);
console.log(JSON.stringify({ uuid: String(doc.sessionUuid), before: b, after: a }));
