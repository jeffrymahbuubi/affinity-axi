// Brand-kit helpers for run --with-helpers --brand <kit>. Same rules as
// helpers-core.ts (function declarations prefixed axi, requires inside
// functions, nothing blocking or generative, String.raw so no backticks,
// dollar-brace or backslash surprises).
//
// The CLI prepends `const AXI_BRAND = {...};` to the script (brand.ts), with
// logo paths already absolute. These helpers only look that value up: there is
// no SDK call here beyond what axiText and axiImage already do. Validation
// runs before either is called.

import type { HelperInfo } from "./helpers-core.js";

export const BRAND_INDEX: readonly HelperInfo[] = [
  {
    name: "axiBrand",
    signature: "axiBrand()",
    summary: "the brand kit given with --brand (a deep copy: colours, fonts, type, space, radius, logo); throws 'axiBrand: no brand kit; run with --brand <kit>' when the run had none",
  },
  {
    name: "axiToken",
    signature: "axiToken(path)",
    summary: "one value from the brand kit by dotted path: colours.ink, fonts.headline, type.h1, space.3 (index), radius.md, logo.mark. On a miss it throws with the keys available at the failing level. Kits are per project: never hard-code a client's colours in a script",
  },
  {
    name: "axiType",
    signature: "axiType(doc, key, {x,y,text,colour,align,maxW,name})",
    summary: "one text line in the kit's type style key (font role resolved through fonts, size and spacing from the style); y is the baseline; colour is a hex or a kit colour key (default the kit's first colour); returns the node",
  },
  {
    name: "axiLogo",
    signature: "axiLogo(doc, {variant,x,y,w,h,name})",
    summary: "place the kit's logo.<variant> (default 'primary', a PNG or JPEG) inside the box x,y,w,h with axiImage fit contain; returns the image node",
  },
];

/** Internal building blocks, not in the index. */
export const BRAND_INTERNAL: readonly string[] = [];

export const BRAND_SOURCE: string = String.raw`
/* ---- brand-kit helpers ---- */

// The kit the CLI injected as AXI_BRAND, as a deep copy.
function axiBrand() {
  if (typeof AXI_BRAND === 'undefined' || !AXI_BRAND) { throw new Error('axiBrand: no brand kit; run with --brand <kit>'); }
  return JSON.parse(JSON.stringify(AXI_BRAND));
}

// A value by dotted path ('colours.ink', 'space.3'). A miss lists the keys at the failing level.
function axiToken(path) {
  if (typeof path !== 'string' || path === '') { throw new Error('axiToken: path must be a dotted string such as colours.ink'); }
  let cur = axiBrand();
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    const isGroup = cur !== null && typeof cur === 'object';
    if (!isGroup || !Object.prototype.hasOwnProperty.call(cur, parts[i])) {
      const upTo = parts.slice(0, i).join('.');
      const have = isGroup ? Object.keys(cur).join(', ') : '(' + upTo + ' is a value, not a group)';
      throw new Error('axiToken: no ' + path + '; have ' + have);
    }
    cur = cur[parts[i]];
  }
  return cur;
}

// One text line in the type style key of the kit.
function axiType(doc, key, o) {
  o = o || {};
  if (typeof key !== 'string' || key === '') { throw new Error('axiType: key must name a type style (type.<key> in the kit)'); }
  if (typeof o.x !== 'number' || typeof o.y !== 'number') { throw new Error('axiType: x and y are required numbers'); }
  if (typeof o.text !== 'string' || o.text === '') { throw new Error('axiType: text is required'); }
  const kit = axiBrand();
  const style = axiToken('type.' + key);
  const font = kit.fonts[style.font];
  if (!font) { throw new Error('axiType: type.' + key + '.font ' + style.font + ' is not in fonts; have ' + Object.keys(kit.fonts).join(', ')); }
  let colour = o.colour;
  if (colour === undefined) { colour = kit.colours[Object.keys(kit.colours)[0]]; }
  else if (typeof colour === 'string' && Object.prototype.hasOwnProperty.call(kit.colours, colour)) { colour = kit.colours[colour]; }
  return axiText(doc, { x: o.x, y: o.y, text: o.text, font: font, size: style.size, colour: colour, spacing: style.spacing, align: o.align, maxW: o.maxW, name: o.name });
}

// The kit's logo.<variant> placed inside the box with fit contain.
function axiLogo(doc, o) {
  o = o || {};
  const variant = o.variant === undefined ? 'primary' : o.variant;
  if (typeof variant !== 'string' || variant === '') { throw new Error('axiLogo: variant must be a logo key such as primary or mark'); }
  for (const k of ['x', 'y', 'w', 'h']) {
    if (typeof o[k] !== 'number' || !isFinite(o[k])) { throw new Error('axiLogo: ' + k + ' is required (a number)'); }
  }
  if (o.w <= 0 || o.h <= 0) { throw new Error('axiLogo: w and h must be positive'); }
  const kit = axiBrand();
  if (!kit.logo) { throw new Error('axiLogo: the brand kit has no logo; add logo.' + variant + ' (a PNG or JPEG) to the kit'); }
  const path = axiToken('logo.' + variant);
  return axiImage(doc, { path: path, x: o.x, y: o.y, w: o.w, h: o.h, fit: 'contain', name: o.name });
}
`;
