// Round 3 examples (templates, multi-series charts, print, patterns). Same
// conventions as registry-core.ts.

import type { Example } from "./types.js";
import { RUN_ARGS, RUN_OK } from "./registry-core.js";

export const ROUND3_EXAMPLES: readonly Example[] = [
  {
    id: "helpers-charts2",
    feature: "helpers:charts2",
    title: "Helpers: multi-series charts",
    summary: "Grouped and stacked bars, a line chart with dots and gridlines, and a legend from plain series",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN render $DOC --out $OUT/render.jpg"],
    script: "script.js",
    output: RUN_OK,
    images: ["render.jpg"],
    needs: ["affinity", "document"],
  },
  {
    id: "helpers-pattern",
    feature: "helpers:pattern",
    title: "Helpers: pattern tiles",
    summary: "A seamless background from a motif repeated over a clipped grid, with an optional half-drop",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN render $DOC --out $OUT/render.jpg"],
    script: "script.js",
    output: RUN_OK,
    images: ["render.jpg"],
    needs: ["affinity", "document"],
  },
  {
    id: "templates-list",
    feature: "templates list",
    title: "List the slot templates",
    summary: "Print the five ready-made templates with their sizes and fillable slots, offline",
    commands: ["$BIN templates list"],
    output: ["templates[5]{name,size,platform,slots}:", "  ig-post,1080x1080,ig-square,headline sub photo cta"],
    images: [],
    needs: [],
  },
  {
    id: "templates-new",
    feature: "templates new",
    title: "Build a template and fill it",
    summary: "Build the ig-post template on a brand kit, save it as .af, then fill it from two records and export PNGs",
    commands: [
      `$BIN templates new ig-post --out $OUT/ig-post.af --brand examples/_brand/brand.json --args '{"photo":"$OUT/photo.png"}'`,
      "$BIN fill $OUT/ig-post.af --data $OUT/posts.json --key slug --out-dir $OUT --export PNG",
    ],
    output: ["template: ig-post", "slots[4]: headline, sub, photo, cta", "records[2]{key,status,doc,ms,note}:", "exported: 2"],
    images: ["launch.png", "offer.png"],
    needs: ["affinity"],
  },
  {
    id: "print",
    feature: "print",
    title: "Print PDF with preflight",
    summary: "Export a press PDF (default PDF/X-4) and preflight it offline: boxes, bleed, colour, fonts",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN print $DOC --out $OUT/poster.pdf"],
    script: "script.js",
    output: ["preset: PDF/X-4", "  pdfx-version,ok,PDF/X-4", "  trim-box,ok,[0 0 1080 1080]"],
    images: [],
    needs: ["affinity", "document"],
  },
  {
    id: "helpers-print",
    feature: "helpers:print",
    title: "Helpers: print sheet and crop marks",
    summary: "A proof sheet with bleed, slug, eight locked crop marks and trim and bleed guides",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN render $DOC --out $OUT/render.jpg"],
    script: "script.js",
    output: RUN_OK,
    images: ["render.jpg"],
    needs: ["affinity", "document"],
  },
];
