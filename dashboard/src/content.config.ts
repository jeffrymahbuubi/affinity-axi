import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        /** What a generated page was built from; hand-written pages leave it out. */
        kind: z.enum(['about', 'command', 'example', 'helper', 'platform']).optional(),
        /** Gallery-relative source of a generated page, for the checker. */
        source: z.string().optional(),
      }),
    }),
  }),
};
