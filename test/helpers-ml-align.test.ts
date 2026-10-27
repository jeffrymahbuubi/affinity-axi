// Re-centring a cut-out (helpers-ml.ts): axiContentBox, axiAlignIn and the align,
// padding and box options of axiCutout. Same fake SDK as helpers-ml.test.ts.

import { describe, expect, it } from "vitest";
import { ML_INDEX } from "../src/affinity/helpers-ml.js";
import { calls, fakeDoc, load } from "./helpers-ml-fake.js";

// Content 306x308 at (240,230) in a 900x640 frame at (90,130): the frame centre is
// (540,450), the content centre (393,384).
const content = { x: 240, y: 230, w: 306, h: 308 };
const frame = { x: 90, y: 130, w: 900, h: 640 };
const framed = () => fakeDoc({ box: content, frame });
const xfLogs = (log: string[]) => log.filter((l) => l.startsWith("applyTransform:"));

describe("axiContentBox", () => {
  it("maps the SDK box (width/height) to {x,y,w,h}", () => {
    const { doc, node, log } = framed();
    expect(load(log).axiContentBox(doc, node)).toEqual(content);
  });

  it("needs a node", () => {
    const { doc, log } = framed();
    expect(() => load(log).axiContentBox(doc)).toThrow(/pass the node/);
  });
});

describe("axiAlignIn", () => {
  it("rejects a bad align or padding before any SDK call", () => {
    for (const o of [{ align: "left" }, { padding: -1 }, { padding: "x" }, { padding: NaN }]) {
      const { doc, node, log } = framed();
      expect(() => load(log).axiAlignIn(doc, node, undefined, o)).toThrow(/align must be none, centre or fit|padding must be a finite number of 0 or more/);
      expect(log).toEqual([]);
    }
  });

  it("align none returns the node and never calls the SDK", () => {
    const { doc, node, log } = framed();
    expect(load(log).axiAlignIn(doc, node, undefined, { align: "none" })).toBe(node);
    expect(log).toEqual([]);
  });

  it("centre moves the content centre onto the frame centre with one transform", () => {
    const { doc, node, log } = framed();
    expect(load(log).axiAlignIn(doc, node)).toBe(node);
    expect(xfLogs(log)).toEqual(["applyTransform:T(540,450).S(1,1).T(-393,-384)"]);
    expect(log.indexOf("select:node")).toBeLessThan(log.indexOf("applyTransform:T(540,450).S(1,1).T(-393,-384)"));
  });

  it("fit with padding scales uniformly into the box minus padding", () => {
    const { doc, node, log } = framed();
    load(log).axiAlignIn(doc, node, undefined, { align: "fit", padding: 40 });
    const k = Math.min((900 - 80) / 306, (640 - 80) / 308);
    expect(k).toBeCloseTo(560 / 308, 10);
    expect(k).toBeGreaterThan(0);
    const [l] = xfLogs(log);
    expect(l).toContain(`S(${k},${k})`);
    expect(l!.startsWith("applyTransform:T(540,450).S(")).toBe(true);
    expect(l!.endsWith(".T(-393,-384)")).toBe(true);
  });

  it("fit with no room throws and applies nothing", () => {
    const { doc, node, log } = framed();
    expect(() => load(log).axiAlignIn(doc, node, undefined, { align: "fit", padding: 400 })).toThrow(/padding leaves no room/);
    expect(xfLogs(log)).toEqual([]);
  });

  it("an explicit box wins over the frame", () => {
    const { doc, node, log } = framed();
    load(log).axiAlignIn(doc, node, { x: 0, y: 0, w: 200, h: 100 });
    expect(xfLogs(log)).toEqual(["applyTransform:T(100,50).S(1,1).T(-393,-384)"]);
  });

  it("without a frame or a box it throws the no box message", () => {
    const { doc, node, log } = fakeDoc({ box: content });
    expect(() => load(log).axiAlignIn(doc, node)).toThrow("axiAlignIn: no box; the layer is not in a picture frame, pass box {x,y,w,h}");
    expect(xfLogs(log)).toEqual([]);
  });

  it("rejects a malformed box", () => {
    const { doc, node, log } = framed();
    expect(() => load(log).axiAlignIn(doc, node, { x: 0, y: 0, w: 0, h: 10 })).toThrow(/box w and h must be positive/);
    expect(() => load(log).axiAlignIn(doc, node, { x: "0", y: 0, w: 10, h: 10 })).toThrow(/box.x must be a finite number/);
  });
});

