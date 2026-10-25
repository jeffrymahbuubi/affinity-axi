#!/bin/sh
# Batch a post series: Run one template over every record in a data file, saving and closing each document
affinity-axi batch examples/batch/script.js --data examples/batch/data.json --key slug --with-helpers --save-dir examples/batch/af --limit 2
