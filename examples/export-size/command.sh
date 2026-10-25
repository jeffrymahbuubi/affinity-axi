#!/bin/sh
# Export one artboard at 2x: Export a single artboard by name at twice its size with --scale
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi export $DOC PNG examples/export-size/ig-square@2x.png --artboard ig-square --scale 2