describe("axiCutout align", () => {
  it("default path is unchanged: no transform, no geometry module, no extra measuring", () => {
    const { doc, node, log } = framed();
    load(log).axiCutout(doc, node, { transparent: false });
    expect(calls(log)).toEqual(["removeBackground"]);
    expect(log).not.toContain("require:/geometry.js");
  });

  it("rejects a bad align or padding before any SDK call", () => {
    for (const o of [{ align: "middle" }, { padding: -2 }, { align: "fit", padding: "4" }]) {
      const { doc, node, log } = framed();
      expect(() => load(log).axiCutout(doc, node, o)).toThrow(/align must be none, centre or fit|padding must be a finite number of 0 or more/);
      expect(log).toEqual([]);
    }
  });

  it("centre on a framed node: removeBackground, then the transform, nothing after with transparent:false", () => {
    const { doc, node, log } = fakeDoc({ box: { x: 0, y: 0, w: 600, h: 400 }, frame, shrinkTo: content });
    expect(load(log).axiCutout(doc, node, { align: "centre", transparent: false })).toBe(node);
    expect(calls(log)).toEqual(["removeBackground", "applyTransform:T(540,450).S(1,1).T(-393,-384)"]);
  });

  it("centre with the default transparent: the transform precedes setDocumentProperties", () => {
    const { doc, node, log } = fakeDoc({ box: content, frame });
    load(log).axiCutout(doc, node, { align: "centre" });
    const i = log.findIndex((l) => l.startsWith("applyTransform:"));
    expect(i).toBeGreaterThan(log.indexOf("removeBackground"));
    expect(i).toBeLessThan(log.indexOf("setDocumentProperties"));
  });

  it("centre on an unframed node uses the box measured before the ML call", () => {
    const { doc, node, log } = fakeDoc({ box: { x: 0, y: 0, w: 960, h: 640 }, shrinkTo: { x: 300, y: 200, w: 306, h: 308 } });
    load(log).axiCutout(doc, node, { align: "centre", transparent: false });
    expect(xfLogs(log)).toEqual(["applyTransform:T(480,320).S(1,1).T(-453,-354)"]);
  });

  it("an explicit box beats both the frame and the original placement", () => {
    const { doc, node, log } = fakeDoc({ box: content, frame, shrinkTo: content });
    load(log).axiCutout(doc, node, { align: "centre", transparent: false, box: { x: 0, y: 0, w: 200, h: 100 } });
    expect(xfLogs(log)).toEqual(["applyTransform:T(100,50).S(1,1).T(-393,-384)"]);
  });

  it("fit with method subject: select, invert, delete, deselect, transform, then transparent", () => {
    const { doc, node, log } = fakeDoc({ box: content, frame });
    load(log).axiCutout(doc, node, { align: "fit", method: "subject" });
    expect(calls(log).map((l) => (l.startsWith("applyTransform:") ? "applyTransform" : l))).toEqual([
      "selectSubject", "invert", "exec:cmd:invert", "delete:false", "exec:cmd:delete", "deselect", "exec:cmd:deselect", "applyTransform", "transparent:true", "setDocumentProperties",
    ]);
  });

  it("fit passes padding through to the scale", () => {
    const { doc, node, log } = fakeDoc({ box: content, frame });
    load(log).axiCutout(doc, node, { align: "fit", padding: 40, transparent: false });
    expect(xfLogs(log)[0]).toContain(`S(${560 / 308},`);
  });

  it("rasterises an image node first, then measures the rasterised layer", () => {
    const { doc, node, log } = fakeDoc({ image: true, box: content, frame });
    load(log).axiCutout(doc, node, { align: "centre", transparent: false });
    expect(log.indexOf("rasteriseObjects")).toBeLessThan(log.indexOf("removeBackground"));
    expect(log.filter((l) => l === "rasteriseObjects")).toHaveLength(1);
  });

  it("throws the pick message when nothing is selected", () => {
    const { doc, log } = fakeDoc();
    expect(() => load(log).axiCutout(doc, undefined, { align: "centre" })).toThrow(/axiCutout: nothing selected/);
  });
});

describe("index summaries", () => {
  it("name the align values and the box order", () => {
    const by = Object.fromEntries(ML_INDEX.map((h) => [h.name, h]));
    expect(by["axiCutout"]!.signature).toBe("axiCutout(doc, node?, {method,transparent,align,padding,box,artboard})");
    for (const w of ["none", "centre", "fit", "padding", "box", "picture frame"]) expect(by["axiCutout"]!.summary).toContain(w);
    expect(by["axiContentBox"]!.signature).toBe("axiContentBox(doc, node)");
    expect(by["axiAlignIn"]!.signature).toBe("axiAlignIn(doc, node, box?, {align,padding})");
  });
});
