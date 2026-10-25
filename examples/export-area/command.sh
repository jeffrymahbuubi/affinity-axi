#!/bin/sh
# Export every artboard: Export one file per artboard; the path holds {name} for the artboard name
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi export $DOC PNG examples/export-area/{name}.png --all-artboards
