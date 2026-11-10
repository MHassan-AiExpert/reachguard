import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signWebhook } from '../lib/webhook.js';
import type { ResolvedDeps } from '../server.js';
import { EVENT_TYPES } from './events.js';

const Body = z.object({
  lead_id: z.string().uuid(),
  type: z.enum(EVENT_TYPES),
  body: z.string().optional(),
  provider_event_id: z.string().min(1).max(200).optional(),
});

/** Injects a reply, bounce or other event as if the provider had called the events webhook. Sandbox only. */
export function registerSandbox(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/sandbox/replies', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (deps.config.mode !== 'sandbox') return reply.code(403).send({ error: 'sandbox_only' });
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    const { lead_id, type, body } = parsed.data;

    const lead = (
      await deps.db.query<{ email: string }>('SELECT email::text AS email FROM leads WHERE id = $1', [
        lead_id,
      ])
    ).rows[0];
    if (!lead) return reply.code(404).send({ error: 'lead_not_found' });
    const send = (
      await deps.db.query<{ id: string }>(
        "SELECT id FROM sends WHERE lead_id = $1 AND status = 'sent' ORDER BY sent_at DESC NULLS LAST, step DESC LIMIT 1",
        [lead_id],
      )
    ).rows[0];

    const providerEventId = parsed.data.provider_event_id ?? `sbx-${randomUUID()}`;
    const raw = JSON.stringify({
      provider: 'sandbox',
      payload: {
        provider_event_id: providerEventId,
        type,
        lead_id,
        send_id: send?.id,
        email: lead.email,
        body,
        occurred_at: new Date().toISOString(),
      },
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const res = await deps.webhookFetch(deps.config.eventsWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-RG-Timestamp': timestamp,
          'X-RG-Signature': signWebhook(deps.config.webhookSecret, raw, timestamp),
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok)
        return reply
          .code(502)
          .send({ delivered: false, status: res.status, provider_event_id: providerEventId });
      return { delivered: true, provider_event_id: providerEventId };
    } catch (err) {
      return reply
        .code(502)
        .send({ delivered: false, error: (err as Error).message, provider_event_id: providerEventId });
    }
  });
}
