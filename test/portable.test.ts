// portable: stored path forms, their decode, the state folder and the home scrub.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { slash } from "./helpers/paths.js";
import { expandTilde, resolveStored, scrubHome, stateDir, storedPath, STATE_ENV } from "../src/affinity/portable.js";

let root: string;
let home: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "axi-portable-")));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("stateDir", () => {
  it("the variable wins and is resolved", () => {
    expect(stateDir({ [STATE_ENV]: join(root, "st") }, home)).toBe(join(root, "st"));
    expect(stateDir({ [STATE_ENV]: "rel" }, home)).toBe(resolve("rel"));
  });
  it("empty or unset gives <home>/.affinity-axi", () => {
    expect(stateDir({}, home)).toBe(join(home, ".affinity-axi"));
    expect(stateDir({ [STATE_ENV]: "" }, home)).toBe(join(home, ".affinity-axi"));
  });
});

describe("expandTilde", () => {
  it("expands ~, ~/x and ~\\x only", () => {
    expect(expandTilde("~", home)).toBe(home);
    expect(expandTilde("~/a/b", home)).toBe(join(home, "a", "b"));
    expect(expandTilde("~\\a", home)).toBe(join(home, "a"));
    expect(expandTilde("~x/a", home)).toBe("~x/a");
    expect(expandTilde("a/b", home)).toBe("a/b");
  });
});

describe("storedPath", () => {
  const base = () => join(home, "Desktop", "out");
  it("a file in baseDir, a sub-folder file, baseDir itself", () => {
    mkdirSync(join(base(), "sub"), { recursive: true });
    expect(storedPath(join(base(), "a.af"), base(), home)).toBe("a.af");
    expect(storedPath(join(base(), "sub", "a.png"), base(), home)).toBe("sub/a.png");
    expect(storedPath(base(), base(), home)).toBe(".");
  });
  it("siblings give ../ when both are under home and when both are outside", () => {
    expect(slash(storedPath(join(home, "proj", "scripts", "x.js"), base(), home))).toBe("../../proj/scripts/x.js");
    const out = join(root, "elsewhere", "a");
    expect(storedPath(join(root, "elsewhere", "scripts", "x.js"), out, home)).toBe("../scripts/x.js");
    expect(storedPath(join(home, "scripts", "x.js"), join(home, "Desktop"), home)).toBe("../scripts/x.js");
  });
  it("base outside home and target under it gives ~/...; home itself gives ~", () => {
    const out = join(root, "elsewhere");
    expect(storedPath(join(home, "proj", "k.json"), out, home)).toBe("~/proj/k.json");
    expect(storedPath(home, out, home)).toBe("~");
  });
  it("base under home and target outside gives the absolute path with /", () => {
    const t = join(root, "elsewhere", "k.json");
    expect(storedPath(t, base(), home)).toBe(slash(t));
  });
  it("empty stays empty; ~/x is expanded first", () => {
    expect(storedPath("", base(), home)).toBe("");
    expect(storedPath("~/proj/k.json", join(root, "elsewhere"), home)).toBe("~/proj/k.json");
    expect(slash(storedPath("~/proj/k.json", base(), home))).toBe("../../proj/k.json");
  });
  it("a drive-letter target the base does not hold comes back with /", () => {
    // a drive other than the temp folder's, so Windows cannot reach it with ../ either
    const d = /^z:/i.test(root) ? "Y" : "Z";
    expect(storedPath(`${d}:\\kits\\x.json`, join(root, "elsewhere"), home)).toBe(`${d}:/kits/x.json`);
  });
  it("encoding an encoded value changes nothing, and no result holds the home text", () => {
    const cases: [string, string][] = [
      [join(home, "proj", "k.json"), base()],
      [join(home, "proj", "k.json"), join(root, "elsewhere")],
      [join(root, "elsewhere", "k.json"), base()],
      [join(base(), "a.png"), base()],
    ];
    for (const [t, b] of cases) {
      const once = storedPath(t, b, home);
      expect(storedPath(once, b, home)).toBe(once);
      expect(once).not.toContain("home/");
      expect(once.includes(slash(home))).toBe(false);
    }
  });
});

describe("resolveStored", () => {
  it("round-trips the inside, home and outside cases", () => {
    const b = join(home, "Desktop", "out");
    const cases: [string, string][] = [
      [join(b, "a.png"), b],
      [join(home, "proj", "k.json"), b],
      [join(home, "proj", "k.json"), join(root, "elsewhere")],
      [join(root, "elsewhere", "k.json"), b],
      [join(root, "elsewhere", "scripts", "x.js"), join(root, "elsewhere", "a")],
    ];
    for (const [p, d] of cases) {
      expect(slash(resolveStored(storedPath(p, d, home), d, home))).toBe(slash(resolve(p)));
    }
  });
  it("../../x.json resolves against baseDir", () => {
    const b = join(root, "a", "b");
    expect(resolveStored("../../x.json", b, home)).toBe(join(root, "x.json"));
  });
  it("absolute paths of either OS come back unchanged; empty stays empty", () => {
    expect(resolveStored("/home/x/a.af", root, home)).toBe("/home/x/a.af");
    expect(resolveStored("C:\\work\\a.af", root, home)).toBe("C:\\work\\a.af");
    expect(resolveStored("", root, home)).toBe("");
  });
});

describe("scrubHome", () => {
  const h = "/home/x";
  it("home alone, with / and \\ tails, and inside text", () => {
    expect(scrubHome(h, h)).toBe("~");
    expect(scrubHome(`${h}/Desktop/a.png`, h)).toBe("~/Desktop/a.png");
    expect(scrubHome(`${h}\\Desktop\\a.png`, h)).toBe("~/Desktop/a.png");
    expect(scrubHome(`see ${h}/x`, h)).toBe("see ~/x");
  });
  it("a longer name is untouched", () => {
    expect(scrubHome(`${h}2/x`, h)).toBe(`${h}2/x`);
  });
  it("copies nested values without mutating the input; non-strings pass through", () => {
    const input = { a: [`${h}/p`, 3, null, { b: `${h}/q`, c: true }], n: 1 };
    const snapshot = JSON.stringify(input);
    const out = scrubHome(input, h);
    expect(out).toEqual({ a: ["~/p", 3, null, { b: "~/q", c: true }], n: 1 });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
  });
  it("a drive-letter home is matched in every spelling and case", () => {
    const w = "C:\\Profiles\\x";
    expect(scrubHome("c:/profiles/x/a", w)).toBe("~/a");
    expect(scrubHome("/c/Profiles/x/a", w)).toBe("~/a");
    expect(scrubHome("C:\\Profiles\\x\\a", w)).toBe("~/a");
    expect(scrubHome("C:/Profiles/xy/a", w)).toBe("C:/Profiles/xy/a");
  });
  it("a one-character home scrubs nothing", () => {
    expect(scrubHome("/a/b", "/")).toBe("/a/b");
    expect(scrubHome({ k: "xx/y" }, "x")).toEqual({ k: "xx/y" });
  });
});
