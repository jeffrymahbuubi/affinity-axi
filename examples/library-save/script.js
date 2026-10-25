// Lumen Studio demo script for the library examples: makes a new document and
// draws one sky-blue rectangle. It does not touch any document that is already open.
const { Document, NewDocumentOptions } = require('/document.js');
const { ShapeRectangle } = require('/shapes.js');
const { ShapeNodeDefinition } = require('/nodes.js');
const { RGBA8 } = require('/colours.js');

const doc = Document.createFromOptions(NewDocumentOptions.createDefault());
doc.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), { x: 100, y: 100, width: 400, height: 250 }, RGBA8(76, 141, 255)));
console.log('session', doc.sessionUuid);
