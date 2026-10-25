// Small Markdown helpers shared by the page generator and the checker (no dependencies).

/** Parse a flat `key: value` frontmatter block. Returns { data, body }. */
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) {
      try { v = JSON.parse(v); } catch { v = v.slice(1, -1); }
    }
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length) };
}

/** Frontmatter block. Values are JSON-quoted, so colons and quotes never break the YAML scalar. */
export function frontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) lines.push(`  ${k2}: ${JSON.stringify(v2)}`);
    } else lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** A fenced code block whose fence is longer than any run of backticks inside the text. */
export function fence(text, lang = '') {
  const runs = [...text.matchAll(/`+/g)].map((m) => m[0].length);
  const ticks = '`'.repeat(Math.max(3, ...runs.map((n) => n + 1)));
  return `${ticks}${lang}\n${text.replace(/\n+$/, '')}\n${ticks}`;
}

/** Escape raw `<tag` outside backtick spans so Markdown never reads it as HTML. */
export function escapeLine(line) {
  return line
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') ? part : part.replace(/<(?=[A-Za-z/!])/g, '&lt;')))
    .join('');
}

/** Escape text for an HTML attribute or element body. */
export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Apply `fn(line)` to every line outside code fences. */
export function mapOutsideFences(body, fn) {
  let inFence = false;
  return body
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      return inFence ? line : fn(line);
    })
    .join('\n');
}

/** One-line description: the first plain paragraph of a body, clipped at a word boundary. */
export function firstParagraph(body, max = 160) {
  const para = body
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^(#|```|<|\||!\[|-|\*)/.test(p));
  let text = (para ?? '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
  if (text.length > max) text = `${text.slice(0, max - 3).replace(/\s+\S*$/, '')}...`;
  return text;
}

/** Drop the first `# ` heading (Starlight renders the frontmatter title). */
export function stripFirstH1(body) {
  return body.replace(/^#\s+.+\r?\n+/m, '');
}

/** Lower-case, dash-separated slug that is safe in a URL and a file name. */
export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
