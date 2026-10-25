// Turns gallery data into page descriptors { file, text }; `file` is relative to src/content/docs.
// Pure functions: gen-pages.mjs does the reading and writing.
import { commandSlug, groupOf, isImage } from './gallery.mjs';
import { escapeHtml, escapeLine, fence, firstParagraph, frontmatter, mapOutsideFences, slug, stripFirstH1 } from './markdown.mjs';

const BIN = 'affinity-axi';
const imageUrl = (id, file) => `/examples/${id}/${encodeURI(file)}`;
const cell = (text) => String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const code = (text) => `\`${String(text).replace(/`/g, "'")}\``;

/** Where an example page lives besides the Examples group. */
export function helperFamily(example) {
  return example.feature.includes(':') ? slug(example.feature.split(':').slice(1).join('-')) : null;
}

function imageBlock(ex) {
  const shots = ex.images.filter((f) => isImage(f) && !ex.missingImages.includes(f));
  return shots.map((f) => `![${escapeHtml(f.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '))}](${imageUrl(ex.id, f)})`).join('\n\n');
}

/** Commands, script, output and images of one example, at the given heading level. */
export function exampleSections(ex, level) {
  const h = '#'.repeat(level);
  const out = [];
  const shell = ex.commandSh ?? ex.commands.join('\n');
  if (shell.trim()) out.push(`${h} Commands`, '', 'Run from the tool folder. `$DOC` is the demo document and `$OUT` the example folder.', '', fence(shell, 'sh'), '');
  if (ex.script) out.push(`${h} Script`, '', `Saved next to the example as ${code(ex.scriptName)}.`, '', fence(ex.script, 'js'), '');
  out.push(`${h} Output`, '');
  out.push(ex.output === null ? '_No output captured yet. Run the gallery generator to fill it in._' : 'Captured stdout, normalised (ids, timings and home folder replaced).', '');
  if (ex.output !== null) out.push(fence(ex.output), '');
  const images = imageBlock(ex);
  if (images) out.push(`${h} Images`, '', images, '');
  return out.join('\n');
}

const needsLine = (ex) => (ex.needs.length ? `Needs: ${ex.needs.map(code).join(', ')}.` : 'Needs nothing running: this one works offline.');

/** The page for one example, used by the Examples and Helpers groups. */
export function examplePage(ex, kind) {
  const featureLink = groupOf(ex) === 'commands' ? `[${code(ex.feature)}](/commands/${commandSlug(ex.feature)}/)` : code(ex.feature);
  const head = frontmatter({ title: ex.title, description: ex.summary || ex.title, kind, source: `${ex.id}/example.json` });
  const body = [escapeLine(ex.summary), '', `Feature: ${featureLink}. ${needsLine(ex)}`, '', exampleSections(ex, 2)];
  return `${head}\n${body.join('\n')}\n`;
}

const thumb = (ex) => ex.images.find((f) => isImage(f) && !ex.missingImages.includes(f));

/** Gallery overview: a card per example with its first image. */
export function examplesIndex(examples) {
  const head = frontmatter({ title: 'Gallery', description: 'Every example with its first image, newest output on the page behind each card.', sidebar: { order: 0, label: 'Gallery' } });
  const cards = examples.map((ex) => {
    const t = thumb(ex);
    const img = t ? `<img src="${imageUrl(ex.id, t)}" alt="" loading="lazy">` : '<span class="shot-none">no image</span>';
    return `<li><a href="/examples/${ex.id}/">${img}<strong>${escapeHtml(ex.title)}</strong><span>${escapeHtml(ex.summary)}</span></a></li>`;
  });
  const lead = `${examples.length} example${examples.length === 1 ? '' : 's'}. Pick a card for the commands, the script and the real output.`;
  return `${head}\n${lead}\n\n<ul class="gallery not-content">\n${cards.join('\n')}\n</ul>\n`;
}

/** One page per command: the help text, then every example of that command. */
export function commandPage(name, help, examples) {
  const title = name.replace(/-/g, ' ');
  const head = frontmatter({ title, description: examples[0]?.summary || `What ${BIN} ${title} accepts and prints.`, kind: 'command', source: `_help/${name}.txt` });
  const body = [];
  if (help !== null) body.push(`Help text exactly as ${code(`${BIN} ${title} --help`)} prints it.`, '', fence(help), '');
  if (examples.length === 0) body.push('No example has been captured for this command yet.', '');
  for (const ex of examples) {
    body.push(`## Example: ${escapeLine(ex.title)}`, '', escapeLine(ex.summary), '', `${needsLine(ex)} Full page: [${escapeLine(ex.title)}](/examples/${ex.id}/).`, '', exampleSections(ex, 3));
  }
  return `${head}\n${body.join('\n')}\n`;
}

