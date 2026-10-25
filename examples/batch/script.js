// Lumen Studio batch template: one 1080x1080 card per record. batch passes the
// record fields plus key, index, outDir and outBase as ARGS; run with
// --with-helpers. It makes its own document and never closes it (batch saves
// and closes each one).
const doc = axiDoc(1080, 1080);
axiArtboard(doc, { name: 'ig-square', x: 0, y: 0, w: 1080, h: 1080, fill: '#1F2A44' });
axiOn(doc, 'ig-square');
axiEllipse(doc, { x: 700, y: 90, w: 260, h: 260, fill: '#FFC857', name: 'sun' });
axiFitText(doc, { x: 90, y: 420, w: 900, h: 300, text: ARGS.headline, font: 'Helvetica-Bold', size: 120, minSize: 56, colour: '#F2F5F9', leading: 1.1, name: 'headline' });
axiFitText(doc, { x: 90, y: 780, w: 900, h: 160, text: ARGS.subline, font: 'Helvetica', size: 56, minSize: 28, colour: '#4C8DFF', name: 'subline' });
console.log(JSON.stringify({ uuid: String(doc.sessionUuid), slug: ARGS.slug }));
