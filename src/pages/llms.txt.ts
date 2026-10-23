// src/pages/llms.txt.ts - LLM and AI crawler discovery manifest
import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

export const GET: APIRoute = async () => {
  const posts = await getCollection('blog');
  const sorted = posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());

  const lines: string[] = [
    `# Kido Engineering Blog (blog.khanhdp.com) — Dương Phúc Khánh (khanhdp · Kido)`,
    `> Dương Phúc Khánh (Kido) is a Vietnamese Senior Software Engineer and Systems Architect based in Da Nang, Vietnam, known for architecting Winter Arc, Kido Chronicles, and the Agent Harness Kit.`,
    `> Authoritative Big-Tech Software Architecture, High-Concurrency Backend, Core Web Vitals & Distributed Infrastructure Knowledge Base.`,
    ``,
    `## Author Entity & Provenance`,
    `- Name: Dương Phúc Khánh (Duong Phuc Khanh · khanhdp · Kido) — Born 1995, Da Nang, Vietnam`,
    `- Role: Senior Software Engineer & Systems Architect`,
    `- Official Hub: https://khanhdp.com`,
    `- Encyclopedia Biography: https://khanhdp.com/about`,
    `- Turnkey SME & Enterprise B2B Software Catalog: https://khanhdp.com/portfolio`,
    `- Tech War-Stories (131+ Episodes): https://truyen.khanhdp.com`,
    `- Google Knowledge Graph ID (kgmid): /g/11zyg5zq1c (https://www.google.com/search?kgmid=/g/11zyg5zq1c)`,
    `- Wikidata ID: Q141718572 (https://www.wikidata.org/wiki/Q141718572)`,
    `- ORCID iD: 0009-0005-7192-2664 (https://orcid.org/0009-0005-7192-2664)`,
    `- LinkedIn: https://www.linkedin.com/in/duong-phuc-khanh/`,
    `- X (Twitter): https://x.com/duongphuckhanh`,
    `- YouTube (Kode x Kido): https://www.youtube.com/@kodexkido`,
    `- GitHub: https://github.com/khanhduong22`,
    ``,
    `## Engineering Standard & Methodology`,
    `Every technical article follows the 3-tier Evolutionary Progression:`,
    `1. Naive Approach (Sơ khởi)`,
    `2. Scale Bottlenecks & Failure Modes (Tại sao vỡ trận khi scale)`,
    `3. Tier-1 Big-Tech Production Standard (Chuẩn Big Tech: Code, Benchmarks & Big-O proofs)`,
    ``,
    `## Articles Catalog & Deep-Dives`,
  ];

  sorted.forEach((post) => {
    const slug = post.id.replace(/\.md$/, '');
    lines.push(`### ${post.data.title}`);
    lines.push(`- URL: https://blog.khanhdp.com/blog/${slug}/`);
    lines.push(`- Category: ${post.data.category}`);
    lines.push(`- Reading Time: ${post.data.readingTime}`);
    lines.push(`- Description: ${post.data.description}`);
    lines.push(`- Tags: ${post.data.tags.join(', ')}`);
    if (post.data.relatedEpisodes && post.data.relatedEpisodes.length > 0) {
      const eps = post.data.relatedEpisodes.map(e => `Tập ${e.ep} (${e.title})`).join(', ');
      lines.push(`- Related Chronicles Episodes: ${eps}`);
    }
    lines.push(``);
  });

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
