// Unit tests for src/affinity/*: AI guard, outcome classifier, SDK
// snippets, JPEG header and document references. No Affinity process needed.

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AI_IDENTIFIERS, scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { classify, resultText } from "../src/affinity/result.js";
import { APP_INFO, EXPORT, HOME_INFO, injectArgs, LIST_DOCUMENTS, LIST_PRESETS } from "../src/affinity/scripts.js";
import { jpegSize } from "../src/affinity/jpeg.js";
import { resolveDocRef } from "../src/affinity/docref.js";
import { AxiError, UsageError } from "../src/output/errors.js";
import type { ToolResult } from "../src/mcp/types.js";
import { FIXTURE_APP, FIXTURE_DOCS, FIXTURE_PRESETS, FIXTURE_UUID, FIXTURE_UUID_2, TINY_JPEG_B64, TINY_JPEG_SIZE } from "./fake-mcp/fixtures.js";

const txt = (text: string, isError = false): ToolResult => ({ isError, content: [{ type: "text", text }] });

describe("guard: scanForBlocking", () => {
  it("finds modal-prone calls with their lines", () => {
    const src = "a();\ndoc.close();\nd.closeAsync(cb);\nrequire(\"/dialog.js\");\n";
    expect(scanForBlocking(src)).toEqual([
      { identifier: "close()", line: 2 },
      { identifier: "closeAsync()", line: 3 },
      { identifier: "/dialog.js", line: 4 },
    ]);
  });

  it("does not flag non-calls or other modules", () => {
    expect(scanForBlocking("const closed = doc.closed;\nrequire('/document.js');\nclose();\n")).toEqual([]);
  });
});

describe("guard: scanForAi", () => {
  it("lists exactly the seven generative identifiers", () => {
    expect([...AI_IDENTIFIERS].sort()).toEqual(
      [
        "axiGenerativePatch",
        "createGenerateImage",
        "createGenerateImageCommand",
        "createGenerativeEditImage",
        "createGenerativeEditImageCommand",
        "generateImage",
        "generativeEditImage",
      ].sort(),
    );
  });

  it.each(AI_IDENTIFIERS.map((id) => [id]))("catches %s with its 1-based line", (id) => {
    const src = `const a = 1;\n\nfoo.${id}("x");\n`;
    expect(scanForAi(src)).toEqual([{ identifier: id, line: 3 }]);
  });

  it("catches a call on line 1", () => {
    expect(scanForAi('doc.generateImage("a cat")')).toEqual([{ identifier: "generateImage", line: 1 }]);
  });

  it("does not treat longer identifiers as hits", () => {
    expect(scanForAi("generateImageX(); xgenerateImage(); my$generateImage(); generateImage_2();")).toEqual([]);
    expect(scanForAi("createGenerateImageCommandFoo()")).toEqual([]);
  });

  it("does not hit the ML-assisted APIs allowed without the opt-in", () => {
    const allowed = [
      "removeBackground", "selectSubject", "detectDepth", "colourise",
      "createRemoveBackground", "createSelectSubject", "createDetectDepth", "createColourise",
      "createRemoveBackgroundCommand", "createSelectSubjectCommand", "createDetectDepthCommand", "createColouriseCommand",
      "createForCanvaExport", "createDenoiseFilter", "allowCodeGenerationFromStrings",
    ];
    expect(scanForAi(allowed.map((a) => `x.${a}();`).join("\n"))).toEqual([]);
  });

  it("refuses hits in comments and returns multiple hits sorted by line", () => {
    const src = [
      "// generativeEditImage is forbidden",
      "const x = 0;",
      "a.createGenerateImage(1); b.generateImage(2);",
      "/* createGenerativeEditImageCommand */",
    ].join("\n");
    expect(scanForAi(src)).toEqual([
      { identifier: "generativeEditImage", line: 1 },
      { identifier: "createGenerateImage", line: 3 },
      { identifier: "generateImage", line: 3 },
      { identifier: "createGenerativeEditImageCommand", line: 4 },
    ]);
  });

  it("counts CRLF lines correctly", () => {
    expect(scanForAi("a\r\nb\r\ndoc.generateImage()")).toEqual([{ identifier: "generateImage", line: 3 }]);
  });

  it("finds nothing in clean scripts", () => {
    expect(scanForAi("")).toEqual([]);
    expect(scanForAi("const doc = Document.current; console.log(doc.title);")).toEqual([]);
  });

  it("own SDK snippets are clean", () => {
    for (const s of [LIST_DOCUMENTS, LIST_PRESETS, APP_INFO, HOME_INFO, EXPORT("U", "PNG", "/p")]) {
      expect(scanForAi(s)).toEqual([]);
    }
  });
});

