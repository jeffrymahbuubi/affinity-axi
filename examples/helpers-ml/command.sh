#!/bin/sh
# Helpers: ML cut-outs, depth and colourise: Cut a product out of its photo and fit it in its box, make a depth map that keeps the photo, blur a background by depth, and colourise an old greyscale photo
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-ml/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-ml/render.jpg
