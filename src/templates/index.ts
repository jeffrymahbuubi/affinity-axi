// The template pack: five ready-made, fillable documents built on a brand kit.
// Each template's source is a String.raw script (see social.ts); `templates new`
// injects ARGS and the kit, appends the helpers and runs it. Sizes come from the
// platform table (axiPlatform), so a size change there is caught by a test.

import { CAROUSEL_COVER, IG_POST, IG_STORY } from "./social.js";
import { OG_CARD, PRICE_POST } from "./web.js";

export interface Template {
  name: string;
  title: string;
  w: number;
  h: number;
  /** The platform table key this size comes from. */
  platform: string | null;
  /** Names of the slot:<key> elements, in document order. */
  slots: string[];
  /** The script: prints one JSON line {uuid, slots} and never closes a document. */
  source: string;
}

export const TEMPLATES: readonly Template[] = [
  { name: "ig-post", title: "Instagram feed post with photo", w: 1080, h: 1080, platform: "ig-square", slots: ["headline", "sub", "photo", "cta"], source: IG_POST },
  { name: "ig-story", title: "Story with photo, inside the story safe zone", w: 1080, h: 1920, platform: "story", slots: ["headline", "sub", "photo", "cta"], source: IG_STORY },
  { name: "carousel-cover", title: "4:5 carousel cover with photo", w: 1080, h: 1350, platform: "ig-portrait", slots: ["headline", "sub", "photo", "cta"], source: CAROUSEL_COVER },
  { name: "og-card", title: "Open Graph link card", w: 1200, h: 630, platform: "og", slots: ["headline", "sub", "cta", "url"], source: OG_CARD },
  { name: "price-post", title: "Price list post with a table", w: 1080, h: 1080, platform: "ig-square", slots: ["headline", "sub", "footnote", "cta"], source: PRICE_POST },
];

/** The template called name, or undefined. */
export function templateByName(name: string): Template | undefined {
  return TEMPLATES.find((t) => t.name === name);
}
