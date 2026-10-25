#!/bin/sh
# Helpers: logo and favicon vectors: Outline a wordmark, build a mark with boolean ops, export SVG and a 32 px favicon
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-vector/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-vector/render.jpg
affinity-axi export $DOC "SVG (for export)" examples/helpers-vector/mark.svg --selection
affinity-axi export $DOC PNG examples/helpers-vector/favicon-32.png --artboard mark --square 32
