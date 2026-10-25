// Lumen Studio demo for the ML helpers: a cut-out, a depth map, a depth blur and a
// colourised strip. Run with --with-helpers; the document is found by the uuid in --args and
// the folder of this script arrives as ARGS.out. The photos live in the shared
// examples/_photos folder next to the example folders (inputs stay outside this
// folder). ML runs on-device and takes about 10 s per call.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }
if (!ARGS.out) { throw new Error('ARGS.out (this example folder) is missing; pass it in --args'); }
const mug = ARGS.out + '/../_photos/mug.jpg';
const street = ARGS.out + '/../_photos/street-1930s.jpg';

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: '#E4EAF1', name: 'bg' });

// Left: the mug with its background removed, then fitted to its 480x480 placement.
// There is no picture frame here, so align uses the layer's box before the cut (the
// contain placement) as the target; inside a frame it would use the frame instead.
// transparent:false keeps the shared demo document opaque; a standalone sticker
// would leave it at the default (true).
const cut = axiImage(doc, { path: mug, x: 50, y: 110, w: 480, h: 480, name: 'mug-cutout' });
axiCutout(doc, cut, { transparent: false, align: 'fit', padding: 10 });

// Right: the same photo with its depth map shown (near = white). By default the
// map is made on a hidden copy and the photo is kept; visible:true shows the copy.
const depthSrc = axiImage(doc, { path: mug, x: 550, y: 110, w: 480, h: 480, name: 'mug' });
axiDetectDepth(doc, depthSrc, { visible: true });

// Below: an old black-and-white street photo, colourised.
const old = axiImage(doc, { path: street, x: 50, y: 640, w: 700, h: 300, name: 'street' });
axiColourise(doc, old);

// Bottom right: depth-driven blur. axiDepthBlur makes the hidden depth copy
// itself and blurs the far part of this layer in place (destructive on its pixels).
const blur = axiImage(doc, { path: mug, x: 770, y: 640, w: 260, h: 260, name: 'mug-blur' });
axiDepthBlur(doc, blur, undefined, { radius: 14 });
axiText(doc, { x: 770, y: 920, text: 'depth blur', font: 'Helvetica-Bold', size: 28, colour: '#1F2A44', name: 'blur-label' });

axiText(doc, { x: 50, y: 1010, text: 'Cut-out, depth map, depth blur, colourised', font: 'Helvetica-Bold', size: 44, colour: '#1F2A44', name: 'caption' });
console.log('RUN_OK');
