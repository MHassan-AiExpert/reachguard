import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyUnsubscribeRules } from '../lib/classify-rules.js';
import type { ResolvedDeps } from '../server.js';

export const EVENT_TYPES = [
  'delivered',
  'bounce_hard',
  'bounce_soft',
  'complaint',
  'reply',
  'unsubscribe',
  'meeting_booked',
] as const;

const SandboxPayload = z
  .object({
    provider_event_id: z.string().min(1).max(200),
    type: z.enum(EVENT_TYPES),
    lead_id: z.string().uuid().optional(),
    send_id: z.string().uuid().optional(),
    email: z.string().max(320).optional(),
    occurred_at: z.string().datetime().optional(),
    body: z.string().optional(),
  })
  .refine((p) => p.lead_id || p.email, { message: 'lead_id or email is required' });

const Body = z.object({ provider: z.enum(['sandbox', 'smartlead']), payload: z.unknown() });

export function registerEvents(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/events/normalize', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (parsed.data.provider === 'smartlead') {
      return reply
        .code(501)
        .send({ error: 'not_configured', message: 'The Smartlead webhook adapter is not implemented yet' });
    }
    const p = SandboxPayload.safeParse(parsed.data.payload);
    if (!p.success)
      return reply.code(400).send({ error: 'invalid_event', issues: p.error.issues.map((i) => i.message) });
    const e = p.data;
    const body = e.type === 'reply' ? (e.body ?? '') : undefined;
    return {
      provider_event_id: e.provider_event_id,
      type: e.type,
      lead_id: e.lead_id ?? null,
      send_id: e.send_id ?? null,
      email: e.email ?? null,
      occurred_at: e.occurred_at ?? new Date().toISOString(),
      body,
      // A reply that asks to stop wins over whatever the model later says about it.
      unsubscribe_rule_hit: body !== undefined && applyUnsubscribeRules(body, deps.unsubscribeRules),
    };
  });
}
