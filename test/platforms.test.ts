// Platform size table, its generated axiPlatform helper and the offline `platforms` command.

import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { PLATFORMS, findPlatform, platformHelperSource, ratioOf, safeText, type PlatformRow } from "../src/affinity/platforms.js";
import { make as makePlatforms } from "../src/commands/platforms.js";
import { runCommand } from "./fake-mcp/client.js";

/** Evaluates only the generated axiPlatform source (it needs no SDK). */
function loadPlatform(rows?: readonly PlatformRow[]): (key: string) => PlatformRow {
  return new Function(`${platformHelperSource(rows)}; return axiPlatform;`)() as (key: string) => PlatformRow;
}

type SafeInsetsLike = NonNullable<PlatformRow["safe"]>;
const EXPECTED_ROWS = 44;

describe("platform table", () => {
  it("covers every platform the spec names", () => {
    const keys = PLATFORMS.map((p) => p.key);
    for (const k of ["ig-square", "ig-portrait", "story", "reel-cover", "fb-feed", "fb-link", "threads", "og", "x-card", "discover", "schema-16x9", "schema-4x3", "schema-1x1", "gbp-post", "favicon-32", "web-hero"]) {
      expect(keys).toContain(k);
    }
  });

  it("has unique kebab-case keys, positive integer sizes and notes", () => {
    const keys = PLATFORMS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of PLATFORMS) {
      expect(p.key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(Number.isInteger(p.w) && p.w > 0).toBe(true);
      expect(Number.isInteger(p.h) && p.h > 0).toBe(true);
      expect(p.notes.length).toBeGreaterThan(0);
    }
  });

  it("keeps safe-area insets inside the artboard, including the Stories insets", () => {
    for (const p of PLATFORMS) {
      const s = p.safe;
      if (!s) continue;
      expect((s.top ?? 0) + (s.bottom ?? 0)).toBeLessThan(p.h);
      expect((s.left ?? 0) + (s.right ?? 0)).toBeLessThan(p.w);
    }
    expect(findPlatform("story")).toMatchObject({ w: 1080, h: 1920, safe: { top: 250, bottom: 340 } });
    expect(findPlatform("nope")).toBeUndefined();
  });

  it("uses plain ASCII notes that are safe inside the script string", () => {
    for (const p of PLATFORMS) {
      expect(p.notes).toMatch(/^[\x20-\x7e]+$/);
      expect(p.notes).not.toContain("`");
      expect(p.notes).not.toContain("${");
    }
  });

  it("has the full table with every round 4 key at its size and safe insets", () => {
    expect(PLATFORMS).toHaveLength(EXPECTED_ROWS);
    const want: Record<string, [number, number, SafeInsetsLike | undefined]> = {
      tiktok: [1080, 1920, { top: 150, bottom: 480, left: 60, right: 140 }],
      "linkedin-post": [1200, 1200, undefined],
      "linkedin-link": [1200, 627, undefined],
      "linkedin-cover": [1584, 396, { left: 420, bottom: 100 }],
      "linkedin-company-cover": [1128, 191, undefined],
      "pinterest-pin": [1000, 1500, undefined],
      "youtube-thumbnail": [1280, 720, { bottom: 90, right: 180 }],
      "youtube-banner": [2560, 1440, { top: 508, bottom: 509, left: 507, right: 507 }],
      "x-header": [1500, 500, { left: 420, bottom: 60 }],
    };
    for (const [key, [w, h, safe]] of Object.entries(want)) {
      const row = findPlatform(key);
      expect(row, key).toBeDefined();
      expect(row!.w).toBe(w);
      expect(row!.h).toBe(h);
      expect(row!.safe).toEqual(safe);
    }
    expect(findPlatform("x-header")!.notes).toContain("avatar");
  });

  it("has the seven Google Display ad sizes, each noting the 150 KB cap", () => {
    const ads = PLATFORMS.filter((p) => p.key.startsWith("ad-"));
    expect(ads.map((p) => p.key)).toEqual(["ad-300x250", "ad-336x280", "ad-728x90", "ad-160x600", "ad-300x600", "ad-320x50", "ad-970x250"]);
    for (const a of ads) {
      expect(a.key).toBe(`ad-${a.w}x${a.h}`);
      expect(a.notes).toContain("150 KB");
      expect(a.safe).toBeUndefined();
    }
  });

  it("youtube-banner leaves the documented 1546x422 text-safe area free", () => {
    const b = findPlatform("youtube-banner")!;
    const s = b.safe!;
    expect(b.w - s.left! - s.right!).toBe(1546);
    expect(b.h - s.top! - s.bottom!).toBe(423);
    expect(s.left! + s.right!).toBeLessThan(b.w);
    expect(s.top! + s.bottom!).toBeLessThan(b.h);
  });

  it("formats safe insets as t b l r, or a dash", () => {
    const row = (safe?: PlatformRow["safe"]): PlatformRow => ({ key: "k", w: 10, h: 10, safe, notes: "n" });
    expect(safeText(row())).toBe("-");
    expect(safeText(row({}))).toBe("-");
    expect(safeText(row({ top: 0 }))).toBe("-");
    expect(safeText(findPlatform("story")!)).toBe("t250 b340");
    expect(safeText(findPlatform("ig-portrait")!)).toBe("l34 r34");
    expect(safeText(findPlatform("tiktok")!)).toBe("t150 b480 l60 r140");
    expect(safeText(row({ right: 5, top: 3, left: 4, bottom: 2 }))).toBe("t3 b2 l4 r5");
    expect(safeText(findPlatform("og")!)).toBe("-");
  });

  it("reduces ratios, falling back to a decimal for awkward ones", () => {
    expect(ratioOf(1080, 1080)).toBe("1:1");
    expect(ratioOf(1080, 1350)).toBe("4:5");
    expect(ratioOf(1080, 1920)).toBe("9:16");
    expect(ratioOf(1200, 900)).toBe("4:3");
    expect(ratioOf(1200, 628)).toBe("1.91:1");
  });
});

