#!/bin/sh
# Helpers: multi-series charts: Grouped and stacked bars, a line chart with dots and gridlines, and a legend from plain series
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-charts2/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-charts2/render.jpg
