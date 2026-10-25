#!/bin/sh
# Run a script: Run a script from disk against the demo document; failures are reported as failures
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi run examples/run/script.js --args '{"uuid":"$DOC"}'