describe("axiPlatform generation", () => {
  it("returns every row of the TS table, so there is one source of truth", () => {
    const axiPlatform = loadPlatform();
    for (const p of PLATFORMS) expect(axiPlatform(p.key)).toEqual(p);
  });

  it("returns a copy, and an unknown key throws with the known keys", () => {
    const axiPlatform = loadPlatform();
    const a = axiPlatform("story");
    a.w = 1;
    expect(axiPlatform("story").w).toBe(1080);
    expect(() => axiPlatform("nope")).toThrow(/unknown key nope; known: .*story.*tiktok/);
  });

  it("exposes the new safe insets through the generated helper", () => {
    const axiPlatform = loadPlatform();
    expect(axiPlatform("tiktok").safe!.bottom).toBe(480);
    expect(axiPlatform("youtube-banner").safe).toEqual({ top: 508, bottom: 509, left: 507, right: 507 });
    expect(axiPlatform("ad-300x250")).toMatchObject({ w: 300, h: 250 });
  });

  it("generates from whatever table it is given", () => {
    const axiPlatform = loadPlatform([{ key: "x", w: 2, h: 3, notes: "n" }]);
    expect(axiPlatform("x")).toEqual({ key: "x", w: 2, h: 3, notes: "n" });
    expect(() => axiPlatform("story")).toThrow("known: x");
  });

  it("is embedded in HELPERS_SOURCE as one top-level function that passes the guards", () => {
    const src = platformHelperSource();
    expect(HELPERS_SOURCE).toContain(src);
    expect(src.match(/^function axi\w+\(/gm)).toEqual(["function axiPlatform("]);
    expect(scanForBlocking(src)).toEqual([]);
    expect(scanForAi(src)).toEqual([]);
  });
});

describe("platforms command", () => {
  const mod = makePlatforms(async () => {
    throw new Error("platforms must not connect");
  });

  it("prints the table without connecting", async () => {
    const r = await runCommand(mod, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`platforms[${PLATFORMS.length}]{key,size,ratio,safe,notes}:`);
    expect(r.stdout).toContain("  story,1080x1920,9:16,t250 b340,IG/FB Stories");
    expect(r.stdout).toContain("  ig-portrait,1080x1350,4:5,l34 r34,");
    expect(r.stdout).toContain("  og,1200x630,1.90:1,-,");
    expect(r.stdout).toContain("axiArtboards(doc, [{ platform: 'ig-square' }])");
  });

  it("--grep matches key, size, ratio and notes, case-insensitively, and reports the total", async () => {
    const byKey = await runCommand(mod, ["--grep", "STORY"]);
    expect(byKey.stdout).toMatch(new RegExp(`platforms\\[\\d+ of ${PLATFORMS.length} total\\]`));
    expect(byKey.stdout).toContain("  story,");
    expect(byKey.stdout).not.toContain("  og,");
    const bySize = await runCommand(mod, ["--grep", "1200x630"]);
    expect(bySize.stdout).toContain("  og,1200x630,");
    const byRatio = await runCommand(mod, ["--grep", "^4:3$"]);
    expect(byRatio.stdout).toContain("  schema-4x3,");
    expect(byRatio.stdout).toContain("  gbp-post,");
    const byNote = await runCommand(mod, ["--grep", "Marketplace"]);
    expect(byNote.stdout).toContain("  fb-link,");
  });

  it("--grep matches the safe column and the ad family", async () => {
    const banner = await runCommand(mod, ["--grep", "t508"]);
    expect(banner.stdout).toContain("  youtube-banner,2560x1440,16:9,t508 b509 l507 r507,");
    expect(banner.stdout).toMatch(new RegExp(`platforms\\[1 of ${PLATFORMS.length} total\\]\\{key,size,ratio,safe,notes\\}:`));
    const ads = await runCommand(mod, ["--grep", "^ad-"]);
    expect(ads.stdout).toMatch(new RegExp(`platforms\\[7 of ${PLATFORMS.length} total\\]`));
    expect(ads.stdout).toContain("  ad-300x250,300x250,6:5,-,Google Display medium rectangle; 150 KB max; export --max-kb 150");
  });

  it("a grep with no match exits 0 and says so; an invalid regex is a usage error", async () => {
    const none = await runCommand(mod, ["--grep", "zzzznothing"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain(`platforms: 0 matching 'zzzznothing' (${PLATFORMS.length} known)`);
    const bad = await runCommand(mod, ["--grep", "("]);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toContain("invalid --grep regex");
  });
});