describe("result: classify", () => {
  it("resultText joins text contents and skips images", () => {
    const r: ToolResult = {
      isError: false,
      content: [
        { type: "text", text: "a" },
        { type: "image", mimeType: "image/jpeg", data: "zzz" },
        { type: "text", text: "b" },
      ],
    };
    expect(resultText(r)).toBe("a\nb");
  });

  it("classifies plain console output as ok", () => {
    expect(classify(txt("session ABC\nPNG ok\n"))).toEqual({ kind: "ok", text: "session ABC\nPNG ok\n" });
    expect(classify(txt(""))).toEqual({ kind: "ok", text: "" });
  });

  it("classifies an uncaught exception reported with isError:false", () => {
    expect(classify(txt("Error: boom\n    at main:1:7\n"))).toEqual({
      kind: "exception",
      error: "Error: boom",
      at: "main:1:7",
      text: "Error: boom\n    at main:1:7\n",
    });
    expect(classify(txt("TypeError: x is not a function\r\n    at main:3:1\r\n"))).toMatchObject({
      kind: "exception",
      error: "TypeError: x is not a function",
      at: "main:3:1",
    });
  });

  it("does not call an Error: line without a stack frame an exception", () => {
    expect(classify(txt("Error: just a log line\n")).kind).toBe("ok");
    expect(classify(txt("Error: logged\nnot a frame\n")).kind).toBe("ok");
  });

  it("finds a failure after earlier console.log output", () => {
    expect(classify(txt("session ABC\nError: boom\n    at main:9:3\n"))).toMatchObject({
      kind: "exception",
      error: "Error: boom",
      at: "main:9:3",
    });
    expect(classify(txt("step 1\nNOT_ALLOWED: network")).kind).toBe("not-allowed");
    expect(classify(txt("step 1\nERROR: bad preset")).kind).toBe("sdk-error");
  });

  it("classifies NOT_ALLOWED and ERROR: prefixes", () => {
    expect(classify(txt("NOT_ALLOWED: file access outside Desktop")).kind).toBe("not-allowed");
    expect(classify(txt("ERROR: preset not found")).kind).toBe("sdk-error");
  });

  it("classifies isError:true from the server as sdk-error", () => {
    expect(classify(txt("The preamble documentation topic has not yet been read.", true))).toEqual({
      kind: "sdk-error",
      text: "The preamble documentation topic has not yet been read.",
    });
    expect(classify(txt("NOT_ALLOWED blocked", true)).kind).toBe("not-allowed");
  });
});

