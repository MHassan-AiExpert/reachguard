import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeTier } from '../lib/tier.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({
  dimensions: z.array(z.object({ name: z.string(), score: z.number().min(0).max(100) })),
  flags: z.array(z.string()).default([]),
});

export function registerScore(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/score/tier', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const rules = deps.scoring;
    try {
      return computeTier(parsed.data.dimensions, rules.weights, rules, parsed.data.flags, rules.cap_flags);
    } catch (err) {
      return reply.code(422).send({ error: 'invalid_dimensions', message: (err as Error).message });
    }
  });
}
