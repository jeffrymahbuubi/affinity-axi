// Unit tests for the page generator pieces, run against the bundled fixture gallery.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { commandSlug, compareReadme, groupOf, readExamples, readHelp, readReadmeSections } from './gallery.mjs';
import { escapeLine, fence, frontmatter, parseFrontmatter, slug } from './markdown.mjs';
import { FAMILIES, familyOf, groupByFamily } from './families.mjs';
import { aboutPage, commandPage, commandsIndex, examplePage, examplesIndex, featurePage, featuresIndex, helperFamily } from './pages.mjs';
import { findTerm } from './terms.mjs';

const gallery = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'gallery');
const { examples, problems } = readExamples(gallery);
const byId = (id) => examples.find((e) => e.id === id);

test('readExamples loads real folders and skips pending and underscore folders', () => {
  assert.deepEqual(examples.map((e) => e.id), ['brand-show', 'doc-open', 'fill', 'helpers-qr', 'helpers-text', 'hint-search', 'platforms', 'render', 'webassets']);
  assert.deepEqual(problems, []);
});

test('help files are keyed by command slug', () => {
  const help = readHelp(gallery);
  assert.ok(help['doc-open'].startsWith('usage: affinity-axi doc open'));
  assert.equal(commandSlug('doc open'), 'doc-open');
});

test('groups and helper families', () => {
  assert.equal(groupOf(byId('render')), 'commands');
  assert.equal(groupOf(byId('helpers-text')), 'helpers');
  assert.equal(groupOf(byId('platforms')), 'platforms');
  assert.equal(helperFamily(byId('helpers-text')), 'text');
  assert.equal(helperFamily(byId('render')), null);
});

test('frontmatter quotes values with colons and round-trips', () => {
  const text = frontmatter({ title: 'a: b', description: 'say "hi": now', empty: undefined });
  assert.equal(text.includes('description: "say \\"hi\\": now"'), true);
  assert.deepEqual(parseFrontmatter(`${text}body`).data, { title: 'a: b', description: 'say "hi": now' });
});

test('fence is longer than any backtick run in the text', () => {
  assert.equal(fence('plain').split('\n')[0], '```');
  assert.equal(fence('has ``` inside').split('\n')[0], '````');
  assert.equal(escapeLine('use <doc> and `<kept>`'), 'use &lt;doc> and `<kept>`');
  assert.equal(slug('Doc Open!'), 'doc-open');
});

test('example page carries commands, script, output and image links', () => {
  const page = examplePage(byId('helpers-text'), 'helper');
  assert.match(page, /^title: "Headline text with helpers"$/m);
  assert.match(page, /## Script/);
  assert.match(page, /## Output/);
  assert.match(page, /!\[headline\]\(\/examples\/helpers-text\/headline\.png\)/);
  assert.match(page, /Needs: `affinity`, `document`, `fonts`\./);
});

test('command page shows the help text and its examples', () => {
  const help = readHelp(gallery);
  const page = commandPage('render', help.render, examples.filter((e) => e.feature === 'render'));
  assert.match(page, /usage: affinity-axi render <doc>/);
  assert.match(page, /## Example: Preview the current spread/);
  assert.match(commandPage('inspect', null, []), /No example has been captured/);
});

test('indexes list every example and command', () => {
  assert.equal((examplesIndex(examples).match(/<li>/g) ?? []).length, 9);
  const rows = [{ name: 'render', title: 'render', summary: 'Preview', examples: [byId('render')] }];
  assert.match(commandsIndex(rows), /\[render\]\(\/commands\/render\/\)/);
});

test('about page drops relative links and the first heading', () => {
  const page = aboutPage('# Tool\n\nSee [the guide](docs/guide.md) and [site](https://example.com).\n');
  assert.doesNotMatch(page, /^# Tool/m);
  assert.match(page, /See the guide and \[site\]\(https:\/\/example\.com\)\./);
});

test('images in a subfolder keep their path and are all present', () => {
  const ex = byId('webassets');
  assert.deepEqual(ex.images, ['site/favicon-32.png', 'site/og.png']);
  assert.deepEqual(ex.missingImages, []);
  assert.match(examplePage(ex, 'example'), /\(\/examples\/webassets\/site\/og\.png\)/);
  assert.equal(byId('fill').images.length, 2);
  assert.deepEqual(byId('brand-show').needs, ['affinity']);
});

test('nested images can be copied to a mirrored folder', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'axi-dash-'));
  const ex = byId('webassets');
  for (const f of ex.images) {
    const target = path.join(out, ex.id, f);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ex.dir, f), target);
  }
  assert.ok(fs.existsSync(path.join(out, 'webassets', 'site', 'favicon-32.png')));
  fs.rmSync(out, { recursive: true, force: true });
});

test('README sections give the id and whether the example is generated', () => {
  const sections = readReadmeSections(gallery);
  assert.deepEqual(sections.map((s) => s.id), ['render', 'brand-show', 'brand-init', 'helpers-text', 'webassets', 'fill', 'platforms', 'helpers-qr', 'hint-search', 'doc-open']);
  assert.equal(sections.find((s) => s.id === 'brand-init').generated, false);
  assert.equal(sections.filter((s) => s.generated).length, 9);
  assert.deepEqual(readReadmeSections(path.join(gallery, 'nowhere')), []);
});

