#!/bin/sh
# List saved assets: List the .af files under a folder with the script that made them and whether they are unchanged
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/assets/library/asset.af
affinity-axi assets --dir examples/assets/library
