#!/bin/sh
# Save a document: Save a document as a .af file under the Desktop folder; it is clean afterwards
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/doc-save/demo.af
