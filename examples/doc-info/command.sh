#!/bin/sh
# Read an asset's manifest: Show how a .af was made and its history from its manifest, without connecting
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/doc-info/asset.af
affinity-axi doc info examples/doc-info/asset.af
