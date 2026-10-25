// Words that must not appear in dashboard sources, and the demo-brand colours an earlier client palette must not
// leak into. The lists are spelled in pieces so this file does not trip the scan it provides.
// Hand-written files are errors; generated pages are checked too but only warn, because they mirror
// the tool README and the gallery, which other units own.

const join = (parts) => parts.join('');

const TERM_PARTS = [
  ['cla', 'ude'],
  ['anthr', 'opic'],
  ['l', 'lm'],
  ['g', 'pt'],
  ['open', 'ai'],
  ['o', 'pus'],
  ['son', 'net'],
  ['hai', 'ku'],
  ['fa', 'ble'],
  ['ru', 'flo'],
  ['co-auth', 'ored'],
  ['ko', 'st'],
  ['pulo', 'sari'],
];
const PALETTE_PARTS = [
  ['B55', '53A'],
  ['6F8', 'F7A'],
  ['E0A', '84A'],
];

export const TERMS = TERM_PARTS.map(join);
export const PALETTE = PALETTE_PARTS.map(join);
const PERSONAL_PATH = join(['/Us', 'ers/']);

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const PATTERN = new RegExp([...TERMS, ...PALETTE, PERSONAL_PATH].map((t) => t.replace(ESCAPE, '\\$&')).join('|'), 'i');

/** The first forbidden term found in a text, with its 1-based line, or null. */
export function findTerm(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = PATTERN.exec(lines[i]);
    if (m) return { term: m[0], line: i + 1 };
  }
  return null;
}
