# affinity-axi

An AXI (Agent eXperience Interface) CLI that drives Affinity by Canva through its built-in MCP server. Scripts are passed by path, renders go to disk, and output is compact TOON. Scaffolded by [axi-axi](https://github.com/CodyEngel/axi-axi) against AXI spec `axi/1.0-2026-07`.

**What this is.** A command-line tool for producing designs in Affinity from scripts: social posts, carousels, website launch files (favicons, OG and X cards), ad sizes under a file budget, print PDFs. You write a short JavaScript file against Affinity's scripting SDK (or use the tested `axi*` helpers and ready-made templates), and the CLI runs it, renders, exports and keeps a manifest of how each file was made. A brand kit keeps colours and fonts per project.

**Status:** 0.3.2, macOS, tested against Affinity 3.3.1; installed locally with `npm link` (not published to npm).

**Requirements:** macOS, Affinity by Canva 3.3 or later with its MCP server enabled, Node.js 20 or later.

**Quick start**

```sh
npm install && npm run build && npm link
affinity-axi                                   # is Affinity reachable? which documents are open?
affinity-axi doc new --width 1080 --height 1080
affinity-axi templates new ig-post --out ~/Desktop/post.af --brand examples/_brand/brand.json
affinity-axi examples                          # 50+ worked examples with sample output
```

## Why affinity-axi instead of the raw MCP tools

Affinity's MCP server gives an agent `execute_script`, `render_spread` and a handful of other tools. affinity-axi wraps them in a CLI built for agents. Every point below comes from problems found while driving Affinity 3.3.1 live.

- **Fewer tokens.** Scripts are passed by path instead of being pasted into the conversation. Renders are written to disk and only their path is printed, and output is compact TOON. Three measured runs, one sample each, with the same model and task on both sides:

  | Task | Raw MCP tools | affinity-axi | Saving |
  |---|---|---|---|
  | A 4-post series from one template with a brand kit, a recolour round, and a PNG export per post (`fill --brand`) | 4.35M tokens, 36 turns | 2.01M tokens, 22 turns | **54% fewer** |
  | A 4-post Instagram series, a recolour round, and a PNG export per post | 3.06M tokens, 31 turns | 0.80M tokens, 11 turns | **74% fewer** |
  | A smoke test, five edit-and-render rounds, then a PNG and SVG export, before `batch` and the helpers existed | 1.21M tokens, 17 turns | 0.66M tokens, 10 turns | **45% fewer** |

  Most of the saving is context that is no longer carried from turn to turn. The helpers also spare the agent from reading large SDK files and fixing first attempts. Viewing a render costs the same either way.
- **Failures are reported as failures.** `execute_script` reports a thrown exception with `isError: false`. `run` reads the output text and reports `status: exception` with the line, or `not-allowed`, or `sdk-error`.
- **Safe by default.** Closing an unsaved document opens a save prompt that blocks the scripting session and can hang Affinity. `run` refuses `close()`, `closeAsync()` and dialog scripts, and `doc close` refuses unsaved documents. `doc save` followed by `doc close` is the safe path. A timeout tells you to check Affinity for a dialog rather than retry.
- **Handles the protocol for you.** It reads the required `preamble` once per session, uses the exact protocol version, and sends numeric spread indexes. Export preset names are checked against the install's own localized list, because a bare `SVG` throws. Paths are checked against the Desktop sandbox before anything runs (hidden-folder paths are refused offline), and documents can be referenced by a short UUID prefix or `current`.
- **Common jobs in one command.**
  - `export --all-artboards` turns one design into every social and web size.
  - `batch template.js --data posts.csv` produces a post series over a single connection.
  - `fill post.af --data posts.json --key slug --out-dir out --export PNG` fills a hand-tuned design: name what changes `slot:headline`, `slot:price`, `slot:photo` in Affinity, save it, and each record becomes `<key>.af` plus an export. A string fills text, a `#RRGGBB` string colours a shape, an image path swaps a picture; `{text}`, `{fill}`/`{colour}` (on a text slot too, e.g. `{"text": "Sale", "fill": "#B5553A"}`), `{image,fit}`, `{box}`, `{hidden}` are explicit; a plain string on a text slot is always text, and replaced text keeps the slot's font, size and colour, and `board/k` targets `board/slot:k`.
  - `--with-helpers` adds tested SDK helpers: fonts by exact postscript name, text that shrinks to fit, cover and contain photo fitting, colour-grade stacks, artboards and platform safe zones.
  - `fonts` and `platforms` answer the questions agents usually guess at.
- **AI under control.** Generative Canva AI is opt-in per run. Every generative run is logged, and exports from AI-touched documents get a provenance sidecar and an embedded IPTC `DigitalSourceType` tag (with `exiftool`) for Meta and Google AI labelling. ML-assisted edits (background removal, subject selection, depth, colourise) need no flag.
- **No account name in your exports.** Affinity stamps the signed-in account into the XMP of whole-document PNG exports and into the EXIF, IPTC and XMP of JPEG exports. `export`, `fill --export`, `webassets` and `batch --out-dir` strip it by default (a JPEG loses its Exif, XMP and IPTC segments; colour profile kept); `--creator`/`--copyright` or a brand-kit `credit` embed your own credit instead (with `exiftool`).
- **Reproducible and owned.** An asset is a script and its data on disk, so it can be versioned, re-run and reviewed. Previews and exports are files, and you own the `.af` sources.
- **Works with any coding agent.** It's a plain CLI with consistent exit codes (0 success or no-op, 1 error, 2 usage), so anything with a shell can drive it: any coding agent, scripts and CI. A home view, `--help`, a generated usage guide (`docs/agent-guide.md`) and an optional session-start hook explain it to a new session.
- **Tested without Affinity.** Hundreds of unit tests run against a fake MCP server in CI, and `npm run smoke:live -- --repeat N` is a self-cleaning live stability suite.

**Limits.** Affinity must be running with its MCP server enabled; there is no headless mode. Affinity can only read and write files under the Desktop folder, and not inside hidden (dot-prefixed) folders; affinity-axi refuses such paths before connecting. The script guards are textual, so Affinity's own permission settings remain the last line of defence.

**Safe by default.** `run` refuses scripts that call `close()`/`closeAsync()` or load `/dialog.js` (a save prompt can hang Affinity); use `doc save` + `doc close` instead, or pass `--allow-blocking`.

**Generative AI is opt-in per run.** `run` and `library save` refuse any script that references the SDK's generative Canva AI APIs (`generateImage`, `generativeEditImage` and their `create…` / `…Command` forms) before connecting. Pass `--allow-generative` to allow them for that one run. It spends Canva AI credits and needs Affinity's Settings > "Use Canva AI Studio features" ON; otherwise the call returns `NOT_ALLOWED` (the run reports `status: not-allowed`). ML-assisted calls (`removeBackground`, `selectSubject`, `detectDepth`, `colourise`) never need the flag.

**Provenance.** A run that really references a generative API appends one JSON line to `.affinity-axi/provenance.jsonl` in the current directory (time, script path, sha256, identifiers and lines, `--args`, outcome, document UUIDs seen in the output; if the script prints none, the current document) and prints `provenance: logged (ai-generated)`. `export` of a document in that log prints `provenance: ai-generated` and writes `<file>.provenance.json` next to the export, for labelling posts and ads. `library save --allow-generative` logs nothing, because nothing runs.

## Install

Requires Affinity running with Settings > Model Context Protocol > Enable MCP server turned on. The URL defaults to `http://[::1]:6767`; override it with `AFFINITY_MCP_URL` or `--url`.

```sh
npm install && npm run build && npm link   # local link only; not published to npm
affinity-axi                               # home view: connection, open documents
```

## Commands

| Command | Does |
|---|---|
| `run <file.js>` | Run a script; prints status and truncated output (`--args`, `--timeout`, `--full`, `--with-helpers`, `--allow-generative`) |
| `helpers` | List the `axi*` SDK helpers that `--with-helpers` appends (font lookup, text, measure, rect, ellipse, hex, image placement, ML cut-outs (background or subject, re-centred or fitted to their frame), depth maps that keep the photo, depth-driven background blur, colourise, QR codes, outlines and boolean ops, tables, multi-size variants, carousels, charts (incl. grouped, stacked and line), seals and arc text, pattern tiles, print documents and proof sheets, brand tokens) |
| `doc new` / `doc save` / `doc close` | Create a document (`--transparent` for cut-outs, so a PNG export keeps alpha); save it under Desktop (a `.af` that was hand-edited or not saved by affinity-axi is refused without `--force`); close it only when clean (the SDK cannot discard) |
| `fonts` | Installed fonts with exact postscript names (`--grep`, `--family`) |
| `brand list\|show\|check\|init` | Per-project brand kits (`<slug>.brand.json`: colours, fonts, type styles, spacing, radius, logo, contrast pairs, optional `credit`). `run`, `batch` and `fill` take `--brand <kit>` (then `$AFFINITY_AXI_BRAND`, then `./brand.json`; a bare name means `./brands/<name>.brand.json`); the kit is injected as `AXI_BRAND` for `axiToken`/`axiType`, recorded as `madeBy.brand`, and `doc info` prints `brand:` (`(changed)` when the kit file differs). An optional `"credit": {"creator": "Studio X", "copyright": "(c) 2026 Studio X"}` is embedded in exports by `export`, `fill` and `batch` (needs `exiftool`) |
| `webassets <doc> --out-dir <dir>` | Website launch files from named artboards: 6 favicon PNGs, `icon.svg`, `favicon.ico`, `site.webmanifest`, `og.png`, `x-card.png`, `<name>[@2x].png/.webp`, `head.html` and `webassets.json` (`--mark`, `--og`, `--x`, `--responsive a,b`, `--href`, `--theme`, `--no-favicons`, `--no-alt`, `--spread`). Images are stripped of Affinity's XMP (no credit). Each image gets an alt-text stub from the document's own text (top-down, 125 characters) in `webassets.json` and as `og:image:alt` / `twitter:image:alt` in `head.html`; edit it before publishing |
| `templates list` / `templates new <name> --out <file.af>` | Five ready-made slot templates on a brand kit (ig-post, ig-story, carousel-cover, og-card, price-post). A kit with `type.display`, `type.h1` and `type.body` is required; photo templates take `--args '{"photo":…}'`, price-post takes `--args '{"rows":[[…]]}'`. Fill text, photo and CTA colour afterwards with `fill`; tables are regenerated, not filled. An existing `.af` that affinity-axi did not save, or that was hand-edited, needs `--force` |
| `lint <doc>` | Design checks before export: contrast against the solid fill below each text, platform safe zones, text smaller than `--min-font` (default 20 px at 72 dpi, scaled by the document dpi), text off its board (`off-board` error), `slot:` names, and with `--brand` colours outside the kit. Errors exit 1; `--strict` promotes warnings (`--platform`, `--artboard`, `--out`) |
| `print <doc> --out <file.pdf>` | Export a press PDF (default PDF/X-4; `--preset`, `--artboard`, `--cmyk`) and preflight it offline: PDF/X version, output intent, trim and bleed boxes, CMYK, embedded fonts; warns (`author-metadata`) when the PDF carries Affinity's Author/Creator, which is not stripped. Note: the PDF/X presets export the trim area only; `--preset "PDF (press ready)"` keeps the bleed |
| `fill <template.af>` | Fill a hand-tuned `.af` by element name (`slot:<key>`) from JSON or CSV, saving `<key>.af` per record and optionally exporting it (exports are stripped of Affinity's XMP and carry the kit's `credit`); a picture slot can request ML (`{"image": …, "cutout": true}`, centred by default, `"align"`/`"padding"`, `"colourise": true`) (`--data`, `--out-dir`, `--key`, `--export`, `--all-artboards`, `--ignore-unknown`, `--continue-on-error`, `--limit`, `--force`). Text slots keep their alignment, shrink to fit (down to half size) and say so in the row note; picture slots take png, jpg, webp, heic, heif and tif(f), with EXIF orientation applied. A failed record is undone and closed (`--continue-on-error` carries on); one undo cannot clean is saved to `<out-dir>/_failed/` and closed. Opens the template per record and closes only clean documents |
| `batch <template.js>` | Run a template once per `--data` record (JSON or CSV) over one connection (`--key`, `--out-dir`, `--save-dir`, `--continue-on-error`, `--limit`, `--force`). Rasters the template writes at the top level of `--out-dir` are stripped of Affinity's XMP (kit `credit` embedded) and counted as `cleaned: <n>`; exports made inside a script by other paths are not touched. A failed record that leaves a document open is named in its note (`left open: <uuid8> (unsaved)`) and the run ends with `leftOpen:` |
| `platforms` | 44 web, social and ad sizes (incl. TikTok, LinkedIn, Pinterest, YouTube and the 7 Google Display ad sizes) with safe zones, also available in scripts as `axiPlatform(key)` (offline) |
| `render <doc>` | Write a JPEG preview to `.affinity-axi/renders/` (`--spread`, `--selection`, `--out`) |
| `export <doc> <preset> <path>` | Export to a path under Desktop with a validated preset. Area: `--all-artboards` (path uses `{name}`), `--artboard`, `--selection`, `--spread`. Size: `--scale`, `--width`, `--height`, `--square`. AI-touched documents get a sidecar and IPTC metadata. Metadata: Affinity's account name is stripped from PNG (text chunks), JPEG (Exif, XMP and IPTC segments), WebP (XMP) and TIFF (EXIF, IPTC and XMP, needs `exiftool`); `--creator <name>` / `--copyright <text>` (or the brand kit's `credit`, `--brand`) embed your own credit with `exiftool`; `--keep-metadata` keeps Affinity's metadata (XMP; in JPEG also EXIF and IPTC) and cannot be combined with a credit. `--max-kb <n>` (with `--min-scale`) steps JPEG, WebP or PNG presets down, then the size, until the file fits. Each export prints an `alt:` stub built from the document's text, top-down (125 characters; `--no-alt` skips it), recorded in the manifest |
| `presets` | List this install's export preset names |
| `docs` / `docs read <file>` | List or read SDK docs (`--grep`, `--lines`, `--full`) |
| `hint search` / `hint add` | Ask Affinity's global hint pool / append a hint to the preamble |
| `library` / `library read` / `library save` | Affinity script library; `save` is idempotent and never overwrites |
| `setup hook` | Print the session-start command for your agent, or keep it in a JSON file with `--file <path> [--key hooks.SessionStart]` (`--check`, `--remove`). `setup hooks` is an alias. |

