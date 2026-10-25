// paths: the one module for user paths, the Desktop sandbox and the hidden-folder rule.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError } from "../src/output/errors.js";
import {
  expandHome,
  hiddenSegment,
  isInside,
  realish,
  requireUnderDesktop,
  requireVisible,
  userPath,
  type DesktopAccess,
} from "../src/affinity/paths.js";

let root: string;
let dir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "axi-paths-")));
  dir = join(root, "Desktop");
  mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function usage(fn: () => void): UsageError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return e as UsageError;
  }
  throw new Error("expected a UsageError");
}

describe("expandHome and userPath", () => {
  it("expands ~ and ~/x and leaves everything else alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/a/b")).toBe(join(homedir(), "a/b"));
    expect(expandHome("~x")).toBe("~x");
    expect(expandHome("/abs")).toBe("/abs");
    expect(expandHome("rel")).toBe("rel");
  });

  it("userPath resolves a relative path and expands ~", () => {
    expect(userPath("rel")).toBe(resolve("rel"));
    expect(userPath("~/q")).toBe(join(homedir(), "q"));
  });
});

describe("realish", () => {
  it("returns the realpath of an existing file", () => {
    const f = join(dir, "a.af");
    writeFileSync(f, "x");
    expect(realish(f)).toBe(realpathSync(f));
  });

  it("keeps the missing tail after the deepest existing ancestor", () => {
    expect(realish(join(dir, "missing", "deeper.af"))).toBe(join(realpathSync(dir), "missing", "deeper.af"));
  });

  it("follows a symlinked parent", () => {
    const real = join(root, "real");
    mkdirSync(real);
    const link = join(root, "link");
    symlinkSync(real, link);
    expect(realish(join(link, "new.af"))).toBe(join(realpathSync(real), "new.af"));
  });
});

describe("isInside", () => {
  it("accepts the same path and a child", () => {
    expect(isInside(dir, dir)).toBe(true);
    expect(isInside(dir, join(dir, "sub", "x.af"))).toBe(true);
  });

  it("rejects a sibling that shares a name prefix", () => {
    const sibling = `${dir}2`;
    mkdirSync(sibling);
    expect(isInside(dir, join(sibling, "x.af"))).toBe(false);
  });

  it("rejects .. escapes", () => {
    expect(isInside(dir, join(dir, "..", "evil.af"))).toBe(false);
  });

  it("rejects a symlink inside dir that points outside", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(dir, "link"));
    expect(isInside(dir, join(dir, "link", "x.af"))).toBe(false);
  });

  it("accepts a dir reached through a symlinked parent", () => {
    const link = join(root, "deskLink");
    symlinkSync(dir, link);
    expect(isInside(link, join(dir, "x.af"))).toBe(true);
    expect(isInside(dir, join(link, "x.af"))).toBe(true);
  });
});

describe("hiddenSegment", () => {
  it("finds a hidden folder and a hidden file name", () => {
    expect(hiddenSegment("/a/.cache/x.af")).toBe(".cache");
    expect(hiddenSegment("/a/b/.x.af")).toBe(".x.af");
  });

  it("resolves first, so . and .. never count", () => {
    expect(hiddenSegment("/a/./b/../c.af")).toBeNull();
    expect(hiddenSegment("/a/b/c.af")).toBeNull();
  });

  it("returns the first hidden segment", () => {
    expect(hiddenSegment("/a/.b/.c")).toBe(".b");
  });

  it("does not count a dot inside a name", () => {
    expect(hiddenSegment("/a/b.c/d.af")).toBeNull();
  });
});

describe("requireVisible", () => {
  it("throws a usage error with the frozen texts", () => {
    const p = "/a/.cache/x.af";
    const err = usage(() => requireVisible(p, "save path"));
    expect(err.exitCode).toBe(2);
    expect(err.message).toBe(`save path is inside a hidden folder or file ('.cache'): ${p}`);
    expect(err.suggestion).toBe(
      "Affinity refuses dot-prefixed paths such as .affinity-axi/; choose a path whose folders and file name do not start with a dot",
    );
  });

  it("does not throw on a visible path", () => {
    expect(() => requireVisible("/a/b/c.af", "path")).not.toThrow();
  });
});

describe("requireUnderDesktop", () => {
  const outside = "/elsewhere/x.af";
  const cases: [DesktopAccess, (d: string) => string][] = [
    ["write-file", (d) => `Affinity can only write under ${d}; choose a path inside it`],
    ["write-folder", (d) => `Affinity can only write under ${d}; choose a folder inside it`],
    ["read-image", (d) => `Affinity can only read images under ${d}; copy it there`],
    ["open", (d) => `Affinity can only open files under ${d}`],
  ];

  for (const [access, text] of cases) {
    it(`gives the ${access} suggestion`, () => {
      const err = usage(() => requireUnderDesktop(dir, outside, "image", access));
      expect(err.exitCode).toBe(2);
      expect(err.message).toBe(`image is outside the Desktop folder: ${outside}`);
      expect(err.suggestion).toBe(text(dir));
    });
  }

  it("does not throw for a path inside, even with a trailing slash on desktop", () => {
    expect(() => requireUnderDesktop(dir, join(dir, "x.af"), "path", "open")).not.toThrow();
    expect(() => requireUnderDesktop(`${dir}/`, join(dir, "x.af"), "path", "open")).not.toThrow();
  });
});
