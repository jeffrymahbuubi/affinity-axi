// axiOpen: absolute path forms (POSIX, drive with either slash, UNC), ~/Desktop expansion
// and the slash/case-insensitive already-open check for Windows paths.

import { describe, expect, it } from "vitest";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { NAMED_SOURCE } from "../src/affinity/helpers-named.js";

const BS = "\\";
const winPath = "C:" + BS + "Work" + BS + "Desk" + BS + "a.af";
const fwdPath = ["C:", "work", "desk", "a.af"].join("/");
const unc = BS + BS + "srv" + BS + "share" + BS + "a.af";

function load(desktop: string, paths: string[]) {
  const loaded: string[] = [];
  const all = paths.map((p) => ({ path: p }));
  const req = (m: string): unknown => {
    if (m === "/document.js") return { Document: { all, load: (p: string) => (loaded.push(p), { path: p, fresh: true }) } };
    if (m === "/application.js") return { Application: { userDesktopPath: desktop } };
    throw new Error("unexpected require " + m);
  };
  const axiOpen = new Function("require", `${HELPERS_SOURCE}\n${NAMED_SOURCE}\nreturn axiOpen;`)(req) as (p: unknown) => any;
  return { axiOpen, loaded, all };
}

describe("axiOpen paths", () => {
  it("accepts drive (both slashes) and UNC paths and loads them unchanged", () => {
    const { axiOpen, loaded } = load("/data/x/Desktop", []);
    for (const p of [winPath, fwdPath, unc, "/data/x/b.af"]) axiOpen(p);
    expect(loaded).toEqual([winPath, fwdPath, unc, "/data/x/b.af"]);
  });

  it("matches an open Windows path across slash direction and case, without loading", () => {
    const { axiOpen, loaded, all } = load("/data/x/Desktop", [winPath]);
    expect(axiOpen(fwdPath)).toBe(all[0]);
    expect(axiOpen(fwdPath.toUpperCase())).toBe(all[0]);
    expect(axiOpen(winPath.toLowerCase())).toBe(all[0]);
    expect(loaded).toEqual([]);
  });

  it("keeps POSIX matching exact", () => {
    const { axiOpen, loaded, all } = load("/data/x/Desktop", ["/data/x/a.af"]);
    expect(axiOpen("/data/x/a.af")).toBe(all[0]);
    axiOpen("/data/x/A.af");
    expect(loaded).toEqual(["/data/x/A.af"]);
  });

  it("expands ~/Desktop through axiFilePath and refuses other ~/ folders", () => {
    expect(load("/data/x/Desktop", []).axiOpen("~/Desktop/a.af").path).toBe("/data/x/Desktop/a.af");
    const wd = "C:" + BS + "Work" + BS + "Desktop";
    expect(load(wd, []).axiOpen("~/Desktop/a.af").path).toBe(wd + BS + "a.af");
    expect(() => load(wd, []).axiOpen("~/Documents/a.af")).toThrow(/^axiOpen: cannot read '~\/Documents\/a\.af'/);
  });

  it("refuses relative and non-string values, naming the received value", () => {
    const { axiOpen } = load("/data/x/Desktop", []);
    for (const [v, got] of [["a.af", "'a.af'"], ["Desktop/a.af", "'Desktop/a.af'"], ["C:a.af", "'C:a.af'"], [undefined, "undefined"], [7, "7"]] as const) {
      expect(() => axiOpen(v)).toThrow(/absolute/);
      expect(() => axiOpen(v)).toThrow(got);
    }
  });
});
