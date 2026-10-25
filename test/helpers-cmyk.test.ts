// CMYK guards (helpers-image.ts, helpers-ml.ts): axiImage/axiReplaceImage refuse a
// CMYK document before any SDK edit, and every ML helper (through axiPick) refuses one
// before touching the selection. The helper source is evaluated in plain Node with a
// fake `require` and a fake document, like the other helper tests.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { IMAGE_SOURCE } from "../src/affinity/helpers-image.js";
import { ML_SOURCE } from "../src/affinity/helpers-ml.js";
import { fakeDoc, load, type Fn } from "./helpers-ml-fake.js";

const IMAGE_MSG = /axiImage: cannot place a picture in a CMYK document; place it while the document is RGB, then convert \(doc\.format = CMYKA8 or print --cmyk\)/;
const ML_MSG = /ML needs an RGB document; run ML before converting to CMYK \(print --cmyk converts at the end\)/;

/** Enum stand-in: RasterFormat members are numbers in the SDK. */
const FORMATS = { RGBA8: 1, CMYKA8: 7, CMYK16: 9 };

/** Image helpers against a fake SDK that logs the calls that would edit the document. */
function loadImage(log: string[]): Record<string, Fn> {
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const modules: Record<string, unknown> = {
    "/rasterobject.js": { RasterFormat: FORMATS, Bitmap: { loadFromFile: () => (log.push("bitmap:load"), { width: 1, height: 1 }) } },
    "/commands.js": { DocumentCommand: {} },
    "/nodes.js": { ImageNodeDefinition: { create: () => (log.push("nodes:create"), {}) } },
    "/geometry.js": { Transform: {} },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    log.push(`require:${id}`);
    return modules[id];
  };
  return new Function("require", `${HELPERS_SOURCE}\nreturn { ${names.join(", ")} };`)(req) as Record<string, Fn>;
}

function imageDoc(log: string[], format: unknown) {
  const doc: any = {
    addNode: () => log.push("addNode"),
    executeCommand: () => log.push("executeCommand"),
    deleteSelection: () => log.push("deleteSelection"),
    get selection() {
      return { nodes: { first: null } };
    },
    set selection(_v: unknown) {
      log.push("select");
    },
  };
  if (format === "throw") {
    Object.defineProperty(doc, "format", {
      get: () => {
        throw new Error("no format");
      },
    });
  } else if (format !== "absent") {
    doc.format = format;
  }
  return doc;
}

const edits = (log: string[]) => log.filter((l) => !l.startsWith("require:"));

describe("axiImage and axiReplaceImage on a CMYK document", () => {
  it("axiImage throws the message before any SDK edit (enum member)", () => {
    const log: string[] = [];
    const h = loadImage(log);
    expect(() => h.axiImage!(imageDoc(log, FORMATS.CMYKA8), { path: "x.png" })).toThrow(IMAGE_MSG);
    expect(edits(log)).toEqual([]);
  });

  it("recognises other CMYK members and a CMYK string", () => {
    for (const fmt of [FORMATS.CMYK16, "CMYKA8", "RasterFormat.CMYK8"]) {
      const log: string[] = [];
      const h = loadImage(log);
      expect(() => h.axiImage!(imageDoc(log, fmt), { path: "x.png" })).toThrow(IMAGE_MSG);
      expect(edits(log)).toEqual([]);
    }
  });

  it("axiReplaceImage throws with its own name, before loading the file or selecting", () => {
    const log: string[] = [];
    const h = loadImage(log);
    expect(() => h.axiReplaceImage!(imageDoc(log, FORMATS.CMYKA8), {}, "x.png")).toThrow(/axiReplaceImage: cannot place a picture in a CMYK document/);
    expect(edits(log)).toEqual([]);
  });

  it("leaves an RGB document alone: the guard passes and placing goes on", () => {
    const log: string[] = [];
    const h = loadImage(log);
    let err: unknown = null;
    try {
      h.axiImage!(imageDoc(log, FORMATS.RGBA8), { path: "x.png" });
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toMatch(/CMYK/);
    expect(log).toContain("require:/nodes.js");
  });

  it("does not block when doc.format is missing or its read throws", () => {
    for (const fmt of ["absent", "throw"]) {
      const log: string[] = [];
      const h = loadImage(log);
      let err: unknown = null;
      try {
        h.axiImage!(imageDoc(log, fmt), { path: "x.png" });
      } catch (e) {
        err = e;
      }
      expect(String(err)).not.toMatch(/CMYK/);
      expect(log).toContain("require:/nodes.js");
    }
  });
});

describe("ML helpers on a CMYK document", () => {
  const cmykDoc = (format: unknown) => {
    const f = fakeDoc();
    Object.defineProperty(f.doc, "format", { value: format, configurable: true });
    return f;
  };
  const noRequires = (log: string[]) => log.filter((l) => !l.startsWith("require:"));

  it("every ML helper throws before any selection or ML call", () => {
    const cases: Array<[string, (h: Record<string, Fn>, d: any, n: any) => unknown]> = [
      ["axiCutout", (h, d, n) => h.axiCutout!(d, n)],
      ["axiSelectSubject", (h, d, n) => h.axiCutout!(d, n, { method: "subject" })],
      ["axiCutout", (h, d, n) => h.axiCutout!(d, n, { align: "centre" })],
      ["axiRemoveBackground", (h, d, n) => h.axiRemoveBackground!(d, n)],
      ["axiColourise", (h, d, n) => h.axiColourise!(d, n)],
      ["axiDetectDepth", (h, d, n) => h.axiDetectDepth!(d, n)],
      ["axiSelectSubject", (h, d, n) => h.axiSelectSubject!(d, n)],
      ["axiDepthBlur", (h, d, n) => h.axiDepthBlur!(d, n)],
    ];
    for (const [who, run] of cases) {
      const { doc, node, log } = cmykDoc("CMYKA8");
      const h = load(log);
      expect(() => run(h, doc, node)).toThrow(new RegExp(`${who}: ML needs an RGB document`));
      expect(() => run(h, doc, node)).toThrow(ML_MSG);
      expect(noRequires(log)).toEqual([]);
    }
  });

  it("an RGB document and a missing format run as before", () => {
    for (const fmt of ["RGBA8", undefined]) {
      const { doc, node, log } = cmykDoc(fmt);
      load(log).axiColourise!(doc, node, { force: true });
      expect(log).toContain("colourise");
    }
  });

  it("a throwing doc.format read does not block", () => {
    const { doc, node, log } = fakeDoc();
    Object.defineProperty(doc, "format", {
      get: () => {
        throw new Error("no format");
      },
    });
    load(log).axiColourise!(doc, node, { force: true });
    expect(log).toContain("colourise");
  });
});

describe("source hygiene", () => {
  it("keeps both blocks free of backticks, template placeholders, backslashes and closing calls", () => {
    for (const src of [IMAGE_SOURCE, ML_SOURCE]) {
      expect(src).not.toContain("`");
      expect(src).not.toContain("${");
      expect(src).not.toContain("\\");
      expect(src).not.toContain("close()");
    }
  });
});
