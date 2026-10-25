// @ts-check
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Starlight brings MDX, Expressive Code and Pagefind search with it.
// `npm run gen:pages` (run before dev, build and check) writes the generated page folders below.
const config = JSON.parse(fs.readFileSync(new URL('./dashboard.config.json', import.meta.url), 'utf8'));
const docsDir = (dir) => new URL(`./src/content/docs/${dir}`, import.meta.url);

/** A sidebar group for a generated folder; left out when the generator wrote nothing for it. */
const generated = (label, dir) =>
  fs.existsSync(docsDir(dir)) ? [{ label, collapsed: false, items: [{ autogenerate: { directory: dir } }] }] : [];

export default defineConfig({
  integrations: [
    starlight({
      title: config.siteTitle,
      description: 'A local site that shows what each affinity-axi command prints, with captured output and renders.',
      customCss: ['./src/styles/tokens.css', './src/styles/dashboard.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'How to read this site', slug: 'guide' },
            ...(fs.existsSync(docsDir('about')) ? [{ label: 'About the tool', slug: 'about/overview' }] : []),
          ],
        },
        ...generated('Features', 'features'),
        ...generated('Commands', 'commands'),
        ...generated('Examples', 'examples'),
        ...generated('Helpers', 'helpers'),
        ...generated('Platforms', 'platforms'),
      ],
    }),
  ],
});
