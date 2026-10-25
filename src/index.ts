import { dispatch, type Registry } from "./cli/router.js";
import { connect } from "./mcp/connect.js";
import { make as makeHome, rootHelp } from "./commands/home.js";
import { make as makeRun } from "./commands/run.js";
import { make as makeRender } from "./commands/render.js";
import { make as makeExport } from "./commands/export.js";
import { make as makeDocs } from "./commands/docs.js";
import { make as makeHint } from "./commands/hint.js";
import { make as makeSetup } from "./commands/setup.js";
import { make as makeLibrary } from "./commands/library.js";
import { make as makeFonts } from "./commands/fonts.js";
import { make as makeDoc } from "./commands/doc.js";
import { make as makeHelpers } from "./commands/helpers.js";
import { make as makeBatch } from "./commands/batch.js";
import { make as makeFill } from "./commands/fill.js";
import { make as makeWebassets } from "./commands/webassets.js";
import { make as makeBrand } from "./commands/brand.js";
import { make as makeTemplates } from "./commands/templates.js";
import { make as makePrint } from "./commands/print.js";
import { make as makeLint } from "./commands/lint.js";
import { make as makePlatforms } from "./commands/platforms.js";
import { make as makeInspect } from "./commands/inspect.js";
import { make as makeDocOpen } from "./commands/doc-open.js";
import { make as makeAssets } from "./commands/assets.js";
import { make as makeExamples } from "./commands/examples.js";

const exportCommands = makeExport(connect);

const registry: Registry = {
  tool: "affinity-axi",
  root: makeHome(connect),
  rootHelp,
  commands: {
    run: makeRun(connect),
    render: makeRender(connect),
    export: exportCommands.export,
    presets: exportCommands.presets,
    ...makeDocs(connect),
    ...makeHint(connect),
    "setup hook": makeSetup(connect),
    ...makeLibrary(connect),
    fonts: makeFonts(connect),
    ...makeDoc(connect),
    helpers: makeHelpers(connect),
    batch: makeBatch(connect),
    fill: makeFill(connect),
    webassets: makeWebassets(connect),
    ...makeBrand(connect),
    ...makeTemplates(connect),
    print: makePrint(connect),
    lint: makeLint(connect),
    platforms: makePlatforms(connect),
    inspect: makeInspect(connect),
    ...makeDocOpen(connect),
    ...makeAssets(connect),
    examples: makeExamples(connect),
  },
  aliases: {
    docs: "docs list",
    hint: "hint search",
    library: "library list",
    "setup hooks": "setup hook",
    brand: "brand list",
    templates: "templates list",
  },
};

const code = await dispatch(registry, process.argv.slice(2));
process.exit(code);
