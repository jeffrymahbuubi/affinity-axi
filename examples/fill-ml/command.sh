#!/bin/sh
# Fill a template with a cut-out photo: A picture slot takes cutout, colourise and align: ML runs on the placed photo, about 10 s each; the cut-out is centred in its frame
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/fill-ml/template.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi doc save $DOC examples/fill-ml/template.af
affinity-axi doc close $DOC
affinity-axi fill examples/fill-ml/template.af --data examples/fill-ml/posts.json --key slug --out-dir examples/fill-ml --export PNG