**Privacy.** Affinity by Canva writes the signed-in account name, edit history and dates into the XMP of whole-document PNG exports and into the EXIF, IPTC and XMP of JPEG exports. affinity-axi removes that metadata from PNG, JPEG, WebP and TIFF files it exports (a JPEG loses its Exif, XMP and IPTC segments; a TIFF needs `exiftool`; the colour profile and, for AI-touched documents, the IPTC AI label are kept), so client deliverables do not name the operator. PDFs are the exception: Author/Creator stay in the file, and `print` warns. Scripts that call `doc.export` themselves (for example under `run`) are not cleaned.

`<doc>` is `current`, a full session UUID or a unique prefix of 8 or more characters.

## Develop

```sh
npm test                 # build + unit tests against a fake MCP server (no Affinity needed)
npm run guide:gen        # regenerate docs/agent-guide.md (CI runs guide:check)
npm run smoke:live       # live smoke test; needs Affinity open
npx -y axi-axi validate "node bin/affinity-axi.js" --dir .
```

`src/mcp/` is the SSE transport, `src/affinity/` holds the AI guard, provenance log, outcome classifier and SDK snippets, `src/commands/` holds one module per command, and `test/fake-mcp/` is the fake server the tests use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the pull request checklist.

## License

MIT, see [LICENSE](LICENSE).
