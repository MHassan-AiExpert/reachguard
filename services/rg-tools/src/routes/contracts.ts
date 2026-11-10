import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({ schema: z.string().min(1), data: z.unknown() });

export function registerContracts(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/contracts/validate', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { schema, data } = parsed.data;
    if (!deps.contracts.has(schema)) return reply.code(400).send({ error: 'unknown_schema', schema });
    return deps.contracts.validate(schema, data);
  });
}
