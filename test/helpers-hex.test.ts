// axiHex: the colour helper's error text. CORE_SOURCE is evaluated with a stub require.

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { CORE_SOURCE } from "../src/affinity/helpers-core.js";

type AxiHex = (hex: unknown, alpha?: number) => unknown[];

function load(): AxiHex {
  const stub = (id: string): Record<string, unknown> => {
    if (id !== "/colours.js") throw new Error(`unexpected require ${id}`);
    return { RGBA8: (...args: unknown[]) => args };
  };
  return runInNewContext(`${CORE_SOURCE}\n;axiHex`, { require: stub }) as AxiHex;
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("did not throw");
}

describe("axiHex", () => {
  const axiHex = load();

  it("still converts #RGB, #RRGGBB and alpha", () => {
    expect(axiHex("#fff")).toEqual([255, 255, 255, 255]);
    expect(axiHex("#1A2B3C", 0.5)).toEqual([0x1a, 0x2b, 0x3c, 128]);
  });

  it("names the expected form and quotes a bad string", () => {
    const m = message(() => axiHex("blue"));
    expect(m).toContain("bad colour");
    expect(m).toContain("expected a hex string");
    expect(m).toContain("got 'blue'");
    expect(m).not.toContain("colour object");
  });

  it("adds the colour-object hint for an object", () => {
    const m = message(() => axiHex({ toString: () => "[object Colour]" }));
    expect(m).toContain("bad colour");
    expect(m).toContain("that is a colour object");
    expect(m).toContain("got object [object Colour]");
  });

  it("reports undefined without the object hint", () => {
    const m = message(() => axiHex(undefined));
    expect(m).toContain("got undefined");
    expect(m).not.toContain("colour object");
  });
});
