// Icon helpers for run --with-helpers: transparent app-icon documents with the
// layer boards and safe-zone guides of the Android adaptive and PWA maskable
// presets, and the cleanup of the overlays they (and axiSafeZone) draw. Same
// rules as helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks,
// dollar-brace or backslash surprises).
//
// Numbers: Android adaptive layers are 108 dp with a 72 dp viewport and a
// 66 dp safe circle (so unit u = size / 108, circle radius 33 u); a PWA
// maskable icon keeps its content inside a circle of 0.4 * size radius.

import type { HelperInfo } from "./helpers-core.js";

export const ICONS_INDEX: readonly HelperInfo[] = [
  { name: "axiIconDoc", signature: "axiIconDoc(preset, {size, legacy, shortcut, fill, overlay})", summary: "new transparent app-icon document (72 dpi, 1 unit = 1 px) with boards in a row and safe-zone guides; preset android-adaptive: boards foreground, background, monochrome (size default 432, a whole number of at least 108; legacy:true adds legacy and legacy-round at size*48/108), safe circle 66/108 of the side plus the 72/108 viewport square; preset pwa-maskable: boards maskable and icon (size default 512, at least 96; shortcut:true adds a shortcut board at size*96/512), safe circle 0.8 of the side on maskable; fill (hex) fills background (android) or maskable and icon (pwa); overlay:true also draws red stroke-only outlines named axi-safe-zone; returns {doc, uuid, preset, boards:[{name,x,y,w,h,safe}]} with safe {cx,cy,r} in px or null, the first board selected; export with `export --all-artboards --densities mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi --base 108` and delete overlays with axiSafeZoneClear before export" },
  { name: "axiSafeZoneClear", signature: "axiSafeZoneClear(doc)", summary: "delete every node named axi-safe-zone (the overlays of axiIconDoc and the bands of axiSafeZone, unlocking locked ones); returns the number deleted, 0 on a clean document; run it before export" },
];

/** Internal building blocks, not in the index. */
export const ICONS_INTERNAL: readonly string[] = [];

export const ICONS_SOURCE: string = String.raw`
/* ---- icon helpers ---- */

// New transparent app-icon document for a preset. See the index for the boards.
// Guides (after axiOn, as axiSafeZone does): the four tangents of each safe
// circle and, for android, the four edges of the 72 dp viewport. Returns
// {doc, uuid, preset, boards: [{name,x,y,w,h,safe}]}; the first board is selected.
function axiIconDoc(preset, o) {
  const opts = o || {};
  if (preset !== 'android-adaptive' && preset !== 'pwa-maskable') {
    throw new Error('axiIconDoc: unknown preset ' + String(preset) + '; use android-adaptive or pwa-maskable');
  }
  const android = preset === 'android-adaptive';
  const min = android ? 108 : 96;
  const size = opts.size === undefined ? (android ? 432 : 512) : opts.size;
  if (typeof size !== 'number' || !isFinite(size) || Math.floor(size) !== size || size < min) {
    throw new Error('axiIconDoc: size must be a whole number of at least ' + min);
  }
  const specs = [];
  const safeR = {};
  if (android) {
    specs.push({ name: 'foreground', w: size, h: size }, { name: 'background', w: size, h: size, fill: opts.fill }, { name: 'monochrome', w: size, h: size });
    safeR.foreground = 33 * size / 108; safeR.background = safeR.foreground; safeR.monochrome = safeR.foreground;
    if (opts.legacy === true) {
      const side = Math.round(size * 48 / 108);
      specs.push({ name: 'legacy', w: side, h: side }, { name: 'legacy-round', w: side, h: side });
    }
  } else {
    specs.push({ name: 'maskable', w: size, h: size, fill: opts.fill }, { name: 'icon', w: size, h: size, fill: opts.fill });
    safeR.maskable = 0.4 * size;
    if (opts.shortcut === true) {
      const side = Math.round(size * 96 / 512);
      specs.push({ name: 'shortcut', w: side, h: side });
    }
  }
  const doc = axiDoc(size, size, 72, { transparent: true });
  const boards = axiArtboards(doc, specs).map(function (b) {
    const r = safeR[b.name];
    b.safe = r === undefined ? null : { cx: b.x + b.w / 2, cy: b.y + b.h / 2, r: r };
    return b;
  });
  const u = size / 108;
  const sw = Math.max(1, Math.round(size / 216));
  boards.forEach(function (b) {
    if (!b.safe) { return; }
    const s = b.safe;
    axiOn(doc, b.name);
    doc.addGuide(true, s.cy - s.r);
    doc.addGuide(true, s.cy + s.r);
    doc.addGuide(false, s.cx - s.r);
    doc.addGuide(false, s.cx + s.r);
    if (android) {
      doc.addGuide(true, s.cy - 36 * u);
      doc.addGuide(true, s.cy + 36 * u);
      doc.addGuide(false, s.cx - 36 * u);
      doc.addGuide(false, s.cx + 36 * u);
    }
    if (opts.overlay === true) {
      axiEllipse(doc, { x: s.cx - s.r + sw / 2, y: s.cy - s.r + sw / 2, w: 2 * s.r - sw, h: 2 * s.r - sw, stroke: '#ff0000', strokeWidth: sw, name: 'axi-safe-zone' });
      if (android) {
        axiOn(doc, b.name);
        axiRect(doc, { x: s.cx - 36 * u, y: s.cy - 36 * u, w: 72 * u, h: 72 * u, stroke: '#ff0000', strokeWidth: sw, name: 'axi-safe-zone' });
      }
    }
  });
  axiOn(doc, boards[0].name);
  return { doc: doc, uuid: String(doc.sessionUuid), preset: preset, boards: boards };
}

// Delete every node named axi-safe-zone, locked ones included. Returns the count.
function axiSafeZoneClear(doc) {
  const nodes = axiFindAll(doc, 'axi-safe-zone');
  nodes.forEach(function (n) {
    const back = axiOnSpread(doc, n);
    try {
      if (n.isLocked) { n.unlock(); }
      doc.deleteSelection(n);
    } finally { back(); }
  });
  return nodes.length;
}
`;
