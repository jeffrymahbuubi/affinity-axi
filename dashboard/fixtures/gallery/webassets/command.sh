#!/bin/sh
# Web asset bundle: Favicons, OG and X cards and @1x/@2x sets from named artboards, with head.html and a manifest
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/webassets/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/webassets/render.jpg
affinity-axi webassets $DOC --out-dir examples/webassets/site --responsive hero
