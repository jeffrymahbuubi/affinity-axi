#!/bin/sh
# Helpers: brand tokens: Draw from kit tokens and type styles instead of hard-coded colours and fonts
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-brand/script.js --with-helpers --brand examples/_brand/brand.json --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-brand/render.jpg
