#!/bin/sh
# Helpers: images: Place a photo with cover fit, rounded corners and a focus point
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-image/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-image/render.jpg
