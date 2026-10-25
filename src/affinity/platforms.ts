// Web and social image sizes as of October 2026. One source of truth:
// the `platforms` command prints this table and HELPERS_SOURCE embeds it as
// axiPlatform(key), generated from it, so the two cannot drift.
//
// Sizes are px. `safe` is the inset in px from each edge of the artboard that
// stays clear of platform UI (used by axiSafeZone as guides).

export interface SafeInsets {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface PlatformRow {
  key: string;
  w: number;
  h: number;
  safe?: SafeInsets;
  notes: string;
}

const STORY_SAFE: SafeInsets = { top: 250, bottom: 340 };

export const PLATFORMS: readonly PlatformRow[] = [
  { key: "ig-square", w: 1080, h: 1080, notes: "IG feed square; also FB, Threads, X" },
  { key: "ig-portrait", w: 1080, h: 1350, safe: { left: 34, right: 34 }, notes: "IG feed 4:5; the 3:4 grid crop trims about 34 px each side, keep text inside" },
  { key: "ig-portrait-34", w: 1080, h: 1440, notes: "IG feed 3:4, the new grid crop" },
  { key: "ig-landscape", w: 1080, h: 566, notes: "IG feed 1.91:1, rare now" },
  { key: "story", w: 1080, h: 1920, safe: STORY_SAFE, notes: "IG/FB Stories 9:16; keep 250 px top and 340 px bottom clear of UI" },
  { key: "reel-cover", w: 1080, h: 1920, safe: STORY_SAFE, notes: "Reels cover 9:16; the grid thumbnail crops the centre 3:4 (1080x1440)" },
  { key: "fb-feed", w: 1080, h: 1350, notes: "FB feed 4:5; 1080x1080 also works" },
  { key: "fb-link", w: 1200, h: 628, notes: "FB link preview and Marketplace ad 1.91:1; min 600 wide for the large card; from og:image" },
  { key: "fb-cover", w: 851, h: 315, safe: { left: 48, right: 48 }, notes: "FB Page cover; mobile shows the centre 2.4:1, keep text centred" },
  { key: "threads", w: 1080, h: 1350, notes: "Threads 4:5 recommended; 1080x1080 also works; up to 20 images" },
  { key: "og", w: 1200, h: 630, notes: "Open Graph 1.91:1; X summary_large_image accepts it with a slight crop" },
  { key: "x-card", w: 1200, h: 600, notes: "X summary_large_image prefers 2:1" },
  { key: "x-header", w: 1500, h: 500, safe: { left: 420, bottom: 60 }, notes: "X profile header 3:1; the avatar covers the lower left on web (approx)" },
  { key: "discover", w: 1200, h: 675, notes: "Google Discover 16:9, at least 1200 wide and 300,000 px; needs max-image-preview:large; from og:image" },
  { key: "schema-16x9", w: 1200, h: 675, notes: "Article/Product schema image 16:9; provide 16:9, 4:3 and 1:1" },
  { key: "schema-4x3", w: 1200, h: 900, notes: "Article/Product schema image 4:3" },
  { key: "schema-1x1", w: 1200, h: 1200, notes: "Article/Product schema image 1:1" },
  { key: "gbp-post", w: 1200, h: 900, notes: "Google Business Profile post, product or event 4:3; JPG/PNG 10 KB to 5 MB; no heavy filters (use axiLook('neutral'))" },
  { key: "gbp-logo", w: 720, h: 720, notes: "Google Business Profile logo 1:1" },
  { key: "gbp-cover", w: 1024, h: 576, notes: "Google Business Profile cover 16:9" },
  { key: "favicon-16", w: 16, h: 16, notes: "favicon, browser tab" },
  { key: "favicon-32", w: 32, h: 32, notes: "favicon, high-density tab" },
  { key: "favicon-48", w: 48, h: 48, notes: "favicon, Google Search results need a multiple of 48" },
  { key: "apple-touch-icon", w: 180, h: 180, notes: "iOS home screen icon; no transparency" },
  { key: "android-192", w: 192, h: 192, notes: "web app manifest icon" },
  { key: "android-512", w: 512, h: 512, notes: "web app manifest icon, maskable safe zone is the central 80%" },
  { key: "web-hero", w: 1920, h: 1080, notes: "web hero 16:9; keep the subject in the centre 60% for responsive crops" },
  { key: "web-hero-wide", w: 2400, h: 900, notes: "web hero banner 8:3 for wide desktop layouts" },
  { key: "web-hero-mobile", w: 1080, h: 1350, notes: "web hero 4:5 for phones" },
  // Video and vertical
  { key: "tiktok", w: 1080, h: 1920, safe: { top: 150, bottom: 480, left: 60, right: 140 }, notes: "TikTok video and photo 9:16; the caption and buttons cover the bottom and right (approx)" },
  // LinkedIn
  { key: "linkedin-post", w: 1200, h: 1200, notes: "LinkedIn feed post 1:1; 1200x627 also works" },
  { key: "linkedin-link", w: 1200, h: 627, notes: "LinkedIn link preview 1.91:1; from og:image" },
  { key: "linkedin-cover", w: 1584, h: 396, safe: { left: 420, bottom: 100 }, notes: "LinkedIn profile cover 4:1; the profile photo covers the lower left (approx)" },
  { key: "linkedin-company-cover", w: 1128, h: 191, notes: "LinkedIn company page cover" },
  // Pinterest
  { key: "pinterest-pin", w: 1000, h: 1500, notes: "Pinterest standard pin 2:3" },
  // YouTube
  { key: "youtube-thumbnail", w: 1280, h: 720, safe: { bottom: 90, right: 180 }, notes: "YouTube thumbnail 16:9; the duration badge covers the lower right (approx)" },
  { key: "youtube-banner", w: 2560, h: 1440, safe: { top: 508, bottom: 509, left: 507, right: 507 }, notes: "YouTube channel banner; text and logos stay in the centre 1546x422 safe area" },
  // Google Display ads (150 KB max)
  { key: "ad-300x250", w: 300, h: 250, notes: "Google Display medium rectangle; 150 KB max; export --max-kb 150" },
  { key: "ad-336x280", w: 336, h: 280, notes: "Google Display large rectangle; 150 KB max; export --max-kb 150" },
  { key: "ad-728x90", w: 728, h: 90, notes: "Google Display leaderboard; 150 KB max; export --max-kb 150" },
  { key: "ad-160x600", w: 160, h: 600, notes: "Google Display wide skyscraper; 150 KB max; export --max-kb 150" },
  { key: "ad-300x600", w: 300, h: 600, notes: "Google Display half page; 150 KB max; export --max-kb 150" },
  { key: "ad-320x50", w: 320, h: 50, notes: "Google Display mobile banner; 150 KB max; export --max-kb 150" },
  { key: "ad-970x250", w: 970, h: 250, notes: "Google Display billboard; 150 KB max; export --max-kb 150" },
];

/**
 * Compact safe-inset text in t b l r order: "t250 b340", "l34 r34", "-" when
 * the row has no safe zone (or only zero insets).
 */
export function safeText(row: PlatformRow): string {
  const s = row.safe;
  if (!s) return "-";
  const parts: string[] = [];
  if (s.top) parts.push(`t${s.top}`);
  if (s.bottom) parts.push(`b${s.bottom}`);
  if (s.left) parts.push(`l${s.left}`);
  if (s.right) parts.push(`r${s.right}`);
  return parts.length > 0 ? parts.join(" ") : "-";
}

/** Looks up a row by key; undefined when unknown. */
export function findPlatform(key: string): PlatformRow | undefined {
  return PLATFORMS.find((p) => p.key === key);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** "4:5" when the reduced ratio is small, else decimal "1.91:1". */
export function ratioOf(w: number, h: number): string {
  const g = gcd(w, h);
  const rw = w / g;
  const rh = h / g;
  if (rw <= 20 && rh <= 20) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

/**
 * JS source of axiPlatform(key): returns a copy of the row for key and throws
 * with the known keys when it is unknown. The table is embedded as JSON, one
 * row per line, indented so the block stays a single top-level function.
 */
export function platformHelperSource(rows: readonly PlatformRow[] = PLATFORMS): string {
  const lines = rows.map((r) => "    " + JSON.stringify(r));
  return [
    "// Platform size row {key,w,h,safe?,notes} (generated from src/affinity/platforms.ts, Oct 2026).",
    "// safe holds px insets {top,bottom,left,right} from the artboard edges. Throws for an unknown key.",
    "function axiPlatform(key) {",
    "  const rows = [",
    lines.join(",\n"),
    "  ];",
    "  const row = rows.find(function (r) { return r.key === key; });",
    "  if (!row) { throw new Error('axiPlatform: unknown key ' + key + '; known: ' + rows.map(function (r) { return r.key; }).join(', ')); }",
    "  return JSON.parse(JSON.stringify(row));",
    "}",
  ].join("\n");
}
