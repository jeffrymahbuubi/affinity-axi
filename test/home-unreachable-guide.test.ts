// The unreachable home views and the guide rules point at the offline guide (issue #13, #7, #8).

import { describe, expect, it } from "vitest";
import { FIX_TEXT, PLACEHOLDER_STATE, renderBrief, renderGuide, renderHomeBody } from "../src/guide/content.js";

const down = { ...PLACEHOLDER_STATE, connected: false };
const GUIDE_LINE = "affinity-axi docs read guide --grep <regex>   # this tool's usage rules; works offline, without Affinity";

describe("unreachable views name the offline guide", () => {
  it("home body has a third help line", () => {
    const out = renderHomeBody("affinity-axi", down);
    expect(out).toContain("help[3]:");
    expect(out).toContain(`  ${GUIDE_LINE}`);
  });

  it("brief has a guide line before help", () => {
    const lines = renderBrief("affinity-axi", down).split("\n");
    expect(lines).toEqual([
      "affinity: unreachable",
      `fix: ${FIX_TEXT}`,
      "guide: affinity-axi docs read guide   # works offline, without Affinity",
      "help: affinity-axi",
    ]);
  });
});

describe("guide rules", () => {
  const g = renderGuide();
  it("documents the ARGS default, the Desktop ~ rule and --brief", () => {
    expect(g).toContain("`run` always defines `ARGS`");
    expect(g).toContain("without them `ARGS` is `{}`");
    expect(g).toContain("give raw SDK calls an absolute path");
    expect(g).toContain("add `--brief` (or `--quiet`) to `export`, `doc save` and `doc close`");
  });
});