test('a heading inside a code fence is not a section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axi-readme-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '## Real\n\n`real`: one\n\n```\n## Fake\n`fake`: two\n```\n');
  assert.deepEqual(readReadmeSections(dir), [{ id: 'real', title: 'Real', generated: true }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('README and example pages agree on the fixture gallery', () => {
  assert.deepEqual(compareReadme(readReadmeSections(gallery), examples.map((e) => e.id)), []);
});

test('a README mismatch is reported in both directions', () => {
  const sections = [
    { id: 'a', title: 'A', generated: true },
    { id: 'b', title: 'B', generated: true },
    { id: 'c', title: 'C', generated: false },
    { id: null, title: 'D', generated: true },
  ];
  const text = compareReadme(sections, ['a', 'c', 'e']).join('\n');
  assert.match(text, /"B" \(b\) has no example page/);
  assert.match(text, /example page c has no generated section/);
  assert.match(text, /example page e has no generated section/);
  assert.match(text, /"D" has no backticked example id/);
});

test('word scan flags a forbidden term and passes clean text', () => {
  const bad = ['cla', 'ude'].join('');
  assert.deepEqual(findTerm(`one\ntwo ${bad.toUpperCase()} three`), { term: bad.toUpperCase(), line: 2 });
  assert.equal(findTerm('Lumen Studio uses Helvetica-Bold on a mist background'), null);
});

const famId = (feature) => familyOf(feature)?.id ?? null;
const realGallery = path.resolve(gallery, '..', '..', '..', 'examples');

test('familyOf maps commands, helper features, platforms, lint and unknowns', () => {
  assert.equal(famId('doc open'), 'documents');
  assert.equal(famId('doc'), 'documents');
  assert.equal(famId('document'), null);
  assert.equal(famId('inspect'), 'documents');
  assert.equal(famId('helpers:qr'), 'charts');
  assert.equal(famId('helpers:charts2'), 'charts');
  assert.equal(famId('helpers:brand'), 'fill-brand');
  assert.equal(famId('helpers:text'), 'scripts');
  assert.equal(famId('helpers'), 'scripts');
  assert.equal(famId('platforms'), 'sizes');
  assert.equal(famId('lint'), 'sizes');
  assert.equal(famId('docs list'), 'learning');
  assert.equal(famId('print'), 'export');
  assert.equal(famId('templates new'), 'fill-brand');
  assert.equal(famId('nonsense'), null);
  assert.equal(familyOf(byId('render')).id, 'export');
});

test('family table has unique ids and no feature listed twice', () => {
  const ids = FAMILIES.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  const entries = FAMILIES.flatMap((f) => f.features);
  assert.equal(new Set(entries).size, entries.length);
});

test('fixture gallery fills every family and nothing lands in Other', () => {
  const { groups, unmatched } = groupByFamily(examples);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(groups.map((g) => g.family.id), FAMILIES.map((f) => f.id));
  assert.equal(groups.reduce((n, g) => n + g.examples.length, 0), examples.length);
  const odd = groupByFamily([{ id: 'x', feature: 'mystery' }]);
  assert.deepEqual(odd.unmatched, ['x']);
  assert.equal(odd.groups[0].family.id, 'other');
});

test('every example of the real gallery belongs to a family', { skip: !fs.existsSync(realGallery) }, () => {
  assert.deepEqual(groupByFamily(readExamples(realGallery).examples).unmatched, []);
});

test('feature page has frontmatter, an image strip, every example and no table rows', () => {
  const exportGroup = groupByFamily(examples).groups.find((g) => g.family.id === 'export');
  const page = featurePage(exportGroup.family, exportGroup.examples, 4);
  assert.match(page, /^title: "Export"$/m);
  assert.match(page, /^sidebar:\n {2}order: 4$/m);
  assert.match(page, /<ul class="strip not-content">/);
  assert.match(page, /<img src="\/examples\/render\/render\.png" alt="Preview the current spread" loading="lazy">/);
  for (const ex of exportGroup.examples) assert.ok(page.includes(`](/examples/${ex.id}/)`), ex.id);
  assert.match(page, /Command: \[`render`\]\(\/commands\/render\/\)/);
  assert.match(page, /affinity-axi render \$DOC/);
  assert.doesNotMatch(page.replace(/```[\s\S]*?```/g, ''), /^\|/m);
  const noShots = featurePage(FAMILIES[0], [byId('doc-open')]);
  assert.doesNotMatch(noShots, /class="strip/);
  assert.match(noShots, /Command: \[`doc open`\]\(\/commands\/doc-open\/\)/);
});

test('feature page links helper and platform examples to their own pages', () => {
  assert.match(featurePage(FAMILIES[5], [byId('helpers-qr')]), /Command: \[`helpers:qr`\]\(\/helpers\/qr\/\)/);
  assert.match(featurePage(FAMILIES[4], [byId('platforms')]), /\]\(\/platforms\/\)/);
});

test('features index has one card per family', () => {
  const { groups } = groupByFamily(examples);
  const page = featuresIndex(groups);
  assert.equal((page.match(/<li>/g) ?? []).length, groups.length);
  assert.match(page, /<a href="\/features\/export\/">/);
  assert.match(page, /<span class="feature-count">2 examples<\/span>/);
  assert.match(page, /<span class="feature-count">1 example<\/span>/);
});
