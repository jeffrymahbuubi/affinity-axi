// `colour` as a synonym of `fill` in the explicit object form of a fill record (R21), and the
// text-slot rules around it. Pure planning; the apply script is only checked as source.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FILL_APPLY, planEdits } from "../src/affinity/fill-script.js";

const plan = (record: Record<string, unknown>) => planEdits(record, undefined, ".");

describe("planEdits colour synonym", () => {
  it("maps {colour} and {fill} to the same fill edit", () => {
    const a = plan({ head: { colour: "#B5253A" } });
    const b = plan({ head: { fill: "#B5253A" } });
    expect(a).toEqual(b);
    expect(a[0]).toMatchObject({ key: "head", ref: "slot:head", fill: "#B5253A" });
  });

  it("combines with text in one object", () => {
    expect(plan({ head: { text: "Hi", colour: "#B5253A" } })[0]).toMatchObject({ text: "Hi", fill: "#B5253A" });
  });

  it("refuses fill and colour together, naming both", () => {
    expect(() => plan({ head: { fill: "#B5253A", colour: "#B5253A" } })).toThrow(/fill and colour/);
  });

  it("validates a colour the same way as a fill, naming the key that was used", () => {
    expect(() => plan({ head: { colour: "red" } })).toThrow(/colour must be a #RRGGBB colour/);
    expect(() => plan({ head: { fill: "red" } })).toThrow(/fill must be a #RRGGBB colour/);
  });

  it("lists colour among the keys an object value takes", () => {
    expect(() => plan({ head: { colorr: "#B5253A" } })).toThrow(/unknown field 'colorr'/);
    try {
      plan({ head: { colorr: "#B5253A" } });
    } catch (e) {
      expect(String((e as { suggestion?: string }).suggestion ?? e)).toContain("colour");
    }
  });

  it("keeps a plain #hex string as a string value, which is text on a text slot", () => {
    expect(plan({ head: "#B5253A" })[0]).toEqual({ key: "head", ref: "slot:head", str: "#B5253A" });
  });

  it("the apply script still sets a fill on every node that is not a picture", () => {
    const script = FILL_APPLY("0123456789ABCDEF", plan({ head: { colour: "#B5253A" } }), false);
    expect(script).toContain("ops.push(['fill', e.fill])");
    expect(script).toContain("axiSetFill(doc, p.ref, op[1])");
  });
});

describe("planEdits ML options (cutout, colourise)", () => {
  const dir = mkdtempSync(join(tmpdir(), "axi-fill-ml-"));
  writeFileSync(join(dir, "photo.jpg"), "jpg");
  const photo = join(dir, "photo.jpg");
  const ml = (o: Record<string, unknown>) => planEdits({ photo: { image: "photo.jpg", ...o } }, undefined, dir);

  it("maps cutout true to background, keeps subject, drops false", () => {
    expect(ml({ cutout: true })[0]).toMatchObject({ image: photo, cutout: "background" });
    expect(ml({ cutout: "subject" })[0]).toMatchObject({ cutout: "subject" });
    expect(ml({ cutout: "background" })[0]).toMatchObject({ cutout: "background" });
    expect(ml({ cutout: false })[0]).not.toHaveProperty("cutout");
  });

  it("colourise true is kept, false is dropped", () => {
    expect(ml({ colourise: true })[0]).toMatchObject({ colourise: true });
    expect(ml({ colourise: false })[0]).not.toHaveProperty("colourise");
  });

  it("rejects 'magic', a numeric colourise, and either key without image, naming the key", () => {
    expect(() => ml({ cutout: "magic" })).toThrow(/cutout must be true, false, 'background' or 'subject'/);
    expect(() => ml({ colourise: 1 })).toThrow(/colourise must be true or false/);
    expect(() => planEdits({ photo: { cutout: true } }, undefined, dir)).toThrow(/cutout needs an image/);
    expect(() => planEdits({ photo: { colourise: true } }, undefined, dir)).toThrow(/colourise needs an image/);
  });

  it("a plain image string has neither field", () => {
    const e = planEdits({ photo: "photo.jpg" }, undefined, dir)[0]!;
    expect(e).not.toHaveProperty("cutout");
    expect(e).not.toHaveProperty("colourise");
    expect(e.strImage).toBe(photo);
  });

  it("the unknown-field message lists cutout and colourise", () => {
    expect(() => plan({ head: { zzz: 1 } })).toThrow(/unknown field 'zzz'/);
    try {
      plan({ head: { zzz: 1 } });
    } catch (e) {
      const s = String((e as { suggestion?: string }).suggestion ?? e);
      expect(s).toContain("cutout");
      expect(s).toContain("colourise");
    }
  });

  it("the apply script runs colourise then cutout on the node axiReplaceImage returns, with transparent false", () => {
    const script = FILL_APPLY("0123456789ABCDEF", ml({ cutout: "subject", colourise: true }), false);
    expect(script).toContain("const n = axiReplaceImage(");
    expect(script).toContain("axiColourise(doc, n)");
    expect(script).toContain("axiCutout(doc, n, { method: op[4], transparent: false, align: op[5] || 'none', padding: op[6] || 0 })");
    expect(script.indexOf("axiColourise(doc, n)")).toBeLessThan(script.indexOf("axiCutout(doc, n"));
    expect(script).toContain("ops.push(['image', e.image, e.fit || '', !!e.colourise, e.cutout || '', e.align || '', e.padding || 0])");
    expect(script).toContain('"cutout":"subject"');
    expect(script).toContain('"colourise":true');
  });

  it("cutout defaults to align centre; align none leaves it unset; fit takes padding", () => {
    expect(ml({ cutout: true })[0]).toMatchObject({ cutout: "background", align: "centre" });
    expect(ml({ cutout: true })[0]).not.toHaveProperty("padding");
    expect(ml({ cutout: true, align: "none" })[0]).not.toHaveProperty("align");
    expect(ml({ cutout: true, align: "centre" })[0]).toMatchObject({ align: "centre" });
    expect(ml({ cutout: "subject", align: "fit", padding: 40 })[0]).toMatchObject({ cutout: "subject", align: "fit", padding: 40 });
    expect(ml({ cutout: "subject", align: "fit" })[0]).not.toHaveProperty("padding");
    expect(ml({ cutout: false })[0]).not.toHaveProperty("align");
    expect(ml({})[0]).not.toHaveProperty("align");
  });

  it("rejects align without cutout, padding without align fit, a bad align and a bad padding with exact messages", () => {
    expect(() => ml({ align: "centre" })).toThrow(/align needs cutout/);
    expect(() => ml({ cutout: false, align: "fit" })).toThrow(/align needs cutout/);
    expect(() => ml({ cutout: true, padding: 10 })).toThrow(/padding needs align 'fit'/);
    expect(() => ml({ cutout: true, align: "centre", padding: 10 })).toThrow(/padding needs align 'fit'/);
    expect(() => ml({ cutout: true, align: "none", padding: 10 })).toThrow(/padding needs align 'fit'/);
    expect(() => ml({ cutout: true, align: "middle" })).toThrow(/align must be 'none', 'centre' or 'fit'/);
    expect(() => ml({ cutout: true, align: 1 })).toThrow(/align must be 'none', 'centre' or 'fit'/);
    expect(() => ml({ cutout: true, align: "fit", padding: -5 })).toThrow(/padding must be a number of 0 or more/);
    expect(() => ml({ cutout: true, align: "fit", padding: "40" })).toThrow(/padding must be a number of 0 or more/);
    expect(() => ml({ cutout: true, align: "fit", padding: Number.NaN })).toThrow(/padding must be a number of 0 or more/);
  });

  it("the unknown-field message lists align and padding", () => {
    try {
      plan({ head: { zzz: 1 } });
      throw new Error("did not throw");
    } catch (e) {
      const s = String((e as { suggestion?: string }).suggestion ?? e);
      expect(s).toContain("align");
      expect(s).toContain("padding");
    }
  });

  it("serialises the fit record as the op tuple's inputs and a plain image string has neither field", () => {
    const edits = ml({ cutout: "subject", align: "fit", padding: 40 });
    const script = FILL_APPLY("0123456789ABCDEF", edits, false);
    expect(script).toContain('"cutout":"subject","align":"fit","padding":40');
    const e = planEdits({ photo: "photo.jpg" }, undefined, dir)[0]!;
    expect(e).not.toHaveProperty("align");
    expect(e).not.toHaveProperty("padding");
  });

  it("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});
