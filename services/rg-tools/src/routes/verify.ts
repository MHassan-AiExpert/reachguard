import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotConfigured } from '../adapters/verify/index.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({
  email: z.string().min(3),
  tier: z.enum(['primary', 'escalation']),
  tags: z.array(z.string()).optional(),
});

export function registerVerify(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/verify', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await deps.verifier.verify(parsed.data.email, parsed.data.tier, { tags: parsed.data.tags });
    } catch (err) {
      if (err instanceof NotConfigured)
        return reply.code(501).send({ error: 'not_configured', message: err.message });
      throw err;
    }
  });
}
