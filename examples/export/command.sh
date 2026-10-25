#!/bin/sh
# Export a document: Export the whole document as a PNG with a validated preset name
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi export $DOC PNG examples/export/demo.png
