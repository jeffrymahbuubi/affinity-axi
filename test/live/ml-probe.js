// Live probe of the U2 ML helpers (transparent cut-out, safe depth, selection
// cleared). Run with --with-helpers --args '{"photo":"<abs path to mug.jpg>"}'.
// Never closes the document. The lead then exports the document by UUID and
// checks the alpha with sips -g hasAlpha, and reads the depth-of-field API:
//   docs read commands.js --grep -i "depthoffield"
//   docs read nodes.js --grep -i "depthoffield|mask"
// Step 3 checks axiDepthBlur (the lead exports the document and looks at 'photo3').
// Step 4 checks axiCutout align:'centre' inside a picture frame (see out.align).
// Prints one JSON line with timings, selection state, layer tree and pixel stats.
const { NodeRenderingEngine, RasterFormat } = require('/rasterobject.js');
const { PixelReaderRGBA8 } = require('/pixelaccessor.js');

const safe = (f, d) => { try { return f(); } catch (e) { return d; } };
const typeOf = (n) => String(safe(() => n[Symbol.toStringTag], 'Unknown')).replace(/Node$/, '');

function tree(doc) {
  const rows = [];
  const walk = (n, depth) => {
    for (const c of safe(() => Array.from(n.children), [])) {
      rows.push({ depth: depth, type: typeOf(c), name: safe(() => c.userDescription, ''), visible: safe(() => c.isVisible, true) });
      walk(c, depth + 1);
    }
  };
  for (const s of doc.spreads) { walk(s, 1); }
  return rows;
}

// Stats over a 40x40 grid: transparent share, mean saturation.
function stats(node) {
  return safe(() => {
    const bm = NodeRenderingEngine.createDefault(node, RasterFormat.RGBA8).createCompatibleBitmap(true);
    const rd = PixelReaderRGBA8.create(bm);
    let clear = 0, sat = 0, n = 0;
    const G = 40;
    for (let i = 0; i < G; i += 1) {
      for (let j = 0; j < G; j += 1) {
        const p = rd.readPixel(Math.floor((i + 0.5) * bm.width / G), Math.floor((j + 0.5) * bm.height / G));
        if (p.alpha < 128) { clear += 1; }
        const mx = Math.max(p.r, p.g, p.b), mn = Math.min(p.r, p.g, p.b);
        sat += mx === 0 ? 0 : (mx - mn) / mx;
        n += 1;
      }
    }
    return { size: bm.width + 'x' + bm.height, clearPct: Math.round(100 * clear / n), meanSat: +(sat / n).toFixed(3) };
  }, 'unreadable');
}

if (!ARGS.photo) { throw new Error('pass --args with photo: the absolute path of the test photo'); }
const out = {};
const doc = axiDoc(960, 640, 72, { transparent: true });
out.uuid = String(doc.sessionUuid);

// (1) transparent cut-out via the subject route; the pixel selection must be clear afterwards.
let t0 = Date.now();
const img = axiImage(doc, { path: ARGS.photo, x: 0, y: 0, w: 960, h: 640, name: 'photo' });
const cut = axiCutout(doc, img, { method: 'subject' });
out.cutout = { ms: Date.now() - t0, isSelectNone: safe(() => doc.rasterSelection.isSelectNone, 'n/a'), pixels: stats(cut) };

// (2) safe depth on a second copy of the photo: original stays colour, copy is grey and hidden.
t0 = Date.now();
const img2 = axiImage(doc, { path: ARGS.photo, x: 0, y: 0, w: 960, h: 640, name: 'photo2' });
const copy = axiDetectDepth(doc, img2);
out.depth = {
  ms: Date.now() - t0,
  copyName: safe(() => copy.userDescription, '?'),
  copyHidden: safe(() => !copy.isVisible, '?'),
  originalPixels: stats(img2),
  copyPixels: stats(copy),
};
// (3) depth-driven blur on a third copy: far part blurred in place, depth copy hidden,
// pixel selection cleared. Compare sharp-vs-blurred areas by eye on the export.
t0 = Date.now();
const img3 = axiImage(doc, { path: ARGS.photo, x: 0, y: 0, w: 960, h: 640, name: 'photo3' });
const blurred = axiDepthBlur(doc, img3, undefined, { radius: 14 });
out.depthBlur = {
  ms: Date.now() - t0,
  depthName: safe(() => blurred.depth.userDescription, '?'),
  depthHidden: safe(() => !blurred.depth.isVisible, '?'),
  isSelectNone: safe(() => doc.rasterSelection.isSelectNone, 'n/a'),
  photoPixels: stats(blurred.photo),
};
// (4) re-centre a cut-out in its picture frame (A1: the layer box shrinks to the subject,
// A2: the transform keeps it inside the frame). fit 'cover' makes the frame 'photo4-frame'
// (600x400 at 100,100, centre 400,300). A1 holds when 'after' is about 306x308 (not
// 600x400) and 'after' is centred on the frame centre within 2 px. Never uses rasterWidth/Height
// as the content box: they stay at the document size.
t0 = Date.now();
const img4 = axiImage(doc, { path: ARGS.photo, x: 100, y: 100, w: 600, h: 400, fit: 'cover', name: 'photo4' });
const before4 = axiContentBox(doc, img4);
const raster4 = img4.rasterWidth + 'x' + img4.rasterHeight;
axiCutout(doc, img4, { align: 'centre', transparent: false });
const after4 = axiContentBox(doc, img4);
out.align = {
  before: before4,
  beforeRaster: raster4,
  after: after4,
  raster: safe(() => img4.rasterWidth + 'x' + img4.rasterHeight, '?'),
  bitmap: stats(img4).size,
  frame: safe(() => axiContentBox(doc, img4.parent), '?'),
  centreOffset: { dx: +(after4.x + after4.w / 2 - 400).toFixed(1), dy: +(after4.y + after4.h / 2 - 300).toFixed(1) },
  ms: Date.now() - t0,
};
out.tree = tree(doc);
console.log(JSON.stringify(out, null, 1));
