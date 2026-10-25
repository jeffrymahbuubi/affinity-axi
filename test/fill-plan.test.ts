// `fill`: slot planning, value checks, preset extensions and the apply script.
// Pure: no server, no Affinity.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILL_APPLY, extFor, planEdits, problemsOf, slotRef, type ApplyReply } from "../src/affinity/fill-script.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "axi-fill-plan-"));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function write(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}
const uuidFor = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("fill planning (pure)", () => {
  it("maps a key to slot:<key> and board/key to board/slot:key", () => {
    expect(slotRef("headline")).toBe("slot:headline");
    expect(slotRef("story/headline")).toBe("story/slot:headline");
    const edits = planEdits({ slug: "mar", headline: "Hi", "story/price": "9" }, "slug", work);
    expect(edits.map((e) => [e.key, e.ref])).toEqual([["headline", "slot:headline"], ["story/price", "story/slot:price"]]);
  });

  it("skips the key field; strings, numbers and objects become edits", () => {
    write(work, "p.png", "x");
    const e = planEdits({ slug: "a", headline: "Hi", n: 12, cta: "#FFC857", photo: "p.png", pic: { image: "p.png", fit: "contain" }, b: { box: { x: 1, w: 20 } }, h: { hidden: true }, t: { text: 5, fill: "#000000" } }, "slug", work);
    expect(e.map((x) => x.key)).toEqual(["headline", "n", "cta", "photo", "pic", "b", "h", "t"]);
    expect(e[1]!.str).toBe("12");
    expect(e[3]!.strImage).toBe(join(work, "p.png"));
    expect(e[2]!.strImage).toBeUndefined();
    expect(e[4]).toMatchObject({ image: join(work, "p.png"), fit: "contain" });
    expect(e[5]!.box).toEqual({ x: 1, w: 20 });
    expect(e[6]!.hidden).toBe(true);
    expect(e[7]).toMatchObject({ text: "5", fill: "#000000" });
  });

  it("a string with an image extension is text when the file is missing and it has spaces", () => {
    const e = planEdits({ t: "See the new logo.png now" }, undefined, work);
    expect(e[0]!.strImage).toBeUndefined();
    expect(() => planEdits({ photo: "nope.png" }, undefined, work)).toThrow(/image file not found/);
  });

  it("rejects bad values as usage errors", () => {
    expect(() => planEdits({ a: null }, undefined, work)).toThrow(/unsupported value/);
    expect(() => planEdits({ a: true }, undefined, work)).toThrow(/unsupported value/);
    expect(() => planEdits({ a: [1] }, undefined, work)).toThrow(/unsupported value/);
    expect(() => planEdits({ a: {} }, undefined, work)).toThrow(/empty object/);
    expect(() => planEdits({ a: { color: "#000000" } }, undefined, work)).toThrow(/unknown field 'color'/);
    expect(() => planEdits({ a: { fill: "red" } }, undefined, work)).toThrow(/#RRGGBB/);
    expect(() => planEdits({ a: { fit: "cover" } }, undefined, work)).toThrow(/fit needs an image/);
    expect(() => planEdits({ a: { box: { w: 0 } } }, undefined, work)).toThrow(/positive/);
    expect(() => planEdits({ a: { box: { z: 1 } } }, undefined, work)).toThrow(/unknown box field/);
    expect(() => planEdits({ a: { hidden: "yes" } }, undefined, work)).toThrow(/true or false/);
    expect(() => planEdits({ "/a": "x" }, undefined, work)).toThrow(/invalid slot key/);
    expect(() => planEdits({ "a/": "x" }, undefined, work)).toThrow(/invalid slot key/);
  });

  it("maps presets to file extensions", () => {
    expect(extFor("PNG")).toBe("png");
    expect(extFor("JPEG (High quality)")).toBe("jpg");
    expect(extFor("JPEG XL (Best Quality)")).toBe("jxl");
    expect(extFor("WebP (Lossless, default)")).toBe("webp");
    expect(extFor("SVG (flatten)")).toBe("svg");
    expect(extFor("Canva Design")).toBeUndefined();
  });

  it("describes problems; ignore-unknown forgives only unknown slots", () => {
    const r: ApplyReply = { applied: [], unknown: ["subtitle"], duplicate: [{ key: "price", paths: ["#0/0/3", "#0/1/3"] }], mismatch: [{ key: "headline", node: "text node", got: "an image" }], slots: ["slot:headline", "slot:price"] };
    expect(problemsOf(r, false)).toEqual([
      "unknown slot 'subtitle' (slots: headline, price)",
      "duplicate slot 'price' at #0/0/3, #0/1/3 (qualify as board/price, or rename one)",
      "slot 'headline' is a text node; got an image",
    ]);
    expect(problemsOf(r, true)).toHaveLength(2);
  });

  it("the apply script has the slot refs, no bare refs, no close() and is syntactically valid with the helpers", () => {
    const edits = planEdits({ headline: "Hi", "story/price": "9" }, undefined, work);
    const script = FILL_APPLY(uuidFor(1), edits, false);
    expect(script).toContain('"ref":"slot:headline"');
    expect(script).toContain('"ref":"story/slot:price"');
    expect(script).not.toMatch(/"ref":"headline"/);
    expect(script).not.toContain("close(");
    expect(script).toContain("/* affinity-axi:fill-apply */");
    expect(() => new Function(script + "\n" + HELPERS_SOURCE)).not.toThrow();
  });
});
