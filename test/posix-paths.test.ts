// toPosix (the stored form of a path in a manifest or kit) and shown/shownRel (the
// printed form, the same rule). Both separators are
// exercised through the parameter, so this runs the same way on every OS.

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shown, shownRel, toPosix } from "../src/affinity/paths.js";

describe("toPosix", () => {
  it("turns the Windows separator into /", () => {
    expect(toPosix("scripts\\promo.js", "\\")).toBe("scripts/promo.js");
    expect(toPosix("..\\brands\\x.json", "\\")).toBe("../brands/x.json");
    expect(toPosix("C:\\kits\\x.json", "\\")).toBe("C:/kits/x.json");
  });

  it("leaves a path alone when the separator is already /", () => {
    expect(toPosix("a\\b.js", "/")).toBe("a\\b.js");
    expect(toPosix("../brands/x.json", "/")).toBe("../brands/x.json");
  });

  it("leaves a path with no separator alone", () => {
    expect(toPosix("promo.js", "\\")).toBe("promo.js");
    expect(toPosix("", "\\")).toBe("");
  });

  it("gives no backslash for a join()-built path on any OS with the default separator", () => {
    const p = toPosix(join("..", "scripts", "promo.js"));
    expect(p).toBe("../scripts/promo.js");
    expect(p).not.toContain("\\");
  });
});

describe("shown", () => {
  it("prints a relative Windows path with /", () => {
    expect(shown("sub\\one.af", "\\")).toBe("sub/one.af");
  });

  it("prints a drive path with /", () => {
    expect(shown("C:\\work\\x\\a.af", "\\")).toBe("C:/work/x/a.af");
  });

  it("prints a UNC path with //", () => {
    expect(shown("\\\\srv\\share\\a.png", "\\")).toBe("//srv/share/a.png");
  });

  it("prints a home-relative path with /", () => {
    expect(shown("~\\Desktop\\a", "\\")).toBe("~/Desktop/a");
  });

  it("leaves a path alone when the separator is already /", () => {
    expect(shown("a\\b", "/")).toBe("a\\b");
  });

  it("is idempotent", () => {
    const once = shown("C:\\Users\\x\\a.af", "\\");
    expect(shown(once, "\\")).toBe(once);
  });

  it("gives no backslash for a join()-built path on any OS with the default separator", () => {
    const p = shown(join("..", "sub", "one.af"));
    expect(p).toBe("../sub/one.af");
    expect(p).not.toContain("\\");
  });
});

describe("shownRel", () => {
  const cwd = resolve("scratch-cwd");

  it("prints a path under cwd relative, with /", () => {
    expect(shownRel(join(cwd, "sub", "one.af"), cwd)).toBe("sub/one.af");
  });

  it("resolves a relative target against cwd", () => {
    expect(shownRel("sub/one.af", cwd)).toBe("sub/one.af");
  });

  it("prints cwd itself in its absolute form", () => {
    expect(shownRel(cwd, cwd)).toBe(shown(cwd));
  });

  it("prints a path outside cwd with ..", () => {
    expect(shownRel(join(cwd, "..", "kits", "x.json"), cwd)).toBe("../kits/x.json");
  });
});
