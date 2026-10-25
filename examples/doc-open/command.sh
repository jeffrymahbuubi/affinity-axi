#!/bin/sh
# Open a saved asset: Open a .af, reuse it if already open, and show how it was made and what it contains
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/doc-open/asset.af
affinity-axi doc open examples/doc-open/asset.af
