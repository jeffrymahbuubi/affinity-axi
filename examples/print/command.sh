#!/bin/sh
# Print PDF with preflight: Export a press PDF (default PDF/X-4) and preflight it offline: boxes, bleed, colour, fonts
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/print/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi print $DOC --out examples/print/poster.pdf
