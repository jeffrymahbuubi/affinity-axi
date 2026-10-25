#!/bin/sh
# Add a note to an asset: Record a note in a .af's manifest without connecting
# DOC is the short id of the demo document (examples/_brand/demo-doc.js: 1080x1080, one artboard named ig-square).
affinity-axi doc save $DOC examples/doc-note/asset.af
affinity-axi doc note examples/doc-note/asset.af "Lumen Studio launch card, headline approved"
