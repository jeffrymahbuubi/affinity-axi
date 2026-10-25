// Canned wire facts for the fake Affinity MCP server, observed
// live (Affinity 3.3.1.4940). Values marked ASSUMED were not
// observed live; keep them in sync if the real server is probed later.

import type { DocInfo, ToolResult } from "../../src/mcp/types.js";

export const PROTOCOL_VERSION = "2025-11-25";
export const SERVER_INFO = { name: "Affinity", version: "1.0.0" };
export const INSTRUCTIONS = "You MUST read the 'preamble' documentation before using the SDK.";

export const GATE_TEXT = "The preamble documentation topic has not yet been read.";
export const SPREAD_OOB_TEXT = "Spread index out of bounds.";
export const BAD_UUID_TEXT = "No document with that Uuid exists.";

export function typeErrorText(expected: string, value: unknown): string {
  const actual = value === undefined || value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return `[json.exception.type_error.302] type must be ${expected}, but is ${actual}`;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string }>; required: string[] };
}

function tool(name: string, props: Record<string, string>, required: string[]): ToolDef {
  const properties: ToolDef["inputSchema"]["properties"] = {};
  for (const [k, t] of Object.entries(props)) properties[k] = { type: t };
  return { name, description: `fake ${name}`, inputSchema: { type: "object", properties, required } };
}

/** The 11 tools the server lists, with their argument names. */
export const TOOLS: ToolDef[] = [
  tool("execute_script", { script: "string" }, ["script"]),
  tool("read_sdk_documentation_topic", { filename: "string" }, ["filename"]),
  tool("list_sdk_documentation", {}, []),
  tool("render_spread", { document_session_uuid: "string", spread_index: "number" }, ["document_session_uuid", "spread_index"]),
  tool("render_selection", { document_session_uuid: "string" }, ["document_session_uuid"]),
  tool("search_sdk_hints", { prompt: "string" }, ["prompt"]),
  tool("add_sdk_hint", { hint: "string" }, ["hint"]),
  tool("list_library_scripts", {}, []),
  tool("read_library_script", { title: "string" }, ["title"]),
  tool("save_script_to_library", { title: "string", description: "string", code: "string" }, ["title", "description", "code"]),
  tool("report_sdk_issue", { description: "string", code: "string" }, ["description"]),
];

/** Stand-in for the 4176-char preamble; CRLF inside like the real one. */
export const PREAMBLE_TEXT = [
  "# Affinity SDK preamble (fake)",
  "Scripts return output only through console.log().",
  "Set the current spread before editing, unless it is already current.",
  "NOT_ALLOWED means an Affinity setting blocks AI, filesystem or network access.",
  "File I/O is limited to the user's Desktop.",
].join("\r\n");

/** Topic files served by read_sdk_documentation_topic (besides preamble). */
export const DOC_TOPICS: Record<string, string> = {
  "document.js": [
    "import { DocumentCommand } from './commands.js';",
    "export class Document {",
    "  static get all() { return []; }",
    "  static get current() { return null; }",
    "  export(path, options, a, b) { return true; }",
    "}",
    "export function export(doc) {}",
  ].join("\n"),
  "nodes.js": "export class Node {}\nexport class RectangleNode extends Node {}\n",
  "examples/rectangle.js": "const doc = Document.current;\nconsole.log(doc.title);\n",
  "tests/document.test.js": "test('doc', () => {});\n",
  "hints.json": "[]\n",
};

const LIVE_MODULES = [
  "application.js", "artboardinterface.js", "buffer.js", "collection.js", "colours.js", "commands.js",
  "unit.js", "vectorbrush.js", "visibilityinterface.js",
];
const LIVE_EXTRA_MODULES = Array.from({ length: 60 }, (_, i) => `module${String(i + 1).padStart(2, "0")}.js`);
const LIVE_EXAMPLES = Array.from({ length: 36 }, (_, i) => `examples/example${String(i + 1).padStart(2, "0")}.js`);
const LIVE_TESTS = Array.from({ length: 36 }, (_, i) => `tests/sample${String(i + 1).padStart(2, "0")}Tests.js`);
const LIVE_DATA = ["param_ranges.min.json", "struct_array_sizes.min.json", "struct_ranges.min.json"];

/** Every topic name list_sdk_documentation returns, in order (live shape: about 70/36/36/3). */
export const DOC_NAMES: string[] = [
  "preamble",
  ...Object.keys(DOC_TOPICS),
  ...LIVE_MODULES,
  ...LIVE_EXTRA_MODULES,
  ...LIVE_EXAMPLES,
  ...LIVE_TESTS,
  ...LIVE_DATA,
];

/**
 * list_sdk_documentation text as served. Live format (verified 2026-10-24): all names in one
 * comma-separated string with a trailing comma. A one-element array so the fake server's
 * join("\n") returns it unchanged.
 */
export const DOC_LIST: string[] = [DOC_NAMES.join(", ") + ","];

/** 12x16 baseline JFIF JPEG (SOF0), metadata stripped. */
export const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQABLAEsAAD/wAARCAAQAAwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAGBgYGBgYKBgYKDgoKCg4SDg4ODhIXEhISEhIXHBcXFxcXFxwcHBwcHBwcIiIiIiIiJycnJycsLCwsLCwsLCws/9sAQwEHBwcLCgsTCgoTLh8aHy4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4u/90ABAAB/9oADAMBAAIRAxEAPwD6igt47cOIyx3uXO5mbluuNxOB6AcCp6KKbd9WB//Z";
export const TINY_JPEG_SIZE = { width: 12, height: 16 };

export const FIXTURE_UUID = "70E876CB-C0FC-4AD0-8A8B-C51F7ECA5E4F";
export const FIXTURE_UUID_2 = "01E35352-1B2C-4D5E-8F90-A1B2C3D4E5F6";

/** Documents known to render_spread / render_selection: uuid -> spread count. */
export const FIXTURE_SPREADS: Record<string, number> = { [FIXTURE_UUID]: 1, [FIXTURE_UUID_2]: 2 };

/** Data for stubbing LIST_DOCUMENTS-style scripts via server.onScript(). */
export const FIXTURE_DOCS: DocInfo[] = [
  { uuid: FIXTURE_UUID, title: "<Untitled>", dirty: true, units: "Millimetre", path: "" },
  { uuid: FIXTURE_UUID_2, title: "logo.af", dirty: false, units: "Pixel", path: "/home/test/Desktop/logo.af" },
];

export const FIXTURE_APP = {
  version: "Affinity 3.3.1.4940 MacOS (Oct  6 2026)",
  desktop: "/home/test/Desktop",
};

/** Subset of FileExportOptions.allPresetNames. */
export const FIXTURE_PRESETS = [
  "PNG",
  "JPEG (High quality)",
  "SVG (digital - high quality)",
  "PDF (digital - high quality)",
  "WebP (Lossless, default)",
  "Canva Design",
];

export function text(t: string, isError = false): ToolResult {
  return { isError, content: [{ type: "text", text: t }] };
}

export function image(data = TINY_JPEG_B64): ToolResult {
  return { isError: false, content: [{ type: "image", mimeType: "image/jpeg", data }] };
}
