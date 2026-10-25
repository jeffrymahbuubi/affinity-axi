// Round 5 examples (transparent documents, ML helpers, ML in fill). Same
// conventions as registry-core.ts.

import type { Example } from "./types.js";
import { RUN_ARGS, RUN_OK } from "./registry-core.js";

export const ROUND5_EXAMPLES: readonly Example[] = [
  {
    id: "doc-new-transparent",
    feature: "doc new",
    title: "Create a transparent document",
    summary: "Create a document with a transparent background, so PNG exports keep alpha (cut-outs, stickers, logos)",
    commands: ["$BIN doc new --width 800 --height 600 --transparent"],
    output: ["doc: <uuid>", "size: 800x600 px @ 72 dpi", "transparent: true"],
    images: [],
    needs: ["affinity"],
  },
  {
    id: "helpers-ml",
    feature: "helpers:ml",
    title: "Helpers: ML cut-outs, depth and colourise",
    summary: "Cut a product out of its photo and fit it in its box, make a depth map that keeps the photo, blur a background by depth, and colourise an old greyscale photo",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN render $DOC --out $OUT/render.jpg"],
    script: "script.js",
    output: RUN_OK,
    images: ["render.jpg"],
    needs: ["affinity", "document"],
  },
  {
    id: "fill-ml",
    feature: "fill",
    title: "Fill a template with a cut-out photo",
    summary: "A picture slot takes cutout, colourise and align: ML runs on the placed photo, about 10 s each; the cut-out is centred in its frame",
    commands: [
      `$BIN run $OUT/template.js --with-helpers ${RUN_ARGS}`,
      "$BIN doc save $DOC $OUT/template.af",
      "$BIN doc close $DOC",
      "$BIN fill $OUT/template.af --data $OUT/posts.json --key slug --out-dir $OUT --export PNG",
    ],
    script: "template.js",
    output: ["records[1]{key,status,doc,ms,note}:", "exported: 1"],
    images: ["mug.png"],
    needs: ["affinity", "document"],
  },
];
