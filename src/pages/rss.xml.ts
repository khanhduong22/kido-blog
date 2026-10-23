// src/pages/rss.xml.ts - RSS 2.0 Feed Generator
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async (context) => {
  const posts = await getCollection('blog');
  const sorted = posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  return rss({
    title: 'Kido Engineering Blog',
    description: 'Deep-Dive System Architecture, High-Concurrency Backend, Core Web Vitals & Distributed Infrastructure by Dương Phúc Khánh',
    site: context.site || 'https://blog.khanhdp.com',
    items: sorted.map((post) => ({
      title: post.data.title,
      pubDate: post.data.pubDate,
      description: post.data.description,
      link: `/blog/${post.id.replace(/\.md$/, '')}/`,
      categories: [post.data.category, ...post.data.tags],
      author: 'khanhdp2202@gmail.com (Dương Phúc Khánh)',
    })),
    customData: `<language>vi-VN</language>`,
  });
};
