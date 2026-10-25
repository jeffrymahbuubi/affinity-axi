// SDK snippets executed through execute_script. Each begins with a marker
// comment so tests can stub them via the fake server's onScript(substring, reply),
// and ends with one console.log of JSON (the only channel back from Affinity).
//
// Real SDK names only. Scripts load the SDK with
// require() the same way scripts/smoke-test.js does.
//
// The console.log calls inside these string constants are required output.

const DOC_REQUIRE = "const { Document, FileExportOptions } = require('/document.js');";
const APP_REQUIRE = "const { Application } = require('/application.js');";

const DOC_INFO_FN =
  "const docInfo = (d) => ({ uuid: String(d.sessionUuid), title: String(d.title), dirty: !!d.isDirty, units: String(d.units), path: String(d.path || '') });";

/** Logs {"current": string|null, "documents": DocInfo[]}. */
export const LIST_DOCUMENTS = [
  "/* affinity-axi:list-documents */",
  DOC_REQUIRE,
  DOC_INFO_FN,
  "const cur = Document.current;",
  "console.log(JSON.stringify({ current: cur ? String(cur.sessionUuid) : null, documents: Document.all.map(docInfo) }));",
].join("\n");

/** Logs a JSON string[] of FileExportOptions.allPresetNames. */
export const LIST_PRESETS = [
  "/* affinity-axi:list-presets */",
  DOC_REQUIRE,
  "console.log(JSON.stringify(Array.from(FileExportOptions.allPresetNames).map(String)));",
].join("\n");

/** Logs {"version": string, "desktop": string}. */
export const APP_INFO = [
  "/* affinity-axi:app-info */",
  APP_REQUIRE,
  "console.log(JSON.stringify({ version: String(Application.version), desktop: String(Application.userDesktopPath) }));",
].join("\n");

/** One script for the home view: {"version","desktop","current","documents"}. */
export const HOME_INFO = [
  "/* affinity-axi:home-info */",
  DOC_REQUIRE,
  APP_REQUIRE,
  DOC_INFO_FN,
  "const cur = Document.current;",
  "console.log(JSON.stringify({ version: String(Application.version), desktop: String(Application.userDesktopPath), current: cur ? String(cur.sessionUuid) : null, documents: Document.all.map(docInfo) }));",
].join("\n");

/** Exports a document with a named preset. Logs {"exported": path}. Arguments are JSON-stringified into the source. */
export function EXPORT(docUuid: string, preset: string, path: string): string {
  return [
    "/* affinity-axi:export */",
    DOC_REQUIRE,
    `const targetUuid = ${JSON.stringify(docUuid)};`,
    `const presetName = ${JSON.stringify(preset)};`,
    `const outPath = ${JSON.stringify(path)};`,
    "const doc = Document.all.find((d) => String(d.sessionUuid) === targetUuid);",
    "if (!doc) { throw new Error('No document with that Uuid exists.'); }",
    "doc.export(outPath, FileExportOptions.createWithPresetName(presetName), null, null);",
    "console.log(JSON.stringify({ exported: outPath }));",
  ].join("\n");
}

/**
 * Prepends `const ARGS = <json>;` to line 1 with no newline, so the line
 * count (and the `at main:L:C` positions Affinity reports) is unchanged.
 * `json` must parse (callers validate and report usage errors); it is
 * re-serialized compactly so the prefix is guaranteed to stay on one line.
 */
export function injectArgs(source: string, json: string): string {
  const compact = JSON.stringify(JSON.parse(json))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `const ARGS = ${compact}; ${source}`;
}
