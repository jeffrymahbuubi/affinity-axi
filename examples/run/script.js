// Lumen Studio demo: one sky-blue rectangle on the demo document, using the
// raw SDK (no helpers). The document is found by the uuid passed in --args.
const { Document } = require('/document.js');
const { ShapeRectangle } = require('/shapes.js');
const { ShapeNodeDefinition } = require('/nodes.js');
const { RGBA8 } = require('/colours.js');

const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
doc.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: 140, y: 340, width: 800, height: 400 }, RGBA8(76, 141, 255)));
console.log('added: 1 rectangle');
