// The ML helpers (helpers-ml.ts): cut-out, subject selection, deselect, safe
// depth. The helper source is evaluated in plain Node with a fake `require` that
// returns stub SDK modules and a fake document that logs every call, so the
// order of SDK calls and the return values are checked without Affinity.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE, HELPER_INDEX, INTERNAL_HELPERS } from "../src/affinity/helpers.js";
import { ML_INDEX, ML_INTERNAL, ML_SOURCE } from "../src/affinity/helpers-ml.js";
import { calls, fakeDoc, load } from "./helpers-ml-fake.js";

describe("ML helper registration", () => {
  it("indexes the ML helpers once, in ML_INDEX order, with axiPick internal", () => {
    expect(ML_INDEX.map((h) => h.name)).toEqual(["axiRemoveBackground", "axiSelectSubject", "axiDeselect", "axiCutout", "axiContentBox", "axiAlignIn", "axiDetectDepth", "axiDepthBlur", "axiColourise"]);
    expect(ML_INTERNAL).toEqual(["axiPick"]);
    for (const h of ML_INDEX) {
      expect(HELPER_INDEX).toContain(h);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(ML_SOURCE).toMatch(new RegExp(`^function ${h.name}\\(`, "m"));
    }
    for (const n of ML_INTERNAL) expect(INTERNAL_HELPERS).toContain(n);
    expect(HELPERS_SOURCE.match(/^function axiPick\(/gm)).toHaveLength(1);
  });

  it("keeps the block free of backticks, template placeholders, backslashes and closing calls", () => {
    expect(ML_SOURCE).not.toContain("`");
    expect(ML_SOURCE).not.toContain("${");
    expect(ML_SOURCE).not.toContain("\\");
    expect(ML_SOURCE).not.toContain("close()");
  });

  it("states the changed contracts in the index summaries", () => {
    const by = Object.fromEntries(ML_INDEX.map((h) => [h.name, h.summary]));
    expect(by["axiSelectSubject"]).toContain("pixel selection");
    expect(by["axiSelectSubject"]).toContain("no subject found");
    expect(by["axiDetectDepth"]).toContain("-depth");
    expect(by["axiDetectDepth"]).toContain("inPlace");
    expect(by["axiDepthBlur"]).toContain("DESTRUCTIVE");
    expect(by["axiDepthBlur"]).toContain("{photo, depth}");
  });
});

describe("axiCutout", () => {
  it("rejects an unknown method before any SDK call", () => {
    const { doc, log } = fakeDoc();
    const h = load(log);
    expect(() => h.axiCutout(doc, undefined, { method: "magic" })).toThrow(/method must be background or subject, got magic/);
    expect(log).toEqual([]);
  });

  it("defaults to background removal, then makes the document transparent", () => {
    const { doc, node, log, props } = fakeDoc();
    const h = load(log);
    const out = h.axiCutout(doc, node);
    expect(out).toBe(node);
    expect(calls(log).filter((l) => l === "removeBackground")).toHaveLength(1);
    expect(log).not.toContain("selectSubject");
    expect(log.indexOf("removeBackground")).toBeLessThan(log.indexOf("transparent:true"));
    expect(props).toEqual([{ isTransparent: true }]);
    expect(log).toContain("require:/documentproperties.js");
  });

  it("transparent:false never touches document properties", () => {
    const { doc, node, log, props } = fakeDoc();
    const h = load(log);
    h.axiCutout(doc, node, { transparent: false });
    expect(log).toContain("removeBackground");
    expect(log).not.toContain("require:/documentproperties.js");
    expect(log.some((l) => l.startsWith("transparent:"))).toBe(false);
    expect(props).toEqual([]);
  });

  it("method subject selects, inverts, deletes, then deselects, in that order", () => {
    const { doc, node, log } = fakeDoc();
    const h = load(log);
    const out = h.axiCutout(doc, node, { method: "subject", transparent: false });
    expect(out).toBe(node);
    expect(calls(log)).toEqual(["selectSubject", "invert", "exec:cmd:invert", "delete:false", "exec:cmd:delete", "deselect", "exec:cmd:deselect"]);
    expect(doc.rasterSelection.isSelectNone).toBe(true);
    expect(log).not.toContain("removeBackground");
  });

  it("method subject still makes the document transparent by default", () => {
    const { doc, node, log, props } = fakeDoc();
    const h = load(log);
    h.axiCutout(doc, node, { method: "subject" });
    expect(log.indexOf("exec:cmd:deselect")).toBeLessThan(log.indexOf("setDocumentProperties"));
    expect(props).toEqual([{ isTransparent: true }]);
  });

  it("method subject deletes nothing when no subject is found", () => {
    const { doc, node, log } = fakeDoc({ subject: false });
    const h = load(log);
    expect(() => h.axiCutout(doc, node, { method: "subject" })).toThrow("axiSelectSubject: no subject found");
    expect(log).not.toContain("invert");
    expect(log).not.toContain("delete:false");
  });

  it("rasterises an image node first and throws when nothing is selected", () => {
    const img = fakeDoc({ image: true });
    load(img.log).axiCutout(img.doc, img.node);
    expect(img.log.indexOf("rasteriseObjects")).toBeLessThan(img.log.indexOf("removeBackground"));
    const none = fakeDoc();
    expect(() => load(none.log).axiCutout(none.doc)).toThrow(/axiCutout: nothing selected/);
  });
});

describe("axiSelectSubject and axiDeselect", () => {
  it("returns the node when a subject was found", () => {
    const { doc, node, log } = fakeDoc();
    expect(load(log).axiSelectSubject(doc, node)).toBe(node);
    expect(doc.rasterSelection.isSelectNone).toBe(false);
  });

  it("throws 'no subject found' when the pixel selection stays empty", () => {
    const { doc, node, log } = fakeDoc({ subject: false });
    expect(() => load(log).axiSelectSubject(doc, node)).toThrow("axiSelectSubject: no subject found");
  });

  it("axiDeselect runs the deselect command and returns the document", () => {
    const { doc, log } = fakeDoc();
    doc.rasterSelection.isSelectNone = false;
    expect(load(log).axiDeselect(doc)).toBe(doc);
    expect(calls(log)).toEqual(["deselect", "exec:cmd:deselect"]);
    expect(doc.rasterSelection.isSelectNone).toBe(true);
  });
});

describe("axiDetectDepth", () => {
  it("duplicates, runs depth on the copy, names it <name>-depth, hides it and returns the copy", () => {
    const { doc, node, copy, log } = fakeDoc();
    const out = load(log).axiDetectDepth(doc, node);
    expect(out).toBe(copy);
    expect(log).toContain("duplicate:identity");
    expect(log).toContain("detectDepth:copy");
    expect(log).not.toContain("detectDepth:node");
    expect(copy.userDescription).toBe("photo-depth");
    expect(node.userDescription).toBe("photo");
    expect(log).toContain("visibility:false");
    expect(log.indexOf("duplicate:identity")).toBeLessThan(log.indexOf("detectDepth:copy"));
    expect(log.indexOf("detectDepth:copy")).toBeLessThan(log.indexOf("visibility:false"));
  });

  it("names the copy 'depth' when the layer has no name", () => {
    const { doc, node, copy, log } = fakeDoc({ name: "" });
    load(log).axiDetectDepth(doc, node);
    expect(copy.userDescription).toBe("depth");
  });

  it("visible:true skips the hide", () => {
    const { doc, node, copy, log } = fakeDoc();
    expect(load(log).axiDetectDepth(doc, node, { visible: true })).toBe(copy);
    expect(log.some((l) => l.startsWith("visibility:"))).toBe(false);
  });

  it("inPlace:true runs depth on the original and never duplicates", () => {
    const { doc, node, log } = fakeDoc();
    expect(load(log).axiDetectDepth(doc, node, { inPlace: true })).toBe(node);
    expect(log).toContain("detectDepth:node");
    expect(log.some((l) => l.startsWith("duplicate") || l === "createDuplicate")).toBe(false);
    expect(log.some((l) => l.startsWith("visibility:"))).toBe(false);
  });

  it("falls back to createDuplicate when the node has no duplicate method", () => {
    const { doc, node, copy, log } = fakeDoc({ duplicate: false });
    // the command run selects the new copy, as Affinity does
    const exec = doc.executeCommand;
    doc.executeCommand = (c: string) => {
      exec(c);
      if (c === "cmd:duplicate") doc.selection = copy;
    };
    expect(load(log).axiDetectDepth(doc, node)).toBe(copy);
    expect(log).toContain("createDuplicate");
    expect(log).toContain("detectDepth:copy");
  });

  it("rasterises an image node first", () => {
    const { doc, node, log } = fakeDoc({ image: true });
    load(log).axiDetectDepth(doc, node);
    expect(log.indexOf("rasteriseObjects")).toBeLessThan(log.indexOf("detectDepth:copy"));
  });
});

describe("axiDepthBlur", () => {
  it("makes the depth copy, selects it by intensity, inverts, hides it, blurs the photo, deselects", () => {
    const { doc, node, copy, log } = fakeDoc();
    const out = load(log).axiDepthBlur(doc, node);
    expect(out.photo).toBe(node);
    expect(out.depth).toBe(copy);
    expect(copy.userDescription).toBe("photo-depth");
    expect(calls(log)).toEqual([
      "duplicate:identity",
      "detectDepth:copy",
      "selectFrom:copy:true:op:New",
      "invert",
      "exec:cmd:invert",
      "visibility:false",
      "exec:cmd:visibility",
      "blur:photo:14",
      "exec:cmd:blur",
      "deselect",
      "exec:cmd:deselect",
    ]);
    expect(doc.rasterSelection.isSelectNone).toBe(true);
  });

  it("targets the photo, not the depth copy, for the blur", () => {
    const { doc, node, log } = fakeDoc();
    load(log).axiDepthBlur(doc, node);
    const selects = log.filter((l) => l.startsWith("select:"));
    expect(selects[selects.length - 1]).toBe("select:node");
    expect(log.indexOf("exec:cmd:invert")).toBeLessThan(log.lastIndexOf("select:node"));
  });

  it("uses a supplied depth node, skips detection and leaves its visibility alone", () => {
    const { doc, node, copy, log } = fakeDoc();
    const out = load(log).axiDepthBlur(doc, node, copy, { radius: 30 });
    expect(out.depth).toBe(copy);
    expect(log).not.toContain("detectDepth:copy");
    expect(log.some((l) => l.startsWith("duplicate") || l.startsWith("visibility:"))).toBe(false);
    expect(log).toContain("selectFrom:copy:true:op:New");
    expect(log).toContain("blur:photo:30");
  });

  it("rejects a bad radius before any SDK call", () => {
    for (const radius of [0, -3, NaN, Infinity, "14"]) {
      const { doc, node, log } = fakeDoc();
      expect(() => load(log).axiDepthBlur(doc, node, undefined, { radius })).toThrow(/radius must be a positive finite number/);
      expect(log).toEqual([]);
    }
  });

  it("needs a photo node", () => {
    const { doc, log } = fakeDoc();
    expect(() => load(log).axiDepthBlur(doc)).toThrow(/pass the photo node/);
    expect(log).toEqual([]);
  });

  it("rasterises an image node first", () => {
    const { doc, node, log } = fakeDoc({ image: true });
    load(log).axiDepthBlur(doc, node);
    expect(log.indexOf("rasteriseObjects")).toBeLessThan(log.indexOf("duplicate:identity"));
  });
});

describe("axiRemoveBackground and axiColourise", () => {
  it("keep their old behaviour: pick, one ML call, return the selected node", () => {
    const a = fakeDoc({ image: true });
    expect(load(a.log).axiRemoveBackground(a.doc, a.node)).toBe(a.node);
    expect(calls(a.log)).toEqual(["rasteriseObjects", "removeBackground"]);
    const b = fakeDoc();
    expect(load(b.log).axiColourise(b.doc, b.node)).toBe(b.node);
    expect(calls(b.log)).toEqual(["colourise"]);
  });
});