/** Commands overview: one row per command page. */
export function commandsIndex(rows) {
  const head = frontmatter({ title: 'All commands', description: 'Every command with a one-line summary and the examples that show it.', sidebar: { order: 0, label: 'All commands' } });
  const lines = rows.map((r) => `| [${cell(r.title)}](/commands/${r.name}/) | ${cell(r.summary)} | ${r.examples.map((e) => `[${cell(e.id)}](/examples/${e.id}/)`).join(', ') || 'none yet'} |`);
  return `${head}\n| Command | What it does | Examples |\n|---|---|---|\n${lines.join('\n')}\n`;
}

/** Helpers overview: the `helpers` command help, its own examples and the family pages. */
export function helpersIndex(help, direct, families) {
  const head = frontmatter({ title: 'Helpers', description: 'The axi helper functions that --with-helpers adds to a script, grouped by family.', kind: 'helper', sidebar: { order: 0, label: 'Overview' } });
  const body = ['The helper functions that `--with-helpers` appends to a script. One page per family follows in the sidebar.', ''];
  if (families.length) body.push('| Family | What it shows |', '|---|---|', ...families.map((f) => `| [${cell(f.family)}](/helpers/${f.family}/) | ${cell(f.summary)} |`), '');
  if (help !== null) body.push('## The helpers command', '', fence(help), '');
  for (const ex of direct) body.push(`## ${escapeLine(ex.title)}`, '', escapeLine(ex.summary), '', exampleSections(ex, 3));
  return `${head}\n${body.join('\n')}\n`;
}

/** Platforms: the offline size table command, its help and captured output. */
export function platformsIndex(help, examples) {
  const head = frontmatter({ title: 'Platforms', description: 'Web and social image sizes the platforms command prints, with the captured output.', kind: 'platform', sidebar: { order: 0, label: 'Sizes' } });
  const body = ['The `platforms` command works offline. These are its help text and captured runs.', ''];
  if (help !== null) body.push('## Help', '', fence(help), '');
  for (const ex of examples) body.push(`## ${escapeLine(ex.title)}`, '', escapeLine(ex.summary), '', exampleSections(ex, 3));
  return `${head}\n${body.join('\n')}\n`;
}

/** The page a feature example's command is documented on. */
function commandLink(ex) {
  const group = groupOf(ex);
  if (group === 'helpers') return { href: helperFamily(ex) ? `/helpers/${helperFamily(ex)}/` : '/helpers/', label: ex.feature };
  if (group === 'platforms') return { href: '/platforms/', label: ex.feature };
  return { href: `/commands/${commandSlug(ex.feature)}/`, label: ex.feature };
}

/** Features overview: a card per family with its lead and example count. */
export function featuresIndex(groups) {
  const head = frontmatter({ title: 'Features', description: 'What affinity-axi can do, grouped by task, with the examples that show each group.', sidebar: { order: 0, label: 'Overview' } });
  const cards = groups.map(({ family, examples }) => {
    const n = `${examples.length} example${examples.length === 1 ? '' : 's'}`;
    return `<li><a href="/features/${family.id}/"><strong>${escapeHtml(family.label)}</strong><span>${escapeHtml(family.lead)}</span><span class="feature-count">${n}</span></a></li>`;
  });
  const lead = `${groups.length} feature group${groups.length === 1 ? '' : 's'}. Pick a card to see its examples side by side.`;
  return `${head}\n${lead}\n\n<ul class="feature-cards not-content">\n${cards.join('\n')}\n</ul>\n`;
}

/** One feature page: the lead, an image strip, then every example with its commands and links. */
export function featurePage(family, examples, order = 1) {
  const head = frontmatter({ title: family.label, description: family.lead, sidebar: { order, label: family.label } });
  const body = [escapeLine(family.lead), ''];
  const shots = examples.map((ex) => ({ ex, file: thumb(ex) })).filter((s) => s.file);
  if (shots.length) {
    const items = shots.map(({ ex, file }) => `<li><a href="/examples/${ex.id}/"><img src="${imageUrl(ex.id, file)}" alt="${escapeHtml(ex.title)}" loading="lazy"><span>${escapeHtml(ex.title)}</span></a></li>`);
    body.push(`<ul class="strip not-content">\n${items.join('\n')}\n</ul>`, '');
  }
  for (const ex of examples) {
    const link = commandLink(ex);
    const shell = (ex.commandSh ?? ex.commands.join('\n')).trim();
    body.push(`## [${escapeLine(ex.title).replace(/[\[\]]/g, '')}](/examples/${ex.id}/)`, '', escapeLine(ex.summary), '');
    if (shell) body.push(fence(shell, 'sh'), '');
    body.push(`Command: [${code(link.label)}](${link.href}). ${needsLine(ex)}`, '');
  }
  return `${head}\n${body.join('\n')}\n`;
}

/** The tool README as one page: first heading dropped, relative links reduced to their text. */
export function aboutPage(readme) {
  const body = mapOutsideFences(stripFirstH1(readme), (line) => escapeLine(line.replace(/\[([^\]]+)\]\((?!https?:|mailto:|#)[^)]*\)/g, '$1')));
  const head = frontmatter({ title: 'About the tool', description: firstParagraph(body) || 'What affinity-axi is.', kind: 'about', source: 'README.md' });
  return `${head}\n${body}\n`;
}
