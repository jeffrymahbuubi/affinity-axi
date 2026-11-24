import { describe, expect, it } from "vitest";
import type { Parsed } from "../src/cli/args.js";
import { MAX_SIDE } from "../src/affinity/export-area.js";
import { parseToon } from "../src/output/toon.js";
import { UsageError } from "../src/output/errors.js";
import { DENSITIES, parseSafeZone, parseSizePlan, probePath, safePairs, sizedTargets, sizesReport } from "../src/commands/export-sizes.js";

const P = "~/Desktop/icons/icon-{size}.png";
const D = "~/Desktop/res/mipmap-{density}/ic.png";
const flags = (f: Record<string, string | boolean>): Parsed => ({ positionals: [], flags: f, help: false });

function usage(f: Record<string, string | boolean>, path: string): string {
  try {
    parseSizePlan(flags(f), path);
  } catch (e) {
    expect(e).toBeInstanceOf(UsageError);
    return (e as UsageError).message;
  }
  throw new Error("no error");
}

describe("parseSizePlan", () => {
  it("returns null without the flags", () => {
    expect(parseSizePlan(flags({}), "~/Desktop/a.png")).toBeNull();
  });

  it("gives sizes in the order typed", () => {
    expect(parseSizePlan(flags({ sizes: "512, 192" }), P)).toEqual({ kind: "sizes", items: [{ px: 512 }, { px: 192 }] });
  });

  it("computes density sizes from the base", () => {
    const plan = parseSizePlan(flags({ densities: "mdpi,xxxhdpi", base: "48" }), D)!;
    expect(plan.items).toEqual([{ px: 48, density: "mdpi" }, { px: 192, density: "xxxhdpi" }]);
    expect(plan.base).toBe(48);
    expect(parseSizePlan(flags({ densities: "hdpi" }), D)!.items[0]!.px).toBe(72);
    expect(parseSizePlan(flags({ densities: "ldpi", base: "25" }), D)!.items[0]!.px).toBe(19);
    expect(DENSITIES).toHaveLength(6);
  });

  it("accepts {size} in a densities path", () => {
    expect(parseSizePlan(flags({ densities: "mdpi,hdpi" }), "~/Desktop/i-{size}.png")!.items).toHaveLength(2);
  });

  it("reports every usage error with its text", () => {
    expect(usage({ sizes: "1", densities: "mdpi" }, P)).toBe("--sizes and --densities are mutually exclusive");
    for (const k of ["width", "height", "scale", "square"]) {
      expect(usage({ sizes: "64", [k]: "2" }, P)).toBe("--sizes and --densities cannot be combined with --width, --height, --scale or --square");
    }
    expect(usage({ sizes: "64", "max-kb": "10" }, P)).toBe("--sizes and --densities cannot be combined with --max-kb");
    expect(usage({ base: "48" }, "~/Desktop/a.png")).toBe("--base needs --densities");
    expect(usage({ sizes: "64", base: "48" }, P)).toBe("--base needs --densities");
    expect(usage({ sizes: "0" }, P)).toBe("invalid --sizes '0'");
    expect(usage({ sizes: "64,x" }, P)).toBe("invalid --sizes '64,x'");
    expect(usage({ sizes: "64,64" }, P)).toBe("invalid --sizes '64,64'");
    expect(usage({ sizes: "64,,8" }, P)).toBe("invalid --sizes '64,,8'");
    expect(usage({ sizes: String(MAX_SIDE + 1) }, P)).toBe(`invalid --sizes '${MAX_SIDE + 1}'`);
    expect(usage({ sizes: Array.from({ length: 13 }, (_, i) => i + 1).join(",") }, P)).toMatch(/^invalid --sizes/);
    expect(usage({ densities: "mdpi,tvdpi" }, D)).toBe("unknown density 'tvdpi'");
    expect(usage({ densities: "mdpi", base: "0" }, D)).toBe("invalid --base '0'");
    expect(usage({ densities: "mdpi", base: "4097" }, D)).toBe("invalid --base '4097'");
    expect(usage({ densities: "mdpi", base: "4.5" }, D)).toBe("invalid --base '4.5'");
    expect(usage({}, "~/Desktop/{size}.png")).toBe("{size} in the path needs --sizes or --densities");
    expect(usage({}, "~/Desktop/{density}.png")).toBe("{density} in the path needs --densities");
    expect(usage({ sizes: "64" }, "~/Desktop/{size}/{density}.png")).toBe("{density} in the path needs --densities");
    expect(usage({ sizes: "64" }, "~/Desktop/a.png")).toBe("--sizes needs {size} in the path");
    expect(usage({ densities: "mdpi,hdpi" }, "~/Desktop/a.png")).toBe("--densities needs {density} or {size} in the path");
    expect(usage({ sizes: "64" }, "~/Desktop/a-{size}.svg")).toMatch(/^--sizes and --densities need a raster output path/);
    expect(usage({ densities: "mdpi" }, "~/Desktop/a-{density}")).toMatch(/got 'no extension'/);
  });

  it("lists the density keys in the suggestion", () => {
    try {
      parseSizePlan(flags({ densities: "foo" }), D);
    } catch (e) {
      expect((e as UsageError).suggestion).toContain("xxxhdpi");
    }
  });
});

