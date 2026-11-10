import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { verifyWebhook } from '../lib/webhook.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({ raw_body: z.string(), signature: z.string(), timestamp: z.string() });

export function registerAuth(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/auth/verify-webhook', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { raw_body, signature, timestamp } = parsed.data;
    return { valid: verifyWebhook(deps.config.webhookSecret, raw_body, signature, timestamp) };
  });
}
