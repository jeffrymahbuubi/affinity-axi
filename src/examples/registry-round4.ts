// Round 4 examples (platform sizes, alt text, lint, export size budgets). Same
// conventions as registry-core.ts.

import type { Example } from "./types.js";
import { RUN_ARGS, RUN_OK } from "./registry-core.js";

export const ROUND4_EXAMPLES: readonly Example[] = [
  {
    id: "platforms-ads",
    feature: "platforms",
    title: "Google Display ad sizes",
    summary: "The seven standard display ad sizes with their 150 KB limit",
    commands: ['$BIN platforms --grep "^ad-"'],
    output: [
      "platforms[7 of 44 total]{key,size,ratio,safe,notes}:",
      "  ad-300x250,300x250,6:5,-,Google Display medium rectangle; 150 KB max; export --max-kb 150",
    ],
    images: [],
    needs: [],
  },
  {
    id: "lint",
    feature: "lint",
    title: "Design checks",
    summary: "Contrast, safe zones, small text, slot names and off-kit colours, as a table with severities",
    commands: [
      `$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`,
      "$BIN lint $DOC --brand examples/_brand/brand.json",
      "$BIN render $DOC --out $OUT/render.jpg",
    ],
    script: "script.js",
    output: [...RUN_OK, "doc: <uuid>", "lint[2]{severity,check,node,detail}:", "summary: 0 errors, 2 warnings"],
    images: ["render.jpg"],
    needs: ["affinity", "document"],
  },
  {
    id: "export-budget",
    feature: "export",
    title: "Export under a file-size budget",
    summary: "Step JPEG, WebP or PNG presets and then size until the file fits --max-kb",
    commands: ['$BIN export $DOC "JPEG (High quality)" $OUT/ad.jpg --artboard ig-square --max-kb 40'],
    output: ["doc: <uuid>", "preset: JPEG (High quality)", "artboard: ig-square", "budget_kb: 40"],
    images: ["ad.jpg"],
    needs: ["affinity", "document"],
  },
  {
    id: "export-alt",
    feature: "export",
    title: "Alt-text stub on export",
    summary: "Every exported image prints an alt-text stub built from the document's text, top-down",
    commands: [`$BIN run $OUT/script.js --with-helpers ${RUN_ARGS}`, "$BIN export $DOC PNG $OUT/card.png --artboard ig-square"],
    script: "script.js",
    output: ["doc: <uuid>", "preset: PNG", "artboard: ig-square", "alt: Light, measured. Studio hours"],
    images: ["card.png"],
    needs: ["affinity", "document"],
  },
];
