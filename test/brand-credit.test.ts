// Brand kit `credit`: validation, load, extraKeys, and `brand show` (offline).

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extraKeys, loadBrand, validateKit } from "../src/affinity/brand.js";
import { make as makeBrand } from "../src/commands/brand.js";
import { ConnectError, type ConnectFn } from "../src/mcp/types.js";
import { runCommand } from "./fake-mcp/client.js";

const KIT = {
  schema: "affinity-axi/brand/1",
  name: "Test Brand",
  colours: { ink: "#000000", mist: "#FFFFFF" },
  fonts: { headline: "Helvetica-Bold", body: "Helvetica" },
};
const withCredit = (credit: unknown): Record<string, unknown> => ({ ...KIT, credit });
const offline: ConnectFn = () => {
  throw new ConnectError("offline command connected", "it must not");
};

let root: string;
const origCwd = process.cwd();
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "axi-credit-")));
  process.chdir(root);
});
afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("brand kit credit", () => {
  it("a valid credit loads, is typed, and is not an extra key", () => {
    const kit = validateKit(withCredit({ creator: "Studio X", copyright: "(c) 2026 Studio X" }), "kit.json");
    expect(kit.credit).toEqual({ creator: "Studio X", copyright: "(c) 2026 Studio X" });
    expect(extraKeys(kit)).toEqual([]);
    expect(validateKit(withCredit({ creator: "Studio X" }), "kit.json").credit).toEqual({ creator: "Studio X" });
    expect(validateKit(KIT, "kit.json").credit).toBeUndefined();
  });

  it("round-trips through loadBrand", () => {
    writeFileSync(join(root, "k.brand.json"), JSON.stringify(withCredit({ creator: "Studio X" })));
    expect(loadBrand(join(root, "k.brand.json")).kit.credit).toEqual({ creator: "Studio X" });
  });

  const cases: Array<[string, unknown, RegExp]> = [
    ["a string", "Studio X", /credit must be an object/],
    ["an array", ["x"], /credit must be an object/],
    ["no creator", { copyright: "c" }, /credit\.creator must be a non-empty string/],
    ["an empty creator", { creator: "" }, /credit\.creator must be a non-empty string/],
    ["a blank creator", { creator: "   " }, /credit\.creator must be a non-empty string/],
    ["a numeric creator", { creator: 5 }, /credit\.creator must be a non-empty string/],
    ["a creator over 200 characters", { creator: "x".repeat(201) }, /credit\.creator must be 200 characters or fewer/],
    ["a numeric copyright", { creator: "a", copyright: 2026 }, /credit\.copyright must be a string/],
    ["a copyright over 500 characters", { creator: "a", copyright: "x".repeat(501) }, /credit\.copyright must be 500 characters or fewer/],
  ];
  it.each(cases)("rejects %s with the field path", (_name, credit, re) => {
    expect(() => validateKit(withCredit(credit), "kit.json")).toThrow(re);
    expect(() => validateKit(withCredit(credit), "kit.json")).toThrow(/^brand kit kit\.json: /);
  });

  it("accepts the boundary lengths", () => {
    expect(validateKit(withCredit({ creator: "x".repeat(200), copyright: "y".repeat(500) }), "k").credit?.creator).toHaveLength(200);
  });

  it("brand show prints the credit and stays offline", async () => {
    mkdirSync(join(root, "work"));
    const p = join(root, "work", "k.brand.json");
    writeFileSync(p, JSON.stringify(withCredit({ creator: "Studio X", copyright: "(c) 2026" })));
    const r = await runCommand(makeBrand(offline)["brand show"], [p]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("creator: Studio X");
    expect(r.stdout).toContain("copyright: (c) 2026");
    expect(r.stdout).not.toContain("extra:");
    writeFileSync(p, JSON.stringify(KIT));
    const none = await runCommand(makeBrand(offline)["brand show"], [p]);
    expect(none.stdout).not.toContain("creator:");
  });
});
