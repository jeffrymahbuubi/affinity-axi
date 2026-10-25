// `colour` as a synonym of `fill` in the explicit object form of a fill record (R21), and the
// text-slot rules around it. Pure planning; the apply script is only checked as source.

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
