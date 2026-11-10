import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { extractText } from '../lib/fetcher.js';
import type { ResearchPages } from '../lib/fetcher.js';
import type { ResolvedDeps } from '../server.js';

const SAFE = /^[a-z0-9-]+$/;

export async function readSandboxPage(dir: string, slug: string, page = 'index'): Promise<string | null> {
  if (!SAFE.test(slug) || !SAFE.test(page)) return null;
  const candidates = [path.join(dir, slug, `${page}.html`)];
  if (page === 'index') candidates.push(path.join(dir, `${slug}.html`));
  for (const file of candidates) {
    try {
      return await readFile(file, 'utf8');
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Sandbox research: fixtures stand in for the website, so no network is touched. */
export async function fetchSandboxPages(dir: string, website: string): Promise<ResearchPages> {
  const out: ResearchPages = { pages: [], skipped: [] };
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`).hostname;
  } catch {
    out.skipped.push({ url: website, reason: 'invalid_url' });
    return out;
  }
  const slug = host.replace(/^www\./, '').split('.')[0] ?? '';
  const wanted: [string, string][] = [
    ['index', '/'],
    ['about', '/about'],
    ['news', '/news'],
    ['blog', '/blog'],
  ];
  let newsTaken = false;
  for (const [page, route] of wanted) {
    if ((page === 'news' || page === 'blog') && newsTaken) continue;
    const html = await readSandboxPage(dir, slug, page);
    const url = `https://${host}${route}`;
    if (html === null) {
      out.skipped.push({ url, reason: 'no_fixture' });
      continue;
    }
    if (page === 'news' || page === 'blog') newsTaken = true;
    out.pages.push({ url, text: extractText(html, url) });
  }
  return out;
}

export function registerSandboxSites(app: FastifyInstance, deps: ResolvedDeps): void {
  const serve = async (
    req: { params: { slug: string; page?: string } },
    reply: { code(n: number): { send(b: unknown): unknown }; type(t: string): { send(b: unknown): unknown } },
  ): Promise<unknown> => {
    if (deps.config.mode !== 'sandbox') return reply.code(404).send({ error: 'not_found' });
    const html = await readSandboxPage(deps.config.sandboxSitesDir, req.params.slug, req.params.page);
    if (html === null) return reply.code(404).send({ error: 'not_found' });
    return reply.type('text/html; charset=utf-8').send(html);
  };
  app.get<{ Params: { slug: string } }>('/sandbox/sites/:slug', serve);
  app.get<{ Params: { slug: string; page: string } }>('/sandbox/sites/:slug/:page', serve);
}
