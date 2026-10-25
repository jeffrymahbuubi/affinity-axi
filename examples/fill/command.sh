#!/bin/sh
# Fill a template by element name: Load a saved .af, set slot:<key> elements from JSON or CSV, save and export one file per record
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/fill/template.js --with-helpers --args '{"uuid":"$DOC"}'
affinity-axi doc save $DOC examples/fill/template.af
affinity-axi doc close $DOC
affinity-axi fill examples/fill/template.af --data examples/fill/posts.json --key slug --out-dir examples/fill --export PNG
