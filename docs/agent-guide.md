# affinity-axi usage guide

drive Affinity by Canva through its MCP server: scripts by path, renders to disk, ML helpers, generative AI opt-in per run (built against AXI spec axi/1.0-2026-07). It is for any coding agent that has a shell. Affinity must be running with Settings > Model Context Protocol > Enable MCP server turned on. Install once with `npm link` from this directory.

## Home view

Run `affinity-axi` with no arguments for live state. Shape (values in angle brackets are live):

```
affinity: connected
url: http://[::1]:6767
version: <version>
documents[1]{uuid,title,dirty,units}:
  <uuid>,<title>,<true|false>,<units>
filesystem: desktop-only
ai: generative opt-in (--allow-generative); ml allowed
help[3]:
  affinity-axi run scripts/<script>.js
  affinity-axi render <uuid8>
  affinity-axi docs
```

## Commands

```
commands[35]{command,summary}:
  run <file.js>,Run a script from disk; prints status and truncated console output (--with-helpers adds axi* SDK helpers; --allow-generative opts in to generative AI for that run; --brand <kit> injects a brand kit as AXI_BRAND)
  helpers,List the axi* script helpers that run --with-helpers appends (offline)
  doc new,"Create a document (--width, --height, --units px|mm|pt, --dpi)"
  doc save <doc> <path.af>,Save a document under Desktop; leaves it clean. Never overwrites a .af that was hand-edited or that affinity-axi did not save (--force)
  doc open <path.af>,Reopen a saved asset; reports manifest freshness (fresh/stale/none) and named elements
  doc info <path.af>,"Offline asset summary from its manifest: made by, history, exports, staleness"
  doc note <path.af> <text>,Add a note to an asset's manifest (offline)
  inspect <doc>,"Layer tree: path, type, name, box, text, font, fill (--named, --artboard, --depth, --out)"
  lint <doc>,"Design checks before export: contrast, safe zone, minimum font, slot: names, off-kit colours with --brand (exit 1 on errors)"
  examples [id],"Every feature's example: commands, sample output and images (offline; --run regenerates one live)"
  assets,"Find saved assets (manifests) under a folder, newest first (offline)"
  doc close <doc>,Close a clean document; refuses unsaved ones (the SDK cannot discard)
  fonts,"List installed fonts with exact postscript names (--grep, --family)"
  batch <template.js>,Run a template once per --data record (JSON/CSV) over one connection; save/close each doc (--save-dir; existing foreign .af files need --force); --out-dir rasters the template wrote are stripped of Affinity's XMP (credit from the kit)
  brand list,List brand kits: ./brand.json and ./brands/*.brand.json (offline)
  brand show [kit],"Print a kit's colours, fonts, type styles, contrast pairs and credit (offline)"
  brand check [kit],"Check a kit against Affinity: fonts installed, logo readable under Desktop, contrast pairs"
  brand init <name>,"Write a starter kit ./brands/<name>.brand.json (--dir, --from)"
  webassets <doc>,"Website launch files from named artboards (mark, og, x-card): favicons, icon.svg, favicon.ico, OG/X cards, @1x/@2x PNG+WebP, head.html, with alt text in webassets.json and head.html (--out-dir, --responsive, --href, --theme, --no-favicons, --no-alt); images are stripped of Affinity's XMP"
  templates list,"Ready-made slot templates: name, size, slots (offline)"
  templates new <name>,"Build a template on a brand kit and save it as .af (--out, --brand, --args photo|rows), then fill it; --force overwrites a foreign or hand-edited .af"
  print <doc>,"Export a press PDF (default PDF/X-4; --out, --preset, --artboard, --cmyk) and preflight it offline: boxes, bleed, colour, fonts; warns when Affinity's Author/Creator are in the PDF (PDFs are not stripped)"
  fill <file.af>,"Fill a saved .af by slot name (slot:<key>) from --data (JSON/CSV); saves <key>.af per record in --out-dir (--key, --export, --all-artboards, --ignore-unknown, --continue-on-error, --limit); --force overwrites a foreign or hand-edited .af; exports are stripped of Affinity's XMP and carry the kit's credit when set"
  platforms,"Web, social and ad sizes (IG, Stories, FB, OG, X, Discover, GBP, favicon, TikTok, LinkedIn, Pinterest, YouTube, Google Display ads) with safe zones (offline)"
  render <doc>,Render a spread or selection to a JPEG on disk and print its path
  export <doc> <preset> <path>,"Export under Desktop with a validated preset; --all-artboards, --artboard, --selection, --scale/--width/--height/--square; --max-kb steps preset then size until a file fits (JPEG, WebP, PNG); every export prints an alt-text stub (--no-alt to skip); strips Affinity's XMP (account name) from PNG/JPEG/WebP, --creator/--copyright or the kit's credit embed yours, --keep-metadata keeps Affinity's"
  presets,List export preset names for this install
  docs,List SDK documentation topics grouped by kind
  docs read <file>,"Read a topic, narrowed with --grep or --lines"
  hint search <prompt>,Ask the global hint pool (a reworded answer)
  hint add <text>,Append a hint to this install's preamble
  library list,List scripts in Affinity's script library
  library read <title>,"Read a library script, optionally to a file"
  library save <file>,Save a script to the library under a new title
  setup hook,"Print the session-start hook command, or keep it in a JSON file with --file (--check, --remove, --key)"
```

