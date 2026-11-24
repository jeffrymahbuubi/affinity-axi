// axiFilePath (internal image helper): ~/Desktop/... expansion, evaluated from IMAGE_SOURCE.

import { describe, expect, it } from "vitest";
import { IMAGE_INTERNAL, IMAGE_SOURCE } from "../src/affinity/helpers-image.js";

function load(desktop: string): { fn: (p: unknown, who: string) => unknown; calls: string[] } {
  const calls: string[] = [];
  const req = (m: string): unknown => {
    calls.push(m);
    if (m === "/application.js") return { Application: { userDesktopPath: desktop } };
    throw new Error("unexpected require " + m);
  };
  const fn = new Function("require", `${IMAGE_SOURCE}\nreturn axiFilePath;`)(req) as (p: unknown, who: string) => unknown;
  return { fn, calls };
}

describe("axiFilePath", () => {
  it("is internal and the block has no backslash", () => {
    expect(IMAGE_INTERNAL).toContain("axiFilePath");
    expect(IMAGE_SOURCE.includes("\\")).toBe(false);
  });

  it("expands ~/Desktop on a POSIX Desktop", () => {
    const { fn } = load("/home/x/Desktop");
    expect(fn("~/Desktop/a/b.png", "axiImage")).toBe("/home/x/Desktop/a/b.png");
    expect(fn("~/desktop/a.png", "axiImage")).toBe("/home/x/Desktop/a.png");
  });

  it("returns other values unchanged without calling require", () => {
    const { fn, calls } = load("/home/x/Desktop");
    for (const v of ["/abs/a.png", "rel/a.png", "~name/a.png", undefined, 7]) expect(fn(v, "axiImage")).toBe(v);
    expect(calls).toEqual([]);
  });

  it("gives backslash paths on a Windows Desktop", () => {
    const { fn } = load("C:\\Users\\x\\Desktop");
    expect(fn("~/Desktop/a/b.png", "axiImage")).toBe("C:\\Users\\x\\Desktop\\a\\b.png");
    expect(fn("%userprofile%\\Desktop\\a\\b.png", "axiImage")).toBe("C:\\Users\\x\\Desktop\\a\\b.png");
  });

  it("throws for ~/ outside the Desktop, naming helper, path and Desktop", () => {
    const { fn } = load("/home/x/Desktop");
    expect(() => fn("~/Pictures/a.png", "axiReplaceImage")).toThrow(
      "axiReplaceImage: cannot read '~/Pictures/a.png': Affinity reads files only under the Desktop folder (/home/x/Desktop), and ~/ is expanded only for ~/Desktop/...",
    );
  });
});
