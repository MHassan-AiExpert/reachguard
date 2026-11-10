import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runLlm } from '../lib/gateway.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({
  agent: z.string().min(1),
  variables: z.record(z.string(), z.unknown()).default({}),
  lead_id: z.string().uuid().optional(),
  run_id: z.string().uuid().optional(),
  prompt_version: z.string().optional(),
});

export function registerLlm(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/llm/run', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!deps.llmStore) return reply.code(503).send({ error: 'db_unavailable' });
    const result = await runLlm(
      {
        config: deps.config,
        provider: deps.llmProvider,
        store: deps.llmStore,
        prompts: deps.prompts,
        contracts: deps.contracts,
        pricing: deps.pricing,
      },
      // Workflows cannot read the environment, so the gateway supplies the booking link unless one is passed.
      { ...parsed.data, variables: { booking_link: deps.config.bookingLink, ...parsed.data.variables } },
    );
    return reply.code(result.status).send(result.body);
  });
}