## Rules

- Scripts run by path: edit the file, then `run` it. Never paste script bodies into tool calls.
- `--args` and `--brand` prepend `const ARGS = …;` and `const AXI_BRAND = …;` to line 1 of the script, so do not declare those names yourself; a `"use strict";` in the script is then no longer a directive, so do not rely on strict mode.
- Renders are written to `.affinity-axi/renders/` and only the path is printed; open the image only when you need to look at it.
- `<doc>` is a full session UUID or a unique prefix of at least 8 characters; `current` is accepted but address documents by UUID (print `doc.sessionUuid`), because the current document changes when the user clicks.
- Affinity can only read and write under the Desktop folder (`filesystem: desktop-only`), and never inside a hidden (dot-prefixed) folder such as `.affinity-axi/`; both are checked before anything runs, a hidden path even before connecting.
- `ai: generative opt-in (--allow-generative); ml allowed`: ML features (`axiRemoveBackground`, `axiSelectSubject`, `axiDetectDepth`, `axiColourise`, or `doc.removeBackground()` etc.) always work and are the default for photo work; they only act on pixel layers, so place photos with `axiImage`. Affinity needs an internet connection for every command (offline it refuses even the first request), and whether the ML models run on-device is not known.
- Cut-outs: `axiCutout(doc, node)` (ML background removal in place) or `{method: 'subject'}` (select subject, delete the rest, clear the selection); it makes the document transparent unless `transparent: false`. `axiSelectSubject` only sets the pixel selection and throws when nothing is found; `axiDeselect` clears it. Both cut-out methods throw when nothing was removed or found (`nothing was removed (no subject found)`); `allowEmpty: true` keeps the photo instead. `axiColourise` refuses a photo that is already in colour (mean saturation above 0.05, read from its pixels); `{force: true}` overrides. A cut-out keeps the subject where it was in the photo; `align: 'centre'` re-centres it in its picture frame (or `box`, or where the photo was), `align: 'fit'` also scales it (up or down) to fit minus `padding` px; `axiAlignIn` does the same for any pixel layer and `axiContentBox` measures its visible content. For a new cut-out, sticker or logo document use `axiDoc(w, h, 72, {transparent: true})` or `doc new --transparent`, or `axiTransparent(doc)` on an open one: a plain document is white and its PNG export has no alpha.
- `axiDetectDepth` keeps the photo: it returns a hidden `<name>-depth` copy (near = white); `{inPlace: true}` overwrites the layer as before.
- `axiDepthBlur(doc, photo, depth?, {radius})` blurs the far part of a photo from its depth map (near stays sharp, soft falloff; radius defaults to 14). It is destructive on the photo layer's pixels, so duplicate the photo first to keep the original, and expect softened outer edges on a small tile. Without `depth` it makes the hidden `<name>-depth` copy itself; it returns `{photo, depth}` and clears the pixel selection.
- `fill` picture slots take `{"image": "photo.jpg", "cutout": true}` (or `"subject"`) and `"colourise": true`; ML runs on the placed photo, about 10 s each, so raise `--timeout` for many photos. With `cutout` the subject is centred in the frame (`"align": "centre"` by default); `"align": "fit"` scales it to the frame minus `"padding"` px, `"none"` leaves it where it was. CSV cannot request ML. Picture slots accept png, jpg, jpeg, webp, heic, heif, tif and tiff; JPEG/TIFF EXIF orientation is applied (rotate HEIC photos first). A colour photo in a `colourise` slot, or a photo with no subject in a `cutout` slot, fails that record with the message.
- Generative Canva AI (`generateImage`, `generativeEditImage` and their `create…`/`…Command` forms) is refused by default. Opt in with `run <file> --allow-generative` for that one run only; it spends the user's Canva AI credits, so use it only when the user wants generated imagery (a texture, a background, an image edit) and manual drawing or ML will not do. Make one call per need, with a short neutral prompt in `--args`, and never loop it.
- Provenance is automatic: a run that really uses a generative API appends a line to `.affinity-axi/provenance.jsonl` (time, script, sha256, `--args`, outcome, document UUIDs) and prints `provenance: logged (ai-generated)`. Print `doc.sessionUuid` in the script so the document is tagged exactly. `export` of such a document prints `provenance: ai-generated` and writes `<file>.provenance.json`; use it to label posts and ads as AI-generated (Meta AI disclosure). Never delete or edit the log.
- Export metadata: Affinity stamps the signed-in account name into whole-document exports: the XMP `dc:creator` (plus history and dates) of PNGs, and the EXIF Artist, IPTC By-line and XMP of JPEGs. `export`, `fill --export`, `webassets` and `batch --out-dir` strip it by default: PNG text chunks are dropped; a JPEG loses its Exif, XMP, IPTC and comment segments (done in Node, no exiftool needed); a WebP loses an XMP packet if present; a TIFF has its EXIF Artist/Copyright, IPTC By-line/CopyrightNotice and XMP deleted by exiftool (left untouched, with a `metadata:` line, when exiftool is missing). The colour profile (ICC) and, for AI-touched documents, the IPTC AI label survive. To credit yourself pass `--creator <name>` and `--copyright <text>` on `export`, or put `"credit": {"creator": …, "copyright": …}` in the brand kit (used by `export`, `fill` and `batch`; flags win, `--creator ""` means no credit); embedding needs `exiftool`, and without it a PNG or JPEG is still stripped and a `metadata:` line says the credit was not written. `--keep-metadata` keeps Affinity's XMP (in a JPEG also its EXIF and IPTC); it cannot be combined with `--creator`/`--copyright`, and a brand-kit credit is ignored under it. `export` prints a `metadata:` line only when something was embedded, kept or could not be done; `batch --out-dir` prints `cleaned: <n>`. PDFs are not stripped: `print` warns when the PDF carries Affinity's Author/Creator (a PDF rewrite tool is needed to remove it). Scripts that call `doc.export` themselves, including under `run`, keep the stamp; export through the CLI commands, or write into `batch --out-dir` (top level only).
- Generative calls need Affinity's "Use Canva AI Studio features" setting ON (and a Canva AI subscription). A `NOT_ALLOWED` result means the setting is off: ask the user to turn it on, do not retry.
- `library save` applies the same refusal and the same `--allow-generative` opt-in; it runs nothing and logs nothing.
- Export preset names are localized per install; run `presets` instead of guessing.
- Pick fonts by exact postscript name from `fonts --grep <name>`; family and weight names are unreliable for variable fonts.
- Prefer `run --with-helpers` and the `axi*` helpers (`helpers` lists them) over hand-written SDK plumbing for text, shapes and colours.
- QR codes are native (`axiQR`); never embed a QR image from elsewhere. Keep dark modules on a light ground (4:1 or better); a warning is logged when they are close. Wi-Fi codes take `encryption: 'wpa'|'wep'|'none'`.
- Logos and favicons: outline text before SVG export (`axiOutline`) and build marks with `axiBool`; export with `SVG (for export)`. In `axiBool` subtract, the lowest shape in the stack is kept and the ones above it are cut out, whatever the ref order.
- Compose once: `axiVariants` or `axiAdapt`, then `export --all-artboards`. `axiAdapt` defaults to `anchor` (the background stretches, a logo or CTA keeps its edge distance, a centred headline stays centred, text is never resized); `fit` and `cover` scale uniformly.
- Carousels: `axiCarousel` then `export --all-artboards`; keep all slides one ratio. `axiCarouselSplit` cuts a wide panorama board across the slides.
- Hand-tuned layouts: name the fillable elements `slot:<key>` in the Layers panel, save the .af, then `fill <file.af> --data …`; other names are never touched. A text slot takes `{"text": …, "fill": "#hex"}` (or `colour`) to change its colour; a plain string is always text, so CSV cannot change a text colour. Replacing text keeps the slot's first-run font, size, colour and paragraph alignment (right/centre text re-flows about its anchor; old templates made before 0.3 keep a left anchor: re-make them); an empty value keeps the style (it writes a zero-width space). Text that no longer fits shrinks, down to half its size, and the row note says so: `text shrunk from 64 to 40 px to fit its 400x121 frame`, or at the floor `(the floor); still runs 50 px into the right margin of ig-post` / `still runs N px past the right edge of <board>` (shorten the text or use a frame-text slot). A failed record is undone and its document closed, so `--continue-on-error` carries on and the note starts with the real error; when undo cannot clean the document, `fill` saves it to `<out-dir>/_failed/<key>-<uuid8>.af` and closes it (`failedCopies:` line; delete the folder when done).
- Stat posts: `axiBars`, `axiDonut`, `axiProgress`; pass colours explicitly. Donut slices start at 12 o'clock and run clockwise; `axiProgress` max defaults to 1, so pass `max: 100` for percentages.
- Website launch files: name artboards `mark`, `og`, `x-card` and run `webassets <doc> --out-dir <dir>`; the mark must be square, and fill the mark artboard so the apple-touch icon is not transparent.
- Brand kits are per project: `brand init <name>`, then run scripts with `--brand <kit>` (also on `batch` and `fill`) and use `axiToken('colours.ink')` and `axiType(doc, 'h1', …)`. Never hard-code a client's colours in a script. The kit is recorded in the manifest, and `doc info` prints `brand:`.
- Seals and stamps: `axiSeal`; text on a circle alone: `axiArcText` (`side: 'bottom'` reads the right way up under the circle).
- Named helpers edit elements on any spread: they switch the current spread for the edit, then put it (and the selection) back.
- Several series: `axiGroupedBars`, `axiStackedBars` (`percent: true` for shares), `axiLine` (`dots`, `grid`), with `axiLegend`. Series are `{name, values, colour}`; values are non-negative.
- Backgrounds: `axiPattern` repeats a motif over a clipped grid (keep it under the content); `axiPatternSeam` on the returned frame reports the wrap seam (0 means seamless).
- Start from a template: `templates new ig-post --out post.af --brand <kit>`, then `fill post.af --data …`; templates take every colour and font from the kit.
- Print: create the document with `axiPrintDoc({w, h, unit: 'mm', bleed: 3, cmyk: true})` (the bleed is in the document's units) and draw backgrounds out to the bleed. The PDF/X presets export the trim area only; use `print --preset "PDF (press ready)"` to keep the bleed. Crop marks are for proofs (`axiPrintSheet`).
- Run `lint <doc> --platform <key> --brand <kit>` before `export`; fix errors, read warnings. Contrast is checked against the solid fill below the text, so text over photos (image or pixel layers) and gradients is skipped. Text off its artboard (or off the page) is an error (`off-board`). `--min-font` is in px at 72 dpi and scales with the document dpi (`below the 83 px minimum at 300 dpi`).
- Ad platforms cap file size (Google Display 150 KB): `export <doc> "JPEG (High quality)" <path> --artboard <name> --max-kb 150` steps the preset, then the size down to `--min-scale` (default 0.5), and exits 1 when nothing fits. Every export prints an `alt:` stub from the document's text; edit it before publishing.
- Print and CMYK: place photos and run ML helpers while the document is RGB, then convert (`doc.format = CMYKA8` or `print --cmyk`, which converts at the end); in a CMYK document `axiImage` and the ML helpers refuse with a message. Brand-kit sizes are px at any dpi: in a 300 dpi print document multiply by dpi/72 (`h1` 64 px is about 15 pt there) or size text in mm with `axiMm`.
- Multi-page documents: Affinity names a whole-document or `--spread N` export per page (`<name>_<page>.png`); `export` renames a single page file to the path you gave and otherwise lists and cleans every page file. Artboards cannot be added to a multi-page document.
- Tables: `axiTable(rows, opts)` builds a native table with equal columns and an optional styled header row; `padding` (default 12 px, `0` for the old tight look) indents every cell line and steps down by 2 px when the content would widen the table past its width.
- Reuse one working document per project: create it once, then edit it by UUID on later runs. Do not create a new document on every run.
- Never close an unsaved document from a script. The SDK has no discard option, so the save prompt blocks Affinity and can hang it. To clean up, use `doc save <doc> <path.af>` then `doc close <doc>`. `run` refuses `close()`, `closeAsync()` and `/dialog.js` unless you pass `--allow-blocking`.
- A .af on disk is overwritten only when affinity-axi saved it and its manifest is fresh. A hand-edited file (stale manifest) or a file affinity-axi never saved (no manifest) is refused by `doc save`, `batch --save-dir`, `fill --out-dir` and `templates new --out`; pass `--force` to replace it, or `doc open` it to work on it. Saving a document back to its own path needs no flag.
- If `run` times out, the CLI asks Affinity to cancel, but Affinity finishes the script anyway (verified live): it may still create or change documents after the timeout, or be waiting on a dialog. Check the home view and the app before retrying, and do not re-run the same script. A run is logged against the documents it prints or names in `--args` (the current document only as a fallback).

Every command supports `--help`. Exit codes: 0 success/no-op, 1 error, 2 usage error. All output is TOON on stdout.
