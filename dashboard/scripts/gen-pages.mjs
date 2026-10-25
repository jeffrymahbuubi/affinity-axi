// gen:pages - turns the examples gallery, the captured --help texts and the README into Starlight pages.
// Usage: node scripts/gen-pages.mjs   (run by predev, prebuild and check; all output is git-ignored)
//   <gallery>/<id>/            -> src/content/docs/examples/<id>.md   + public/examples/<id>/<images>
//   <gallery>/_help/<cmd>.txt  -> src/content/docs/commands/<cmd>.md  (plus the examples of that command)
//   helpers:* and helpers      -> src/content/docs/helpers/*.md
//   platforms                  -> src/content/docs/platforms/index.md
//   examples by feature family -> src/content/docs/features/<family>.md + features/index.md (scripts/lib/families.mjs)
//   ../README.md               -> src/content/docs/about/overview.md
//   src/generated/manifest.json lists what was written, for scripts/check-dashboard.mjs.
// Gallery folder: $AXI_GALLERY, else "gallery" in dashboard.config.json, else the bundled fixture gallery.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandSlug, groupOf, readExamples, readHelp } from './lib/gallery.mjs';
import { groupByFamily } from './lib/families.mjs';
import { aboutPage, commandPage, commandsIndex, examplePage, examplesIndex, featurePage, featuresIndex, helperFamily, helpersIndex, platformsIndex } from './lib/pages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'dashboard.config.json'), 'utf8'));
const docsOut = path.join(root, 'src', 'content', 'docs');
const GROUPS = ['commands', 'examples', 'helpers', 'platforms', 'features', 'about'];
const warn = (msg) => console.warn(`gen-pages: warning: ${msg}`);

function pickGallery() {
  if (process.env.AXI_GALLERY) return { dir: path.resolve(root, process.env.AXI_GALLERY), fixture: /fixtures/.test(process.env.AXI_GALLERY) };
  const primary = path.resolve(root, config.gallery);
  if (fs.existsSync(primary)) return { dir: primary, fixture: false };
  warn(`gallery ${config.gallery} not found; building from the bundled fixture gallery`);
  return { dir: path.resolve(root, config.fallbackGallery), fixture: true };
}

const gallery = pickGallery();
if (!fs.existsSync(gallery.dir)) {
  console.error(`gen-pages: gallery folder ${gallery.dir} not found`);
  process.exit(2);
}
const { examples, problems } = readExamples(gallery.dir);
for (const p of problems) warn(p);
const help = readHelp(gallery.dir);

for (const g of GROUPS) fs.rmSync(path.join(docsOut, g), { recursive: true, force: true });
fs.rmSync(path.join(root, 'public', 'examples'), { recursive: true, force: true });
fs.rmSync(path.join(root, 'src', 'generated'), { recursive: true, force: true });

const written = [];
const write = (rel, text) => {
  const file = path.join(docsOut, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  written.push(rel);
};

// Examples group, with images copied to public/.
for (const ex of examples) {
  write(`examples/${ex.id}.md`, examplePage(ex, groupOf(ex) === 'helpers' ? 'helper' : groupOf(ex) === 'platforms' ? 'platform' : 'example'));
  for (const f of ex.images.filter((n) => !ex.missingImages.includes(n))) {
    const target = path.join(root, 'public', 'examples', ex.id, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ex.dir, f), target);
  }
}
if (examples.length) write('examples/index.md', examplesIndex(examples));

// Commands group: every help file, plus any command that has an example but no help file.
const commandExamples = (name) => examples.filter((e) => groupOf(e) === 'commands' && commandSlug(e.feature) === name);
const names = [...new Set([...Object.keys(help), ...examples.filter((e) => groupOf(e) === 'commands').map((e) => commandSlug(e.feature))])].sort();
const rows = [];
for (const name of names) {
  const exs = commandExamples(name);
  write(`commands/${name}.md`, commandPage(name, help[name] ?? null, exs));
  rows.push({ name, title: name.replace(/-/g, ' '), summary: exs[0]?.summary ?? '', examples: exs });
}
if (rows.length) write('commands/index.md', commandsIndex(rows));

// Helpers group.
const helperExamples = examples.filter((e) => groupOf(e) === 'helpers');
const families = helperExamples.filter((e) => helperFamily(e)).map((e) => ({ family: helperFamily(e), summary: e.summary, ex: e }));
const directHelpers = helperExamples.filter((e) => !helperFamily(e));
if (families.length || directHelpers.length || help.helpers) {
  write('helpers/index.md', helpersIndex(help.helpers ?? null, directHelpers, families));
  for (const f of families) write(`helpers/${f.family}.md`, examplePage(f.ex, 'helper'));
}

// Platforms group.
const platformExamples = examples.filter((e) => groupOf(e) === 'platforms');
if (platformExamples.length || help.platforms) write('platforms/index.md', platformsIndex(help.platforms ?? null, platformExamples));

// Features group: one page per family that has examples; an example in no family lands in Other.
const { groups: featureGroups, unmatched } = groupByFamily(examples);
if (unmatched.length) warn(`no feature family for: ${unmatched.join(', ')} (add the feature to scripts/lib/families.mjs); they are listed under Other`);
if (featureGroups.length) {
  write('features/index.md', featuresIndex(featureGroups));
  featureGroups.forEach(({ family, examples: exs }, i) => write(`features/${family.id}.md`, featurePage(family, exs, i + 1)));
}

// README as the About page.
const readmePath = path.resolve(root, config.readme);
if (fs.existsSync(readmePath)) write('about/overview.md', aboutPage(fs.readFileSync(readmePath, 'utf8')));
else warn(`${config.readme} not found; no About page`);

fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
fs.writeFileSync(
  path.join(root, 'src', 'generated', 'manifest.json'),
  `${JSON.stringify({ gallery: path.relative(root, gallery.dir), fixture: gallery.fixture, pages: written, examples: examples.map((e) => ({ id: e.id, images: e.images, missingImages: e.missingImages })), commands: names, families: featureGroups.map((g) => ({ id: g.family.id, examples: g.examples.map((e) => e.id) })) }, null, 2)}\n`,
);
console.log(
  `gen-pages: ${written.length} pages from ${path.relative(root, gallery.dir)}${gallery.fixture ? ' (fixture gallery)' : ''}: ` +
    `${examples.length} examples, ${names.length} commands, ${families.length} helper families, ${platformExamples.length} platform examples, ${featureGroups.length} feature pages`,
);
