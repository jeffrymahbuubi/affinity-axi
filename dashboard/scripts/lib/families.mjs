// Feature families: the dashboard-side table that groups gallery examples into the Features pages.
// An example's `feature` (example.json) is matched against each family's `features` entries:
//   "doc"        the command path and everything below it ("doc", "doc open", ...)
//   "helpers:"   a prefix (ends with a colon): every feature that starts with it
//   "export"     otherwise an exact match
// The most specific match wins (exact, then command path, then prefix); ties go to the first family.

export const FAMILIES = [
  {
    id: 'documents',
    label: 'Documents',
    lead: 'Create, open, save and inspect Affinity documents, and list the assets and notes inside them.',
    features: ['doc', 'inspect', 'assets'],
  },
  {
    id: 'scripts',
    label: 'Scripts and helpers',
    lead: 'Run your own script, batch several together, and use the axi helper functions that --with-helpers adds.',
    features: ['run', 'batch', 'helpers', 'helpers:'],
  },
  {
    id: 'fill-brand',
    label: 'Fill and brand',
    lead: 'Fill named slots from data, keep colours and fonts in a brand kit, and start from a template on that kit.',
    features: ['fill', 'brand', 'helpers:brand', 'templates'],
  },
  {
    id: 'export',
    label: 'Export',
    lead: 'Get pixels, bundles and print files out of a document: presets, web assets, previews and press PDFs.',
    features: ['export', 'presets', 'webassets', 'render', 'print', 'helpers:print'],
  },
  {
    id: 'sizes',
    label: 'Sizes and checks',
    lead: 'Look up platform sizes and safe zones, then lint a document against them.',
    features: ['platforms', 'lint'],
  },
  {
    id: 'charts',
    label: 'Charts, seals and tables',
    lead: 'Draw charts, seals, tables, QR codes and repeating patterns with one helper call each.',
    features: ['helpers:charts', 'helpers:charts2', 'helpers:seal', 'helpers:table', 'helpers:qr', 'helpers:pattern'],
  },
  {
    id: 'learning',
    label: 'Learning the SDK',
    lead: 'Read the SDK documentation, keep hints and library scripts, check fonts and see what the tool can do.',
    features: ['docs', 'hint', 'library', 'fonts', 'setup', 'examples', 'home'],
  },
];

export const OTHER = {
  id: 'other',
  label: 'Other',
  lead: 'Examples whose feature does not belong to a family yet. Add the feature to scripts/lib/families.mjs.',
  features: [],
};

/** How well `feature` matches one table entry: 3 exact, 2 command path, 1 prefix, 0 no match. */
function score(feature, entry) {
  if (feature === entry) return 3;
  if (entry.endsWith(':')) return feature.startsWith(entry) ? 1 : 0;
  return feature.startsWith(`${entry} `) ? 2 : 0;
}

/** The family for an example (or a feature string), or null when none matches. */
export function familyOf(example, families = FAMILIES) {
  const feature = typeof example === 'string' ? example : example.feature;
  let best = null;
  let bestScore = 0;
  for (const family of families) {
    for (const entry of family.features) {
      const s = score(feature, entry);
      if (s > bestScore) {
        best = family;
        bestScore = s;
      }
    }
  }
  return best;
}

/**
 * Split examples into families, in table order. Families without examples are left out.
 * Examples that match nothing go to a trailing `Other` entry and their ids to `unmatched`.
 */
export function groupByFamily(examples, families = FAMILIES) {
  const groups = families.map((family) => ({ family, examples: [] }));
  const other = { family: OTHER, examples: [] };
  for (const ex of examples) {
    const f = familyOf(ex, families);
    (f ? groups.find((g) => g.family === f) : other).examples.push(ex);
  }
  const used = groups.filter((g) => g.examples.length);
  if (other.examples.length) used.push(other);
  return { groups: used, unmatched: other.examples.map((e) => e.id) };
}
