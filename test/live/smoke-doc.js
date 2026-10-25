// Live smoke fixture: new A4 document with one blue rectangle. Logs the
// document's session UUID; exporting is left to the CLI's `export` command.
const { Document, NewDocumentOptions } = require('/document.js');
const { ShapeRectangle } = require('/shapes.js');
const { ShapeNodeDefinition } = require('/nodes.js');
const { RGBA8 } = require('/colours.js');

const doc = Document.createFromOptions(NewDocumentOptions.createDefault()); // A4, 300 dpi, px units
doc.addNode(ShapeNodeDefinition.create(ShapeRectangle.create(), {x: 100, y: 100, width: 400, height: 250}, RGBA8(40, 90, 200)));
console.log('session', doc.sessionUuid);
