// Lumen Studio demo for the brand-kit helpers: an ink card whose headline, body
// line, pill and spacing all come from the kit given with --brand, not from
// constants in the script. Run with --with-helpers --brand
// examples/_brand/brand.json; the document is found by the uuid in --args.
// Without --brand the first axiToken call throws 'axiBrand: no brand kit'.
const { Document } = require('/document.js');
const want = String(ARGS.uuid).toUpperCase();
const doc = Document.all.find((d) => String(d.sessionUuid).toUpperCase().startsWith(want));
if (!doc) { throw new Error('demo document not found: ' + want); }

const pad = axiToken('space.4');    // 24 px from the kit's spacing scale
const pill = axiToken('radius.pill');

axiOn(doc, 'ig-square');
axiRect(doc, { x: 0, y: 0, w: 1080, h: 1080, fill: axiToken('colours.ink'), name: 'card' });

// The headline uses the kit's display style; colour names a kit colour.
axiType(doc, 'display', { x: pad * 3, y: 420, text: 'Light, measured', colour: 'mist', name: 'headline' });

// A body line in the sky colour, in the body font.
axiText(doc, { x: pad * 3, y: 520, text: 'Studio hours for people who like exact exposure', font: axiToken('fonts.body'), size: axiToken('type.body.size'), colour: axiToken('colours.sky'), name: 'body' });

// A pill: a rounded sun-coloured bar with the label centred inside it.
axiRect(doc, { x: pad * 3, y: 600, w: 360, h: 80, fill: axiToken('colours.sun'), radius: pill, name: 'pill' });
axiType(doc, 'body', { x: pad * 3 + 180, y: 653, text: 'Book a slot', colour: 'ink', align: 'c', name: 'pill-label' });

console.log(JSON.stringify({ brand: axiBrand().name, tokens: ['colours.ink', 'fonts.headline'] }));
