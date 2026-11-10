import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { fetchResearchPages } from '../lib/fetcher.js';
import { groundFacts } from '../lib/grounding.js';
import type { ResolvedDeps } from '../server.js';
import { fetchSandboxPages } from './sandbox-sites.js';

const FetchBody = z
  .object({ website: z.string().min(1).optional(), domain: z.string().min(1).optional() })
  .refine((b) => b.website || b.domain, { message: 'website or domain is required' });

const GroundBody = z.object({
  facts: z.array(z.object({ source_url: z.string(), snippet: z.string() }).passthrough()),
  pages: z.array(z.object({ url: z.string(), text: z.string() })),
});

export function registerResearch(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/research/fetch', async (req, reply) => {
    const parsed = FetchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const site = (parsed.data.website ?? parsed.data.domain) as string;
    return deps.config.mode === 'sandbox'
      ? fetchSandboxPages(deps.config.sandboxSitesDir, site)
      : fetchResearchPages(site, deps.fetchDeps ?? {});
  });

  app.post('/v1/research/ground', async (req, reply) => {
    const parsed = GroundBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { kept, dropped } = groundFacts(parsed.data.facts, parsed.data.pages);
    return { kept, dropped, kept_count: kept.length, dropped_count: dropped.length };
  });
}