describe("scripts: SDK snippets", () => {
  const markers: Array<[string, string]> = [
    [LIST_DOCUMENTS, "/* affinity-axi:list-documents */"],
    [LIST_PRESETS, "/* affinity-axi:list-presets */"],
    [APP_INFO, "/* affinity-axi:app-info */"],
    [HOME_INFO, "/* affinity-axi:home-info */"],
    [EXPORT("U", "PNG", "/p"), "/* affinity-axi:export */"],
  ];

  it.each(markers)("starts with its marker comment %#", (script, marker) => {
    expect(script.split("\n")[0]).toBe(marker);
  });

  it("marker substrings are distinct so fake onScript stubs cannot collide", () => {
    const set = new Set(markers.map(([, m]) => m));
    expect(set.size).toBe(markers.length);
  });

  it("uses the real SDK names", () => {
    const all = markers.map(([s]) => s).join("\n");
    for (const name of [
      "Document.all", "Document.current", "sessionUuid", "title", "isDirty", "units", "path",
      "Application.version", "Application.userDesktopPath",
      "FileExportOptions.allPresetNames", "FileExportOptions.createWithPresetName", "doc.export(",
    ]) {
      expect(all).toContain(name);
    }
  });

  // Run the snippets against a stub SDK to prove they parse and log the pinned JSON shapes.
  function run(script: string, docs = FIXTURE_DOCS, current: string | null = FIXTURE_UUID): { logs: string[]; exports: unknown[][] } {
    const logs: string[] = [];
    const exports: unknown[][] = [];
    const wrap = (d: (typeof FIXTURE_DOCS)[number]) => ({
      sessionUuid: d.uuid, title: d.title, isDirty: d.dirty, units: d.units, path: d.path,
      export: (...a: unknown[]) => { exports.push(a); },
    });
    const wrapped = docs.map(wrap);
    const modules: Record<string, unknown> = {
      "/document.js": {
        Document: { all: wrapped, current: wrapped.find((d) => d.sessionUuid === current) ?? null },
        FileExportOptions: {
          allPresetNames: FIXTURE_PRESETS,
          createWithPresetName: (p: string) => ({ preset: p }),
        },
      },
      "/application.js": { Application: { version: FIXTURE_APP.version, userDesktopPath: FIXTURE_APP.desktop } },
    };
    runInNewContext(`(function(){${script}\n})()`, {
      require: (m: string) => modules[m],
      console: { log: (s: string) => logs.push(s) },
    });
    return { logs, exports };
  }

  it("LIST_DOCUMENTS logs one JSON line {current, documents}", () => {
    const { logs } = run(LIST_DOCUMENTS);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0])).toEqual({ current: FIXTURE_UUID, documents: FIXTURE_DOCS });
    expect(JSON.parse(run(LIST_DOCUMENTS, FIXTURE_DOCS, null).logs[0]).current).toBeNull();
  });

  it("LIST_PRESETS logs a JSON string array", () => {
    expect(JSON.parse(run(LIST_PRESETS).logs[0])).toEqual(FIXTURE_PRESETS);
  });

  it("APP_INFO logs {version, desktop}", () => {
    expect(JSON.parse(run(APP_INFO).logs[0])).toEqual(FIXTURE_APP);
  });

  it("HOME_INFO logs version, desktop, current and documents in one line", () => {
    const out = JSON.parse(run(HOME_INFO).logs[0]);
    expect(out).toEqual({ ...FIXTURE_APP, current: FIXTURE_UUID, documents: FIXTURE_DOCS });
  });

  it("EXPORT JSON-stringifies hostile arguments and calls doc.export with a named preset", () => {
    const hostile = '/home/x/Desktop/a"b\'c\\d\n.svg';
    const script = EXPORT(FIXTURE_UUID_2, 'SVG "x"; throw 1', hostile);
    const { logs, exports } = run(script);
    expect(JSON.parse(logs[0])).toEqual({ exported: hostile });
    expect(exports).toEqual([[hostile, { preset: 'SVG "x"; throw 1' }, null, null]]);
  });

  it("EXPORT throws when the document is not open", () => {
    expect(() => run(EXPORT("NOPE", "PNG", "/p"))).toThrow(/No document with that Uuid/);
  });

  it("injectArgs prepends on line 1 without changing the line count", () => {
    const src = "/* m */\nconst x = ARGS.n;\nconsole.log(x);\nthrow new Error('boom');";
    const out = injectArgs(src, '{ "n": 3,\n "s": "a b" }');
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out.startsWith('const ARGS = {"n":3,"s":"a b"}; /* m */')).toBe(true);
    expect(out.split("\n").slice(1)).toEqual(src.split("\n").slice(1));
    const logs: unknown[] = [];
    runInNewContext(out.replace("throw new Error('boom');", ""), { console: { log: (v: unknown) => logs.push(v) } });
    expect(logs).toEqual([3]);
  });

  it("injectArgs keeps U+2028 inside strings on one physical line", () => {
    const out = injectArgs("x", JSON.stringify({ s: "a\u2028b" }));
    expect(out).not.toMatch(/[\u2028\u2029]/);
    expect(out.split(/\r\n|\r|\n/)).toHaveLength(1);
  });
});

describe("jpeg: jpegSize", () => {
  it("reads dimensions from the fixture baseline JPEG (SOF0)", () => {
    expect(jpegSize(Buffer.from(TINY_JPEG_B64, "base64"))).toEqual(TINY_JPEG_SIZE);
  });

  function jpegWithSof(marker: number, w: number, h: number): Buffer {
    const sof = Buffer.alloc(2 + 2 + 6 + 3);
    sof[0] = 0xff; sof[1] = marker;
    sof.writeUInt16BE(11, 2); // length
    sof[4] = 8;
    sof.writeUInt16BE(h, 5);
    sof.writeUInt16BE(w, 7);
    sof[9] = 1; // components
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  }

  it("reads progressive (SOF2) and large dimensions", () => {
    expect(jpegSize(jpegWithSof(0xc2, 724, 1024))).toEqual({ width: 724, height: 1024 });
    expect(jpegSize(jpegWithSof(0xc0, 1024, 576))).toEqual({ width: 1024, height: 576 });
  });

  it("returns null for non-JPEG, truncated or SOF-less data", () => {
    expect(jpegSize(Buffer.alloc(0))).toBeNull();
    expect(jpegSize(Buffer.from("not a jpeg at all"))).toBeNull();
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull(); // PNG magic
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull(); // SOI EOI
    expect(jpegSize(jpegWithSof(0xc0, 10, 10).subarray(0, 12))).toBeNull(); // truncated
    expect(jpegSize(Buffer.from(TINY_JPEG_B64, "base64").subarray(0, 20))).toBeNull();
  });
});

