// altFor: pure alt-text stub from an Inventory.

import { describe, expect, it } from "vitest";
import { ALT_MAX, NO_ALT_FLAG, altFor } from "../src/affinity/alt-text.js";
import type { Inventory, InventoryNode } from "../src/affinity/manifest-types.js";

const row = (path: string, box: [number, number, number, number], text: string | undefined, over: Partial<InventoryNode> = {}): InventoryNode => ({
  path,
  type: text === undefined ? "Rectangle" : "ArtText",
  name: "",
  box,
  visible: true,
  artboard: "ig-square",
  ...(text !== undefined ? { text } : {}),
  ...over,
});

const inv = (nodes: InventoryNode[]): Inventory => ({
  at: "t",
  doc: { uuid: "u", title: "t", path: "", units: "Pixel", width: 2400, height: 1080, dpi: 72 },
  artboards: [],
  nodes,
  counts: { nodes: nodes.length, named: 0, text: nodes.filter((n) => n.text !== undefined).length, images: 0 },
});

describe("altFor", () => {
  it("orders top-down then left-right and joins with '. '", () => {
    const i = inv([
      row("0/0/0", [100, 600, 200, 40], "Studio hours"),
      row("0/0/1", [300, 100, 400, 90], "measured"),
      row("0/0/2", [100, 100, 150, 90], "Light"),
    ]);
    expect(altFor(i, { kind: "all" })).toBe("Light. measured. Studio hours");
    const j = inv([row("0/0/0", [100, 600, 200, 40], "Studio hours"), row("0/0/1", [100, 100, 400, 90], "Light, measured")]);
    expect(altFor(j, { kind: "all" })).toBe("Light, measured. Studio hours");
  });

  it("collapses whitespace, trims, skips empty and hidden text and rows without text", () => {
    const i = inv([
      row("0/0/0", [0, 0, 10, 10], "  Hello \n  world  "),
      row("0/0/1", [0, 20, 10, 10], "   "),
      row("0/0/2", [0, 30, 10, 10], "ghost", { visible: false }),
      row("0/0/3", [0, 40, 10, 10], undefined),
      row("0/0/4", [0, 50, 10, 10], "Next"),
    ]);
    expect(altFor(i, { kind: "all" })).toBe("Hello world. Next");
  });

  it("does not double a trailing sentence mark", () => {
    const i = inv([row("0/0/0", [0, 0, 1, 1], "Open daily."), row("0/0/1", [0, 10, 1, 1], "Call us!"), row("0/0/2", [0, 20, 1, 1], "Why?"), row("0/0/3", [0, 30, 1, 1], "Visit")]);
    expect(altFor(i, { kind: "all" })).toBe("Open daily. Call us! Why? Visit");
  });

  it("caps at 125 on a word boundary without an ellipsis", () => {
    const words = Array.from({ length: 40 }, (_, k) => `word${k}`).join(" ");
    const i = inv([row("0/0/0", [0, 0, 1, 1], words)]);
    const out = altFor(i, { kind: "all" });
    expect(ALT_MAX).toBe(125);
    expect(out.length).toBeLessThanOrEqual(125);
    expect(words.startsWith(out)).toBe(true);
    expect(words[out.length]).toBe(" ");
    expect(out).not.toMatch(/\.\.\.|…/);
    expect(altFor(i, { kind: "all" }, 20)).toBe("word0 word1 word2");
  });

  it("hard-cuts a single word longer than the cap and strips a dangling comma", () => {
    expect(altFor(inv([row("0/0/0", [0, 0, 1, 1], "x".repeat(200))]), { kind: "all" })).toHaveLength(125);
    expect(altFor(inv([row("0/0/0", [0, 0, 1, 1], "alpha beta, gamma")]), { kind: "all" }, 11)).toBe("alpha beta");
  });

  it("is empty when the area has no text", () => {
    expect(altFor(inv([row("0/0/0", [0, 0, 1, 1], undefined)]), { kind: "all" })).toBe("");
    expect(altFor(inv([]), { kind: "all" })).toBe("");
    expect(altFor(inv([row("0/0/0", [0, 0, 1, 1], "Hi")]), { kind: "artboard", name: "other" })).toBe("");
  });

  it("filters by artboard name", () => {
    const i = inv([
      row("0/0/0", [0, 0, 1, 1], "Square", { artboard: "ig-square" }),
      row("0/1/0", [1200, 0, 1, 1], "Story", { artboard: "ig-story" }),
      row("0/2", [2400, 0, 1, 1], "Loose", { artboard: undefined }),
    ]);
    expect(altFor(i, { kind: "artboard", name: "ig-story" })).toBe("Story");
    expect(altFor(i, { kind: "artboard", name: "ig-square" })).toBe("Square");
  });

  it("filters by spread index through the path prefix", () => {
    const i = inv([row("0/0/0", [0, 0, 1, 1], "First"), row("1/0/0", [0, 0, 1, 1], "Second"), row("10/0/0", [0, 0, 1, 1], "Tenth")]);
    expect(altFor(i, { kind: "spread", spread: 1 })).toBe("Second");
    expect(altFor(i, { kind: "spread", spread: 0 })).toBe("First");
  });

  it("filters by box through the node centre", () => {
    const i = inv([
      row("0/0/0", [0, 0, 100, 100], "Inside"), // centre 50,50
      row("0/0/1", [90, 0, 100, 100], "Edge"), // centre 140,50
      row("0/0/2", [500, 500, 40, 40], "Far"),
    ]);
    expect(altFor(i, { kind: "box", box: [0, 0, 200, 200] })).toBe("Inside. Edge");
    expect(altFor(i, { kind: "box", box: [0, 0, 100, 100] })).toBe("Inside");
  });

  it("exports the shared --no-alt flag", () => {
    expect(NO_ALT_FLAG).toMatchObject({ name: "no-alt", type: "boolean" });
  });
});
