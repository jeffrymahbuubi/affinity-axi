#!/bin/sh
# Helpers: one design, every size: Adapt a master artboard to story and OG boards, or draw each size from one function
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-variants/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-variants/render.jpg
affinity-axi export $DOC PNG examples/helpers-variants/{name}.png --all-artboards