describe("probePath and sizedTargets", () => {
  it("fills the placeholders", () => {
    expect(probePath("a/{density}/i-{size}.png")).toBe("a/mdpi/i-1.png");
  });

  it("keeps base order outside and expands folder segments", () => {
    const plan = parseSizePlan(flags({ densities: "mdpi,hdpi" }), D)!;
    const base = [
      { name: "a", path: "/d/res/mipmap-{density}/ic_a.png", area: null },
      { name: "b", path: "/d/res/mipmap-{density}/ic_b.png", area: null },
    ];
    const out = sizedTargets(base, plan);
    expect(out.map((t) => t.path)).toEqual([
      "/d/res/mipmap-mdpi/ic_a.png",
      "/d/res/mipmap-hdpi/ic_a.png",
      "/d/res/mipmap-mdpi/ic_b.png",
      "/d/res/mipmap-hdpi/ic_b.png",
    ]);
    expect(out.map((t) => [t.name, t.px, t.density])).toEqual([["a", 48, "mdpi"], ["a", 72, "hdpi"], ["b", 48, "mdpi"], ["b", 72, "hdpi"]]);
  });

  it("expands {size} for a sizes plan", () => {
    const plan = parseSizePlan(flags({ sizes: "192,512" }), P)!;
    const out = sizedTargets([{ name: "", path: "/d/icon-{size}.png", area: null }], plan);
    expect(out.map((t) => t.path)).toEqual(["/d/icon-192.png", "/d/icon-512.png"]);
    expect(out[0]!.density).toBeUndefined();
  });
});

describe("parseSafeZone", () => {
  it("is null without the flag", () => {
    expect(parseSafeZone(flags({}), "a.png", false)).toBeNull();
  });

  it("knows both presets and fractions", () => {
    expect(parseSafeZone(flags({ "safe-zone": "android-adaptive" }), "a.png", false)).toEqual({ label: "android-adaptive", fraction: 66 / 108 });
    expect(parseSafeZone(flags({ "safe-zone": "pwa-maskable" }), "a.PNG", false)).toEqual({ label: "pwa-maskable", fraction: 0.8 });
    expect(parseSafeZone(flags({ "safe-zone": "0.75" }), "a.png", false)!.fraction).toBe(0.75);
    expect(parseSafeZone(flags({ "safe-zone": "1" }), "a.png", false)!.fraction).toBe(1);
  });

  it("rejects bad values, paths and --all-artboards", () => {
    const msg = (v: string, path = "a.png", all = false): string => {
      try {
        parseSafeZone(flags({ "safe-zone": v }), path, all);
      } catch (e) {
        return (e as UsageError).message;
      }
      return "";
    };
    for (const v of ["0", "1.5", "-1", "abc", "toString", ""]) expect(msg(v)).toBe(`invalid --safe-zone '${v}'`);
    expect(msg("0.5", "a.jpg")).toBe("--safe-zone needs a .png output path");
    expect(msg("0.5", "a.png", true)).toBe("--safe-zone cannot be combined with --all-artboards");
  });
});

describe("safePairs", () => {
  it("formats ok and outside results", () => {
    const ok = safePairs("/d/a.png", "android-adaptive", { ok: true, farthest: 100.04, limit: 132, at: { x: 3, y: 4 }, painted: 5 });
    expect(Object.fromEntries(ok)).toMatchObject({
      safe_zone: "ok",
      safe_circle: "android-adaptive (0.611 of the side)",
      farthest_px: "100.0",
      limit_px: "132.0",
      farthest_at: "3,4",
    });
    expect(Object.fromEntries(ok)["safe_checked"]).toContain("a.png");
    const out = Object.fromEntries(safePairs("/d/a.png", "0.8", { ok: false, farthest: 150, limit: 100, at: null, painted: 0 }));
    expect(out).toMatchObject({ safe_zone: "outside", safe_circle: "0.8 (0.800 of the side)", farthest_at: "-" });
  });
});

describe("sizesReport", () => {
  const w = (name: string, density: string | undefined, px: number, alt?: string): Parameters<typeof sizesReport>[4][number] => ({
    name,
    path: `/d/${name || "x"}-${px}.png`,
    area: null,
    bytes: 1000 + px,
    size: `${px}x${px}`,
    px,
    ...(density ? { density } : {}),
    ...(alt !== undefined ? { alt } : {}),
  });

  it("reports sizes for a single area", () => {
    const plan = parseSizePlan(flags({ sizes: "192,512" }), P)!;
    const text = sizesReport("U1", { mode: "whole", spread: 0 }, "PNG", plan, [w("", undefined, 192), w("", undefined, 512)], [], false);
    expect(parseToon(text).ok).toBe(true);
    expect(text).toContain("doc: U1");
    expect(text).toContain("exports[2]{path,bytes,size}:");
    expect(text).not.toContain("alt");
    expect(text).not.toContain("help");
    expect(text).not.toContain("base_dp");
  });

  it("reports densities for one artboard with alt and tags", () => {
    const plan = parseSizePlan(flags({ densities: "mdpi,hdpi", base: "108" }), D)!;
    const text = sizesReport("U1", { mode: "artboard", artboard: "fg", spread: 0 }, "PNG", plan, [w("fg", "mdpi", 108, "a logo"), w("fg", "hdpi", 162, "")], [["provenance", "x"]], true);
    expect(parseToon(text).ok).toBe(true);
    expect(text).toContain("artboard: fg");
    expect(text).toContain("base_dp: 108");
    expect(text).toContain("exports[2]{density,path,bytes,size,alt}:");
    expect(text).toContain("a logo");
    expect(text).toContain("(none; add one)");
    expect(text).toContain("provenance: x");
    expect(text).toContain("edit the alt text before publishing");
    expect(text).not.toMatch(/^artboard,/m);
  });

  it("reports all artboards with densities", () => {
    const plan = parseSizePlan(flags({ densities: "mdpi" }), D)!;
    const text = sizesReport("U1", { mode: "all", spread: 0 }, "PNG", plan, [w("a", "mdpi", 48), w("b", "mdpi", 48)], [], false);
    expect(parseToon(text).ok).toBe(true);
    expect(text).toContain("exports[2]{artboard,density,path,bytes,size}:");
    expect(text).not.toContain("\nartboard:");
  });
});
