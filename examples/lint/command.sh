#!/bin/sh
# Design checks: Contrast, safe zones, small text, slot names and off-kit colours, as a table with severities
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/lint/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi lint $DOC --brand examples/_brand/brand.json
affinity-axi render $DOC --out examples/lint/render.jpg
