#!/bin/sh
# Export under a file-size budget: Step JPEG, WebP or PNG presets and then size until the file fits --max-kb
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi export $DOC "JPEG (High quality)" examples/export-budget/ad.jpg --artboard ig-square --max-kb 40
