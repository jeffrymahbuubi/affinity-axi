// `fill` picture slot focus: parsing, op shape and apply-script text. Pure: no server, no Affinity.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILL_APPLY, planEdits } from "../src/affinity/fill-script.js";

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "axi-fill-focus-"));
  writeFileSync(join(work, "p.jpg"), "x");
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const plan = (v: Record<string, unknown>) => planEdits({ pic: v }, undefined, work);
const uuid = "00000000-0000-4000-8000-000000000001";

describe("fill focus parsing", () => {
  it("accepts {x, y} in 0..1 with image, with and without fit cover", () => {
    expect(plan({ image: "p.jpg", focus: { x: 0.5, y: 0.35 } })[0]!.focus).toEqual({ x: 0.5, y: 0.35 });
    const e = plan({ image: "p.jpg", fit: "cover", focus: { x: 0, y: 1 } })[0]!;
    expect(e.focus).toEqual({ x: 0, y: 1 });
    expect(e.fit).toBe("cover");
  });

  it("leaves focus undefined when absent", () => {
    expect(plan({ image: "p.jpg" })[0]!.focus).toBeUndefined();
  });

  it("rejects out-of-range, missing, extra and non-numeric coordinates", () => {
    for (const f of [{ x: 1.2, y: 0.5 }, { x: 0.5, y: -0.1 }, { x: 0.5 }, { y: 0.5 }, { x: "a", y: 0.5 }, { x: 0.5, y: 0.5, z: 1 }, [0.5, 0.5], 0.5, null, { x: NaN, y: 0 }]) {
      expect(() => plan({ image: "p.jpg", focus: f })).toThrow(/focus must be \{x, y\} between 0 and 1/);
    }
  });

  it("needs an image", () => {
    expect(() => plan({ focus: { x: 0.5, y: 0.5 } })).toThrow(/focus needs an image/);
  });

  it("needs fit cover when fit is given", () => {
    expect(() => plan({ image: "p.jpg", fit: "contain", focus: { x: 0.5, y: 0.5 } })).toThrow(/focus needs fit "cover"/);
    expect(() => plan({ image: "p.jpg", fit: "stretch", focus: { x: 0.5, y: 0.5 } })).toThrow(/focus needs fit "cover"/);
  });
});

describe("fill focus apply script", () => {
  it("sends focus as op[9] and passes it to axiReplaceImage", () => {
    const edits = plan({ image: "p.jpg", focus: { x: 0.5, y: 0.2 } });
    const script = FILL_APPLY(uuid, edits, false);
    expect(script).toContain("io.focus = op[9]");
    expect(script).toContain("ops[ops.length - 1].push(e.focus || null)");
    expect(script).toContain('"focus":{"x":0.5,"y":0.2}');
  });
});