describe("docref: resolveDocRef", () => {
  const docs = FIXTURE_DOCS;
  const capture = (fn: () => unknown): AxiError => {
    try {
      fn();
    } catch (e) {
      return e as AxiError;
    }
    throw new Error("expected throw");
  };

  it("resolves a full UUID, case-insensitively", () => {
    expect(resolveDocRef(FIXTURE_UUID, docs, null)).toBe(docs[0]);
    expect(resolveDocRef(FIXTURE_UUID_2.toLowerCase(), docs, null)).toBe(docs[1]);
  });

  it("resolves a unique prefix of at least 8 characters", () => {
    expect(resolveDocRef("70E876CB", docs, null)).toBe(docs[0]);
    expect(resolveDocRef("01e35352-1b", docs, null)).toBe(docs[1]);
  });

  it("rejects a prefix shorter than 8 characters", () => {
    const e = capture(() => resolveDocRef("70E876C", docs, null));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.exitCode).toBe(2);
    expect(e.suggestion).toContain(FIXTURE_UUID);
  });

  it("reports an ambiguous prefix listing only the matches", () => {
    const twins = [
      { ...docs[0], uuid: "AAAAAAAA-0000-0000-0000-000000000001", title: "one" },
      { ...docs[0], uuid: "AAAAAAAA-0000-0000-0000-000000000002", title: "two" },
      { ...docs[1], uuid: "BBBBBBBB-0000-0000-0000-000000000003", title: "three" },
    ];
    const e = capture(() => resolveDocRef("AAAAAAAA", twins, null));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("ambiguous");
    expect(e.suggestion).toContain("AAAAAAAA-0000-0000-0000-000000000001 (one)");
    expect(e.suggestion).toContain("AAAAAAAA-0000-0000-0000-000000000002 (two)");
    expect(e.suggestion).not.toContain("BBBBBBBB");
    // a full UUID still resolves even though another shares its prefix
    expect(resolveDocRef("AAAAAAAA-0000-0000-0000-000000000002", twins, null).title).toBe("two");
  });

  it("reports no match with the open documents listed", () => {
    const e = capture(() => resolveDocRef("DEADBEEF", docs, null));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.exitCode).toBe(2);
    expect(e.suggestion).toContain(`${FIXTURE_UUID} (<Untitled>)`);
    expect(e.suggestion).toContain(`${FIXTURE_UUID_2} (logo.af)`);
  });

  it("resolves `current` through Document.current", () => {
    expect(resolveDocRef("current", docs, FIXTURE_UUID_2)).toBe(docs[1]);
    expect(resolveDocRef("CURRENT", docs, FIXTURE_UUID.toLowerCase())).toBe(docs[0]);
  });

  it("`current` with no focused document is exit 2 listing both documents", () => {
    const e = capture(() => resolveDocRef("current", docs, null));
    expect(e).toBeInstanceOf(UsageError);
    expect(e.exitCode).toBe(2);
    expect(e.suggestion).toContain(FIXTURE_UUID);
    expect(e.suggestion).toContain("<Untitled>");
    expect(e.suggestion).toContain(FIXTURE_UUID_2);
    expect(e.suggestion).toContain("logo.af");
  });

  it("handles no open documents", () => {
    expect(capture(() => resolveDocRef("current", [], null)).suggestion).toContain("no documents are open");
    expect(capture(() => resolveDocRef("70E876CB", [], null)).suggestion).toContain("no documents are open");
  });

  it("`current` pointing at a document missing from the list is an error, not a usage error", () => {
    const e = capture(() => resolveDocRef("current", docs, "FFFFFFFF-0000-0000-0000-000000000000"));
    expect(e).not.toBeInstanceOf(UsageError);
    expect(e.exitCode).toBe(1);
  });
});
