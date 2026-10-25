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
  batch <template.js>,Run a template once per --data record (JSON/CSV) over one connection; save/close each doc (--save-dir; existing foreign .af files need --force)
  brand list,List brand kits: ./brand.json and ./brands/*.brand.json (offline)
  brand show [kit],"Print a kit's colours, fonts, type styles and contrast pairs (offline)"
  brand check [kit],"Check a kit against Affinity: fonts installed, logo readable under Desktop, contrast pairs"
  brand init <name>,"Write a starter kit ./brands/<name>.brand.json (--dir, --from)"
  webassets <doc>,"Website launch files from named artboards (mark, og, x-card): favicons, icon.svg, favicon.ico, OG/X cards, @1x/@2x PNG+WebP, head.html, with alt text in webassets.json and head.html (--out-dir, --responsive, --href, --theme, --no-favicons, --no-alt)"
  templates list,"Ready-made slot templates: name, size, slots (offline)"
  templates new <name>,"Build a template on a brand kit and save it as .af (--out, --brand, --args photo|rows), then fill it; --force overwrites a foreign or hand-edited .af"
  print <doc>,"Export a press PDF (default PDF/X-4; --out, --preset, --artboard, --cmyk) and preflight it offline: boxes, bleed, colour, fonts"
  fill <file.af>,"Fill a saved .af by slot name (slot:<key>) from --data (JSON/CSV); saves <key>.af per record in --out-dir (--key, --export, --all-artboards, --ignore-unknown, --continue-on-error, --limit); --force overwrites a foreign or hand-edited .af"
  platforms,"Web, social and ad sizes (IG, Stories, FB, OG, X, Discover, GBP, favicon, TikTok, LinkedIn, Pinterest, YouTube, Google Display ads) with safe zones (offline)"
  render <doc>,Render a spread or selection to a JPEG on disk and print its path
  export <doc> <preset> <path>,"Export under Desktop with a validated preset; --all-artboards, --artboard, --selection, --scale/--width/--height/--square; --max-kb steps preset then size until a file fits (JPEG, WebP, PNG); every export prints an alt-text stub (--no-alt to skip)"
  presets,List export preset names for this install
  docs,List SDK documentation topics grouped by kind
  docs read <file>,"Read a topic, narrowed with --grep or --lines"
  hint search <prompt>,Search Affinity's SDK hints
  hint add <text>,Record a new SDK hint
  library list,List scripts in Affinity's script library
  library read <title>,"Read a library script, optionally to a file"
  library save <file>,Save a script to the library under a new title
  setup hook,"Print the session-start hook command, or keep it in a JSON file with --file (--check, --remove, --key)"
```

## Rules

- Scripts run by path: edit the file, then `run` it. Never paste script bodies into tool calls.
- `--args` and `--brand` prepend `const ARGS = …;` and `const AXI_BRAND = …;` to line 1 of the script, so do not declare those names yourself; a `"use strict";` in the script is then no longer a directive, so do not rely on strict mode.
- Renders are written to `.affinity-axi/renders/` and only the path is printed; open the image only when you need to look at it.
- `<doc>` is a full session UUID, a unique prefix of at least 8 characters, or `current`.
- Affinity can only read and write under the Desktop folder (`filesystem: desktop-only`), and never inside a hidden (dot-prefixed) folder such as `.affinity-axi/`; both are checked before anything runs, a hidden path even before connecting.
- `ai: generative opt-in (--allow-generative); ml allowed`: ML features (`axiRemoveBackground`, `axiSelectSubject`, `axiDetectDepth`, `axiColourise`, or `doc.removeBackground()` etc.) always work and are the default for photo work; they only act on pixel layers, so place photos with `axiImage`.
- Generative Canva AI (`generateImage`, `generativeEditImage` and their `create…`/`…Command` forms) is refused by default. Opt in with `run <file> --allow-generative` for that one run only; it spends the user's Canva AI credits, so use it only when the user wants generated imagery (a texture, a background, an image edit) and manual drawing or ML will not do. Make one call per need, with a short neutral prompt in `--args`, and never loop it.
- Provenance is automatic: a run that really uses a generative API appends a line to `.affinity-axi/provenance.jsonl` (time, script, sha256, `--args`, outcome, document UUIDs) and prints `provenance: logged (ai-generated)`. Print `doc.sessionUuid` in the script so the document is tagged exactly. `export` of such a document prints `provenance: ai-generated` and writes `<file>.provenance.json`; use it to label posts and ads as AI-generated (Meta AI disclosure). Never delete or edit the log.
- Generative calls need Affinity's "Use Canva AI Studio features" setting ON (and a Canva AI subscription). A `NOT_ALLOWED` result means the setting is off: ask the user to turn it on, do not retry.
- `library save` applies the same refusal and the same `--allow-generative` opt-in; it runs nothing and logs nothing.
- Export preset names are localized per install; run `presets` instead of guessing.
- Pick fonts by exact postscript name from `fonts --grep <name>`; family and weight names are unreliable for variable fonts.
- Prefer `run --with-helpers` and the `axi*` helpers (`helpers` lists them) over hand-written SDK plumbing for text, shapes and colours.
- QR codes are native (`axiQR`); never embed a QR image from elsewhere. Keep dark modules on a light ground (4:1 or better); a warning is logged when they are close. Wi-Fi codes take `encryption: 'wpa'|'wep'|'none'`.
- Logos and favicons: outline text before SVG export (`axiOutline`) and build marks with `axiBool`; export with `SVG (for export)`. In `axiBool` subtract, the lowest shape in the stack is kept and the ones above it are cut out, whatever the ref order.
- Compose once: `axiVariants` or `axiAdapt`, then `export --all-artboards`. `axiAdapt` defaults to `anchor` (the background stretches, a logo or CTA keeps its edge distance, a centred headline stays centred, text is never resized); `fit` and `cover` scale uniformly.
- Carousels: `axiCarousel` then `export --all-artboards`; keep all slides one ratio. `axiCarouselSplit` cuts a wide panorama board across the slides.
- Hand-tuned layouts: name the fillable elements `slot:<key>` in the Layers panel, save the .af, then `fill <file.af> --data …`; other names are never touched. A text slot takes `{"text": …, "fill": "#hex"}` (or `colour`) to change its colour; a plain string is always text, so CSV cannot change a text colour. Replacing text keeps the slot's first-run font, size and colour.
- Stat posts: `axiBars`, `axiDonut`, `axiProgress`; pass colours explicitly. Donut slices start at 12 o'clock and run clockwise; `axiProgress` max defaults to 1, so pass `max: 100` for percentages.
- Website launch files: name artboards `mark`, `og`, `x-card` and run `webassets <doc> --out-dir <dir>`; the mark must be square, and fill the mark artboard so the apple-touch icon is not transparent.
- Brand kits are per project: `brand init <name>`, then run scripts with `--brand <kit>` (also on `batch` and `fill`) and use `axiToken('colours.ink')` and `axiType(doc, 'h1', …)`. Never hard-code a client's colours in a script. The kit is recorded in the manifest, and `doc info` prints `brand:`.
- Seals and stamps: `axiSeal`; text on a circle alone: `axiArcText` (`side: 'bottom'` reads the right way up under the circle).
- Named helpers edit elements on any spread: they switch the current spread for the edit, then put it (and the selection) back.
- Several series: `axiGroupedBars`, `axiStackedBars` (`percent: true` for shares), `axiLine` (`dots`, `grid`), with `axiLegend`. Series are `{name, values, colour}`; values are non-negative.
- Backgrounds: `axiPattern` repeats a motif over a clipped grid (keep it under the content); `axiPatternSeam` on the returned frame reports the wrap seam (0 means seamless).
- Start from a template: `templates new ig-post --out post.af --brand <kit>`, then `fill post.af --data …`; templates take every colour and font from the kit.
- Print: create the document with `axiPrintDoc({w, h, unit: 'mm', bleed: 3, cmyk: true})` (the bleed is in the document's units) and draw backgrounds out to the bleed. The PDF/X presets export the trim area only; use `print --preset "PDF (press ready)"` to keep the bleed. Crop marks are for proofs (`axiPrintSheet`).
- Run `lint <doc> --platform <key> --brand <kit>` before `export`; fix errors, read warnings. Contrast is checked against the solid fill below the text, so text over photos and gradients is skipped.
- Ad platforms cap file size (Google Display 150 KB): `export <doc> "JPEG (High quality)" <path> --artboard <name> --max-kb 150` steps the preset, then the size down to `--min-scale` (default 0.5), and exits 1 when nothing fits. Every export prints an `alt:` stub from the document's text; edit it before publishing.
- Tables: `axiTable(rows, opts)` builds a native table with equal columns and an optional styled header row.
- Reuse one working document per project: create it once, then edit it by UUID on later runs. Do not create a new document on every run.
- Never close an unsaved document from a script. The SDK has no discard option, so the save prompt blocks Affinity and can hang it. To clean up, use `doc save <doc> <path.af>` then `doc close <doc>`. `run` refuses `close()`, `closeAsync()` and `/dialog.js` unless you pass `--allow-blocking`.
- A .af on disk is overwritten only when affinity-axi saved it and its manifest is fresh. A hand-edited file (stale manifest) or a file affinity-axi never saved (no manifest) is refused by `doc save`, `batch --save-dir`, `fill --out-dir` and `templates new --out`; pass `--force` to replace it, or `doc open` it to work on it. Saving a document back to its own path needs no flag.
- If `run` times out, Affinity may be waiting on a dialog. Check the app before retrying, and do not re-run the same script.

Every command supports `--help`. Exit codes: 0 success/no-op, 1 error, 2 usage error. All output is TOON on stdout.
