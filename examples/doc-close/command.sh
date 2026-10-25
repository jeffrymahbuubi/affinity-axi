#!/bin/sh
# Close a saved document: Close a document after saving it; closing an unsaved one is refused so no prompt can hang Affinity
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/doc-close/demo.af
affinity-axi doc close $DOC
