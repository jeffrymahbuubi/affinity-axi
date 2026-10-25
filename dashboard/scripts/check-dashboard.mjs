// check-dashboard - structure, image, size and wording checks. Run last by `npm run check`, after the build.
// Exit: 0 clean, 1 errors, 2 usage or IO error.
//   every gallery example has a page and a built HTML page; every image it lists exists and was copied
//   every generated section of the gallery README.md has an example page, and every example page a section
//   every feature family in the manifest has a built page that links each of its examples; no example lands in Other
//   every command named in the manifest has a page; every image a page references exists under public/
//   frontmatter title present, description free of an unquoted ": ", no file over 500 lines
//   hand-written files carry none of the forbidden words (scripts/lib/terms.mjs); generated pages only warn
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReadme, readReadmeSections } from './lib/gallery.mjs';
import { parseFrontmatter } from './lib/markdown.mjs';
import { findTerm } from './lib/terms.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docsDir = path.join(root, 'src', 'content', 'docs');
const posix = (p) => p.split(path.sep).join('/');
const rel = (p) => posix(path.relative(root, p));
const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warnings.push(`${file}: ${msg}`);
const read = (p) => fs.readFileSync(p, 'utf8');

const manifestFile = path.join(root, 'src', 'generated', 'manifest.json');
if (!fs.existsSync(manifestFile)) {
  console.error('check-dashboard: run `npm run gen:pages` first');
  process.exit(2);
}
const manifest = JSON.parse(read(manifestFile));

function walk(dir, skip = () => false) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p, e)) continue;
    if (e.isDirectory()) out.push(...walk(p, skip));
    else out.push(p);
  }
  return out;
}

// ---- examples and commands ---------------------------------------------------
const built = (route) => fs.existsSync(path.join(root, 'dist', route, 'index.html'));
for (const ex of manifest.examples) {
  const page = path.join(docsDir, 'examples', `${ex.id}.md`);
  if (!fs.existsSync(page)) err(`examples/${ex.id}`, 'no generated page');
  else if (!built(`examples/${ex.id}`)) err(`examples/${ex.id}`, 'page not in dist/ (run the build before this check)');
  for (const f of ex.missingImages) err(`examples/${ex.id}`, `example.json lists ${f} but the file is not in the gallery folder`);
  for (const f of ex.images.filter((n) => !ex.missingImages.includes(n))) {
    if (!fs.existsSync(path.join(root, 'public', 'examples', ex.id, f))) err(`examples/${ex.id}`, `image ${f} was not copied to public/`);
  }
}
for (const name of manifest.commands) {
  if (!fs.existsSync(path.join(docsDir, 'commands', `${name}.md`))) err(`commands/${name}`, 'no generated page');
  else if (!built(`commands/${name}`)) err(`commands/${name}`, 'page not in dist/');
}
const familyIds = new Set((manifest.families ?? []).map((f) => f.id));
const featureIndex = path.join(docsDir, 'features', 'index.md');
if (!fs.existsSync(featureIndex)) err('features/index', 'no generated page');
else if (!built('features')) err('features/index', 'page not in dist/');
for (const fam of manifest.families ?? []) {
  const page = path.join(docsDir, 'features', `${fam.id}.md`);
  if (fam.id === 'other') err('features/other', `examples in no feature family: ${fam.examples.join(', ')} (add them to scripts/lib/families.mjs)`);
  if (!fs.existsSync(page)) err(`features/${fam.id}`, 'no generated page');
  else {
    if (!built(`features/${fam.id}`)) err(`features/${fam.id}`, 'page not in dist/');
    const text = read(page);
    for (const id of fam.examples) if (!text.includes(`](/examples/${id}/)`)) err(`features/${fam.id}`, `does not link example ${id}`);
  }
}
const inFamily = new Set((manifest.families ?? []).flatMap((f) => f.examples));
for (const ex of manifest.examples) if (!inFamily.has(ex.id)) err(`examples/${ex.id}`, 'in no feature family');
if (!manifest.families) err('manifest', 'no families (regenerate the pages)');
if (manifest.examples.length === 0) err('gallery', 'no examples found');
if (manifest.commands.length === 0) err('gallery', 'no commands found (is _help/ missing?)');

// ---- gallery README against the pages ---------------------------------------
const galleryDir = path.resolve(root, manifest.gallery);
if (!fs.existsSync(path.join(galleryDir, 'README.md'))) warn('gallery', 'no README.md to compare with the example pages');
else for (const m of compareReadme(readReadmeSections(galleryDir), manifest.examples.map((e) => e.id))) err('gallery/README.md', m);

// ---- pages -----------------------------------------------------------------
const IMG_REF = /(?:!\[[^\]]*\]\(|src=")(\/examples\/[^)"\s]+)/g;
const pageFiles = walk(docsDir, (p, e) => e.isFile() && !/\.mdx?$/.test(p));
for (const file of pageFiles) {
  const f = rel(file);
  const text = read(file);
  const { data } = parseFrontmatter(text);
  const generated = path.dirname(file) !== docsDir; // hand-written pages sit directly in src/content/docs
  if (!text.startsWith('---')) err(f, 'missing frontmatter');
  if (!data.title) err(f, 'frontmatter needs a title');
  const rawDesc = /^description:\s*(.*)$/m.exec(text)?.[1] ?? '';
  if (rawDesc && !/^["']/.test(rawDesc) && rawDesc.includes(': ')) err(f, 'description contains ": "; quote the whole string');
  if (text.split(/\r?\n/).length > 500) err(f, 'over 500 lines');
  for (const m of text.matchAll(IMG_REF)) {
    const target = path.join(root, 'public', decodeURI(m[1]));
    if (!fs.existsSync(target)) err(f, `image ${m[1]} not found under public/`);
  }
  const hit = findTerm(text);
  if (hit) (generated ? warn : err)(`${f}:${hit.line}`, `contains "${hit.term}"`);
}

// ---- hand-written sources ----------------------------------------------------
const TEXT = /\.(md|mdx|mjs|js|ts|json|css|txt|sh|astro)$/;
const generatedDirs = ['commands', 'examples', 'helpers', 'platforms', 'features', 'about'].map((d) => path.join(docsDir, d));
const skip = (p, e) =>
  ['node_modules', 'dist', '.astro', '.git'].includes(e.name) ||
  p === path.join(root, 'src', 'generated') ||
  p === path.join(root, 'public', 'examples') ||
  generatedDirs.includes(p) ||
  e.name === 'package-lock.json';
for (const file of walk(root, skip).filter((p) => TEXT.test(p))) {
  const f = rel(file);
  const text = read(file);
  const lines = text.split(/\r?\n/).length;
  if (lines > 500) err(f, `${lines} lines (limit 500)`);
  const hit = findTerm(text);
  if (hit) err(`${f}:${hit.line}`, `contains "${hit.term}"`);
}

// ---- report ------------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);
console.log(
  `check-dashboard: ${errors.length ? 'FAIL' : 'OK'} - ${pageFiles.length} pages, ${manifest.examples.length} examples, ` +
    `${manifest.commands.length} commands, ${familyIds.size} feature families, gallery ${manifest.gallery}${manifest.fixture ? ' (fixture)' : ''}, ${errors.length} errors, ${warnings.length} warnings`,
);
process.exitCode = errors.length ? 1 : 0;
