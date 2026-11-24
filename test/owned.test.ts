// The ownership ledger (src/affinity/owned.ts): ids, times and a scope hash in <state dir>/owned.jsonl.

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markOwned, ownedPath, pruneOwned, readOwned, scopeOf } from "../src/affinity/owned.js";

const A = "AAAAAAAA-1111-4111-8111-111111111111";
const B = "BBBBBBBB-2222-4222-8222-222222222222";
let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "axi-owned-"));
  dir = join(root, "state");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("owned ledger", () => {
  it("marks and reads back, keyed by upper-case uuid", () => {
    markOwned([A, B], "run", { dir });
    const m = readOwned(dir);
    expect([...m.keys()].sort()).toEqual([A, B]);
    expect(m.get(A)).toMatchObject({ uuid: A, by: "run", scratch: false });
    expect(m.get(A)!.scope).toBe(scopeOf());
    expect(Number.isNaN(Date.parse(m.get(A)!.time))).toBe(false);
  });

  it("writes nothing for an empty list", () => {
    markOwned([], "run", { dir });
    expect(existsSync(ownedPath(dir))).toBe(false);
    expect(readOwned(dir).size).toBe(0);
  });

  it("skips a torn line and lines of the wrong shape", () => {
    markOwned([A], "batch", { dir });
    appendFileSync(ownedPath(dir), '{"time":"2026-01-01T00:00:00Z","uuid":"CCCC\n[1]\n{"uuid":"x"}\n');
    markOwned([B], "doc new", { dir });
    expect([...readOwned(dir).keys()].sort()).toEqual([A, B]);
  });

  it("a later line replaces an earlier one, but scratch stays true once set", () => {
    markOwned([A], "doc new", { dir, scratch: true });
    markOwned([A], "run", { dir });
    expect(readOwned(dir).get(A)).toMatchObject({ by: "run", scratch: true });
    markOwned([B], "run", { dir });
    markOwned([B], "batch", { dir, scratch: true });
    expect(readOwned(dir).get(B)).toMatchObject({ by: "batch", scratch: true });
  });

  it("lower-case input reads back upper-case", () => {
    markOwned([A.toLowerCase()], "run", { dir });
    expect(readOwned(dir).has(A)).toBe(true);
    expect(readFileSync(ownedPath(dir), "utf8")).not.toContain(A.toLowerCase());
  });

  it("two cwds give two scopes and no path is stored", () => {
    const one = join(root, "one");
    const two = join(root, "two");
    mkdirSync(one);
    mkdirSync(two);
    expect(scopeOf(one)).not.toBe(scopeOf(two));
    expect(scopeOf(one)).toMatch(/^[0-9a-f]{12}$/);
    markOwned([A], "run", { dir, cwd: one });
    markOwned([B], "run", { dir, cwd: two });
    const m = readOwned(dir);
    expect(m.get(A)!.scope).toBe(scopeOf(one));
    expect(m.get(B)!.scope).toBe(scopeOf(two));
    const text = readFileSync(ownedPath(dir), "utf8");
    expect(text).not.toContain("one");
    expect(text).not.toContain(root);
  });

  it("pruneOwned keeps only the open ids and removes an empty file", () => {
    markOwned([A, B], "run", { dir });
    pruneOwned([B.toLowerCase()], dir);
    expect([...readOwned(dir).keys()]).toEqual([B]);
    pruneOwned([], dir);
    expect(existsSync(ownedPath(dir))).toBe(false);
    pruneOwned([A], dir); // no file: no throw
  });

  it("an unwritable folder does not throw", () => {
    const blocker = join(root, "file");
    writeFileSync(blocker, "x");
    expect(() => markOwned([A], "run", { dir: join(blocker, "sub") })).not.toThrow();
    expect(() => pruneOwned([A], join(blocker, "sub"))).not.toThrow();
    expect(readOwned(join(blocker, "sub")).size).toBe(0);
  });

  it("the default folder follows AFFINITY_AXI_HOME", () => {
    const home = process.env["AFFINITY_AXI_HOME"]!;
    expect(ownedPath()).toBe(join(home, "owned.jsonl"));
    markOwned([A], "doc new");
    expect(readOwned().has(A)).toBe(true);
    expect(existsSync(join(home, "owned.jsonl"))).toBe(true);
  });
});
