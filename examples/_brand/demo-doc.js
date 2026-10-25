// Standard demo document for the gallery: 1080x1080 px with one artboard
// named ig-square, filled with the Lumen Studio mist colour. Run with
// --with-helpers. Prints the session uuid as the only console line.
const doc = axiDoc(1080, 1080);
axiArtboard(doc, { name: 'ig-square', x: 0, y: 0, w: 1080, h: 1080, fill: '#F2F5F9' });
console.log(JSON.stringify({ uuid: String(doc.sessionUuid) }));
