// Reads the examples gallery:
//   <gallery>/_help/<command-with-dashes>.txt     exact `--help` stdout per command
//   <gallery>/<id>/example.json, command.sh, [script.js], output.txt, images
// Folders that start with `_` are not examples. An example marked `pending` is skipped.
import fs from 'node:fs';
import path from 'node:path';
import { slug } from './markdown.mjs';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|svg)$/i;
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

export const isImage = (name) => IMAGE_RE.test(name);

/** Command path ("doc open") to its page slug and `_help` file stem ("doc-open"). */
export const commandSlug = (command) => slug(command);

/**
 * Read every example folder. Problems that make one example unusable go to `problems`;
 * the others still load, so one bad folder does not hide the rest.
 */
export function readExamples(galleryDir) {
  const examples = [];
  const problems = [];
  if (!fs.existsSync(galleryDir)) return { examples, problems: [`gallery not found: ${galleryDir}`] };
  const dirs = fs.readdirSync(galleryDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('_'));
  for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(galleryDir, d.name);
    const raw = readText(path.join(dir, 'example.json'));
    if (raw === null) {
      problems.push(`${d.name}: no example.json`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch (e) {
      problems.push(`${d.name}: example.json is not valid JSON (${e.message})`);
      continue;
    }
    if (meta.pending) continue;
    const id = d.name;
    const images = (Array.isArray(meta.images) ? meta.images : []).filter((f) => typeof f === 'string');
    const missingImages = images.filter((f) => !fs.existsSync(path.join(dir, f)));
    const scriptFile = typeof meta.script === 'string' ? meta.script : 'script.js';
    examples.push({
      id,
      dir,
      feature: String(meta.feature ?? id),
      title: String(meta.title ?? id),
      summary: String(meta.summary ?? ''),
      needs: Array.isArray(meta.needs) ? meta.needs.map(String) : [],
      commands: Array.isArray(meta.commands) ? meta.commands.map(String) : [],
      images,
      missingImages,
      commandSh: readText(path.join(dir, 'command.sh')),
      script: readText(path.join(dir, path.basename(scriptFile))),
      scriptName: path.basename(scriptFile),
      output: readText(path.join(dir, 'output.txt')),
    });
    if (readText(path.join(dir, 'output.txt')) === null) problems.push(`${id}: no output.txt (page shows a placeholder)`);
  }
  return { examples, problems };
}

/** Captured `--help` texts keyed by file stem. */
export function readHelp(galleryDir) {
  const out = {};
  const dir = path.join(galleryDir, '_help');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.txt')).sort()) out[f.replace(/\.txt$/, '')] = fs.readFileSync(path.join(dir, f), 'utf8');
  return out;
}

/**
 * Sections of the gallery's README.md: every `## ` heading outside a code fence.
 * The id is the backticked word that opens the next non-empty line; `generated` is false
 * when the first non-empty line after that starts with "Not generated".
 * Returns [] when there is no README.
 */
export function readReadmeSections(galleryDir) {
  const text = readText(path.join(galleryDir, 'README.md'));
  if (text === null) return [];
  const sections = [];
  let fenced = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && line.startsWith('## ')) {
      current = { id: null, title: line.slice(3).trim(), generated: true, seenBody: false };
      sections.push(current);
      continue;
    }
    if (fenced || !current || !line.trim()) continue;
    if (current.id === null) {
      current.id = /^`([^`]+)`/.exec(line)?.[1] ?? null;
    } else if (!current.seenBody) {
      current.seenBody = true;
      current.generated = !/^Not generated/.test(line.trim());
    }
  }
  return sections.map(({ id, title, generated }) => ({ id, title, generated }));
}

/** Errors for a README that does not match the example pages ([] when they agree). */
export function compareReadme(sections, exampleIds) {
  const errors = [];
  const pages = new Set(exampleIds);
  const generated = new Set();
  for (const s of sections) {
    if (!s.id) errors.push(`README section "${s.title}" has no backticked example id on its first line`);
    else if (s.generated) {
      generated.add(s.id);
      if (!pages.has(s.id)) errors.push(`README section "${s.title}" (${s.id}) has no example page; the dashboard build is stale or the example is missing`);
    }
  }
  for (const id of exampleIds) if (!generated.has(id)) errors.push(`example page ${id} has no generated section in README.md; regenerate the gallery`);
  return errors;
}

/** Which page group an example belongs to besides the Examples group. */
export function groupOf(example) {
  if (example.feature === 'helpers' || example.feature.startsWith('helpers:')) return 'helpers';
  if (example.feature === 'platforms') return 'platforms';
  return 'commands';
}
