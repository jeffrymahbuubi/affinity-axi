# affinity-axi dashboard

A local static site that shows what each `affinity-axi` command prints. It is built from the
examples gallery in `../examples/`, the captured help texts in `../examples/_help/` and the tool
`../README.md`. Nothing is hosted: you run it on your machine.

Built with Astro 7.4.2 and Starlight 0.42.6, both pinned. Use the Node version in `../.nvmrc`
(`nvm use` from `tools/affinity-axi/`).

## Commands

```sh
npm install         # once
npm run dev         # site on http://localhost:4321 with live reload
npm run build       # static output in dist/
npm run preview     # serve dist/
npm run check       # generate, unit tests, astro check, build, then scripts/check-dashboard.mjs
npm run check:fixture   # the same, against the bundled fixture gallery
```

Run Astro only through these scripts. `dev`, `build` and `check` generate the pages first; calling
`npx astro` directly skips that step and builds against stale or missing pages.

## What the generator does

`scripts/gen-pages.mjs` writes these git-ignored folders under `src/content/docs/`:

| Folder | Source |
|---|---|
| `examples/` | one page per gallery folder with `example.json`; images are copied to `public/examples/<id>/` |
| `commands/` | one page per file in `_help/`, plus the examples whose `feature` is that command |
| `helpers/` | examples with a `helpers` or `helpers:<family>` feature |
| `platforms/` | examples with the `platforms` feature, plus its help text |
| `features/` | one page per feature family (`scripts/lib/families.mjs`) plus an overview: a lead, an image strip, then each example with its commands |
| `about/` | the tool README |

A feature entry in `families.mjs` is an exact feature, a command path (`doc` covers `doc open`) or a
`helpers:` style prefix; the most specific match wins. An example that matches no family lands on an
`Other` page, the generator warns and `check` fails, so add its feature to the table.

Examples marked `pending` in `example.json` are skipped. A sidebar group only appears when its folder
was written. The gallery is `../examples` when it exists; otherwise the bundled `fixtures/gallery`
stands in and the generator prints a warning. `AXI_GALLERY=<folder>` overrides both.

`scripts/check-dashboard.mjs` fails when an example has no page or no built HTML, a listed image is
missing, a page links an image that does not exist, a frontmatter description would break the YAML,
or any file is over 500 lines. It also compares the gallery's `README.md` with the example pages:
every `## ` section whose body is not "Not generated" must have a page, and every page a section
(`readReadmeSections` and `compareReadme` in `scripts/lib/gallery.mjs`), so a stale build fails. It also requires a built Features overview and one built page per family in the manifest, each
linking all of its examples, and fails when an example is in no family. It also scans hand-written files for words that must stay out of this
folder (`scripts/lib/terms.mjs`); generated pages only produce warnings for those.

## Hand-written files

`src/content/docs/index.mdx` and `guide.mdx`, the styles in `src/styles/`, the scripts and the
fixtures. Everything else under `src/content/docs/` is generated.
