#!/bin/sh
# Build a template and fill it: Build the ig-post template on a brand kit, save it as .af, then fill it from two records and export PNGs
# The generator adds out=<this folder, absolute> to --args so the script can find files next to it.
affinity-axi templates new ig-post --out examples/templates-new/ig-post.af --brand examples/_brand/brand.json --args '{"photo":"examples/templates-new/photo.png"}'
affinity-axi fill examples/templates-new/ig-post.af --data examples/templates-new/posts.json --key slug --out-dir examples/templates-new --export PNG
