import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  // In Astro 5, loader: glob({ pattern: '**/*.md', base: './src/content/blog' }) or legacy collection
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.string(),
    cover: z.string(),
    coverAlt: z.string().optional(),
    author: z.string().default('Dương Phúc Khánh'),
    readingTime: z.string().default('10 phút'),
    featured: z.boolean().default(false),
    tags: z.array(z.string()).default([]),
    relatedEpisodes: z.array(z.object({
      ep: z.number(),
      title: z.string(),
      slug: z.string()
    })).default([]),
  }),
});

export const collections = { blog };
