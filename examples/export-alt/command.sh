#!/bin/sh
# Alt-text stub on export: Every exported image prints an alt-text stub built from the document's text, top-down
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/export-alt/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi export $DOC PNG examples/export-alt/card.png --artboard ig-square
