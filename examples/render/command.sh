#!/bin/sh
# Render a preview: Preview the current spread as a JPEG on disk
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi render $DOC
affinity-axi render $DOC --out examples/render/render.jpg
