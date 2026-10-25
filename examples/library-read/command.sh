#!/bin/sh
# Read a library script: Copy a library script to a file so its code stays out of context
affinity-axi library save examples/library-read/script.js --title "Lumen Studio demo" --description "Draws one rectangle"
affinity-axi library read "Lumen Studio demo" --out examples/library-read/library-copy.js
