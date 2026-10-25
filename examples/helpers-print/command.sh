#!/bin/sh
# Helpers: print sheet and crop marks: A proof sheet with bleed, slug, eight locked crop marks and trim and bleed guides
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-print/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-print/render.jpg
