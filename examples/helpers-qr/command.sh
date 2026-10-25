#!/bin/sh
# Helpers: QR codes: Draw URL and WhatsApp QR codes with a quiet zone and names
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/helpers-qr/script.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi render $DOC --out examples/helpers-qr/render.jpg
