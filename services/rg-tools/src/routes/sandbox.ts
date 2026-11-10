import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

type DeliverOutcome =
  | { status: 'delivered'; provider_event_id: string }
  | { status: 'lead_not_found'; provider_event_id: string }
  | { status: 'failed'; provider_event_id: string; detail: Record<string, unknown> };

/** Posts one event to the events webhook exactly as the provider would, signed with the shared secret. */
async function deliverEvent(
  deps: ResolvedDeps,
  leadId: string,
  type: string,
  body: string | undefined,
  providerEventId: string,
): Promise<DeliverOutcome> {
  const db = deps.db!;
  const lead = (await db.query<{ email: string }>('SELECT email::text AS email FROM leads WHERE id = $1', [leadId])).rows[0];
  if (!lead) return { status: 'lead_not_found', provider_event_id: providerEventId };
  const send = (
    await db.query<{ id: string }>(
      "SELECT id FROM sends WHERE lead_id = $1 AND status = 'sent' ORDER BY sent_at DESC NULLS LAST, step DESC LIMIT 1",
      [leadId],
    )
  ).rows[0];
  const raw = JSON.stringify({
    provider: 'sandbox',
    payload: {
      provider_event_id: providerEventId,
      type,
      lead_id: leadId,
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
    if (!res.ok) return { status: 'failed', provider_event_id: providerEventId, detail: { status: res.status } };
    return { status: 'delivered', provider_event_id: providerEventId };
  } catch (err) {
    return { status: 'failed', provider_event_id: providerEventId, detail: { error: (err as Error).message } };
  }
}

/** Injects a reply, bounce or other event as if the provider had called the events webhook. Sandbox only. */
export function registerSandbox(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/sandbox/replies', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (deps.config.mode !== 'sandbox') return reply.code(403).send({ error: 'sandbox_only' });
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    const { lead_id, type, body } = parsed.data;
    const out = await deliverEvent(deps, lead_id, type, body, parsed.data.provider_event_id ?? `sbx-${randomUUID()}`);
    if (out.status === 'lead_not_found') return reply.code(404).send({ error: 'lead_not_found' });
    if (out.status === 'failed') return reply.code(502).send({ delivered: false, ...out.detail, provider_event_id: out.provider_event_id });
    return { delivered: true, provider_event_id: out.provider_event_id };
  });

  /** Injects every labeled event in sandbox/replies.json (matched to leads by email) through the events webhook. */
  app.post('/v1/sandbox/replies/batch', async (_req, reply) => {
    if (deps.config.mode !== 'sandbox') return reply.code(403).send({ error: 'sandbox_only' });
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    let items: { email: string; type?: (typeof EVENT_TYPES)[number]; body?: string }[];
    try {
      items = JSON.parse(readFileSync(path.join(deps.config.sandboxDataDir, 'replies.labeled.json'), 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'replies_file_missing' });
    }
    let delivered = 0;
    let skipped = 0;
    let failed = 0;
    for (const [i, item] of items.entries()) {
      const lead = (
        await deps.db.query<{ id: string }>('SELECT id FROM leads WHERE email = $1::citext', [String(item.email).toLowerCase()])
      ).rows[0];
      if (!lead) {
        skipped++;
        continue;
      }
      // The id depends on the position in the file, so running the batch twice cannot double-deliver.
      const out = await deliverEvent(deps, lead.id, item.type ?? 'reply', item.body, `sbx-batch-${i}`);
      if (out.status === 'delivered') delivered++;
      else failed++;
    }
    return { delivered, skipped, failed };
  });

  /** Clears lead data for a fresh demo run. Campaigns, sending domains, inboxes and prompt versions stay. */
  app.post('/v1/sandbox/reset', async (_req, reply) => {
    if (deps.config.mode !== 'sandbox') return reply.code(403).send({ error: 'sandbox_only' });
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    await deps.db.tx(async (db) => {
      await db.query('TRUNCATE leads, companies, suppression, runs, llm_calls, dead_letters RESTART IDENTITY CASCADE');
      await db.query(
        "UPDATE settings SET value = 'false'::jsonb WHERE key IN ('llm_paused', 'kill_switch')",
      );
    });
    return { reset: true };
  });

  /**
   * Seeds a demo run: re-applies the suppression seed (reset clears it), then submits the seed leads to WF-01 as one
   * properly signed bulk request. The eval-only `expected` field is removed, the pipeline must never see it.
   */
  app.post('/v1/sandbox/seed', async (_req, reply) => {
    if (deps.config.mode !== 'sandbox') return reply.code(403).send({ error: 'sandbox_only' });
    let leads: Record<string, unknown>[];
    try {
      leads = JSON.parse(readFileSync(path.join(deps.config.sandboxDataDir, 'leads.seed.json'), 'utf8'));
    } catch {
      return reply.code(404).send({ error: 'seed_file_missing' });
    }
    let suppression: { kind: string; value: string; reason: string }[] = [];
    try {
      suppression = JSON.parse(readFileSync(path.join(deps.config.sandboxDataDir, 'suppression.seed.json'), 'utf8'));
    } catch {
      /* the suppression seed is optional */
    }
    if (suppression.length > 0) {
      if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
      for (const s of suppression) {
        await deps.db.query(
          "INSERT INTO suppression (kind, value, reason, source) VALUES ($1, $2::citext, $3, 'sandbox-seed') ON CONFLICT (kind, value) DO NOTHING",
          [s.kind, s.value, s.reason],
        );
      }
    }
    const raw = JSON.stringify(leads.map(({ expected: _expected, ...intake }) => intake));
    const timestamp = Math.floor(Date.now() / 1000).toString();
    try {
      const res = await deps.webhookFetch(deps.config.intakeWebhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-RG-Timestamp': timestamp,
          'X-RG-Signature': signWebhook(deps.config.webhookSecret, raw, timestamp),
        },
        body: raw,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) return reply.code(502).send({ error: 'intake_rejected', status: res.status });
      const body = (await res.json().catch(() => ({}))) as { results?: { status?: string }[] };
      const count = (st: string): number => (body.results ?? []).filter((r) => r.status === st).length;
      const invalid = (body.results ?? []).filter((r) => r.status !== 'accepted' && r.status !== 'duplicate').length;
      return { submitted: leads.length, accepted: count('accepted'), duplicate: count('duplicate'), invalid, suppression_seeded: suppression.length };
    } catch (err) {
      return reply.code(502).send({ error: 'intake_unreachable', message: (err as Error).message });
    }
  });
}
