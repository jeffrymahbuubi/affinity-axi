// Reusable SDK helpers for scripts (run <file> --with-helpers). The block is
// plain JS for Affinity's script runtime, appended AFTER the user's script;
// function declarations hoist, so line numbers in errors still point at the
// user's file. It is the concatenation of:
//   helpers-core.ts    colour, document, fonts, text, shapes, measure
//   helpers-image.ts   image placement, replace, grade, looks, ML helpers
//   helpers-layout.ts  artboards, safe zones, text fitting
//   helpers-named.ts   find and edit elements by name, path or text
//   helpers-qr.ts      native QR codes with typed payloads
//   helpers-vector.ts  outline text, boolean ops for marks and favicons
//   helpers-table.ts   native tables from rows
//   helpers-variants.ts  multi-size boards from one master
//   helpers-carousel.ts  carousel boards, numbers, swipe cue, panorama split
//   helpers-charts.ts  bars, donut and progress charts
//   helpers-charts2.ts grouped and stacked bars, line charts, legends
//   helpers-seal.ts    arc text and promo seals
//   helpers-brand.ts   brand-kit tokens, type styles, logo
//   helpers-pattern.ts seamless pattern tiles
//   helpers-print.ts   print documents with bleed, proof sheets with crop marks
//   platforms.ts       axiPlatform(key), generated from the platform table

import { CORE_INDEX, CORE_SOURCE, type HelperInfo } from "./helpers-core.js";
import { IMAGE_INDEX, IMAGE_INTERNAL, IMAGE_SOURCE } from "./helpers-image.js";
import { LAYOUT_INDEX, LAYOUT_INTERNAL, LAYOUT_SOURCE } from "./helpers-layout.js";
import { NAMED_INDEX, NAMED_INTERNAL, NAMED_SOURCE } from "./helpers-named.js";
import { QR_INDEX, QR_INTERNAL, QR_SOURCE } from "./helpers-qr.js";
import { VECTOR_INDEX, VECTOR_INTERNAL, VECTOR_SOURCE } from "./helpers-vector.js";
import { TABLE_INDEX, TABLE_INTERNAL, TABLE_SOURCE } from "./helpers-table.js";
import { VARIANTS_INDEX, VARIANTS_INTERNAL, VARIANTS_SOURCE } from "./helpers-variants.js";
import { CAROUSEL_INDEX, CAROUSEL_INTERNAL, CAROUSEL_SOURCE } from "./helpers-carousel.js";
import { CHARTS_INDEX, CHARTS_INTERNAL, CHARTS_SOURCE } from "./helpers-charts.js";
import { CHARTS2_INDEX, CHARTS2_INTERNAL, CHARTS2_SOURCE } from "./helpers-charts2.js";
import { SEAL_INDEX, SEAL_INTERNAL, SEAL_SOURCE } from "./helpers-seal.js";
import { BRAND_INDEX, BRAND_INTERNAL, BRAND_SOURCE } from "./helpers-brand.js";
import { PATTERN_INDEX, PATTERN_INTERNAL, PATTERN_SOURCE } from "./helpers-pattern.js";
import { PRINT_INDEX, PRINT_INTERNAL, PRINT_SOURCE } from "./helpers-print.js";
import { platformHelperSource } from "./platforms.js";

export type { HelperInfo };

/** Public helpers. Internal building blocks (axiStyled, axiStroke, ...) are not listed. */
export const HELPER_INDEX: readonly HelperInfo[] = [...CORE_INDEX, ...IMAGE_INDEX, ...LAYOUT_INDEX, ...NAMED_INDEX, ...QR_INDEX, ...VECTOR_INDEX, ...TABLE_INDEX, ...VARIANTS_INDEX, ...CAROUSEL_INDEX, ...CHARTS_INDEX, ...CHARTS2_INDEX, ...SEAL_INDEX, ...BRAND_INDEX, ...PATTERN_INDEX, ...PRINT_INDEX];

/** Declared in HELPERS_SOURCE but deliberately absent from HELPER_INDEX. */
export const INTERNAL_HELPERS: readonly string[] = ["axiStyled", "axiStroke", "axiSurface", "axiName", ...IMAGE_INTERNAL, ...LAYOUT_INTERNAL, ...NAMED_INTERNAL, ...QR_INTERNAL, ...VECTOR_INTERNAL, ...TABLE_INTERNAL, ...VARIANTS_INTERNAL, ...CAROUSEL_INTERNAL, ...CHARTS_INTERNAL, ...CHARTS2_INTERNAL, ...SEAL_INTERNAL, ...BRAND_INTERNAL, ...PATTERN_INTERNAL, ...PRINT_INTERNAL];

export const HELPERS_SOURCE: string = CORE_SOURCE + IMAGE_SOURCE + LAYOUT_SOURCE + NAMED_SOURCE + QR_SOURCE + VECTOR_SOURCE + TABLE_SOURCE + VARIANTS_SOURCE + CAROUSEL_SOURCE + CHARTS_SOURCE + CHARTS2_SOURCE + SEAL_SOURCE + BRAND_SOURCE + PATTERN_SOURCE + PRINT_SOURCE + "\n" + platformHelperSource() + "\n";

/**
 * Appends the helpers AFTER the user's source. Function declarations hoist, so
 * the user's code can call them, and every line number in an error stack still
 * points at the user's file.
 */
export function withHelpers(source: string): string {
  const sep = source.endsWith("\n") ? "" : "\n";
  return source + sep + HELPERS_SOURCE;
}
