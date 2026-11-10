import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { buildMessage } from '../lib/message.js';
import type { ResolvedDeps } from '../server.js';

const Body = z.object({ send_id: z.string().uuid() });

interface SendRow {
  id: string;
  status: string;
  step: number;
  lead_id: string;
  inbox_id: string | null;
  mode: string;
  provider_message_id: string | null;
  sent_at: string | null;
  draft_id: string;
  subject: string | null;
  body: string;
  email: string;
  first_name: string | null;
  lead_status: string;
}

interface InboxRow {
  id: string;
  email: string;
  provider: string;
  daily_limit: number;
  inbox_status: string;
  domain_status: string;
  sent_today: string;
}

type Outcome = { status: number; body: Record<string, unknown> };

const INBOX_SQL = `
  SELECT i.id, i.email::text AS email, i.provider, i.daily_limit, i.status AS inbox_status, sd.status AS domain_status,
         (SELECT count(*) FROM sends x
           WHERE x.inbox_id = i.id AND x.status = 'sent' AND x.sent_at >= date_trunc('day', now()))::text AS sent_today
    FROM sender_inboxes i JOIN sending_domains sd ON sd.domain = i.domain`;

async function pickInbox(
  db: Db,
  presetId: string | null,
  provider: string,
): Promise<{ inbox?: InboxRow; error?: Outcome }> {
  if (presetId) {
    const r = await db.query<InboxRow>(`${INBOX_SQL} WHERE i.id = $1`, [presetId]);
    const inbox = r.rows[0];
    if (!inbox || inbox.inbox_status !== 'active' || inbox.domain_status !== 'active') {
      return { error: { status: 409, body: { error: 'inbox_unavailable' } } };
    }
    if (Number(inbox.sent_today) >= inbox.daily_limit)
      return { error: { status: 429, body: { error: 'inbox_capped' } } };
    return { inbox };
  }
  const r = await db.query<InboxRow>(
    `${INBOX_SQL}
      WHERE i.status = 'active' AND sd.status = 'active' AND i.provider = $1
        AND (SELECT count(*) FROM sends x WHERE x.inbox_id = i.id AND x.status = 'sent' AND x.sent_at >= date_trunc('day', now())) < i.daily_limit
      ORDER BY (SELECT count(*) FROM sends x WHERE x.inbox_id = i.id AND x.status = 'sent' AND x.sent_at >= date_trunc('day', now())), random()
      LIMIT 1`,
    [provider],
  );
  const inbox = r.rows[0];
  return inbox ? { inbox } : { error: { status: 429, body: { error: 'no_inbox_capacity' } } };
}

const cancelScheduled = (db: Db, leadId: string, why: string) =>
  db.query(
    "UPDATE sends SET status = 'cancelled', failure = $2 WHERE lead_id = $1 AND status = 'scheduled'",
    [leadId, why],
  );

export function registerSend(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/send', async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const db = deps.db;
    if (!db) return reply.code(503).send({ error: 'db_unavailable' });
    const { config, sender } = deps;

    // One transaction holds the row lock across the provider call, so a concurrent or repeated request for the
    // same send waits, then sees it as already sent. That is what makes the endpoint idempotent on send_id.
    const out = await db.tx<Outcome>(async (tx) => {
      const found = await tx.query<SendRow>(
        `SELECT s.id, s.status, s.step, s.lead_id, s.inbox_id, s.mode, s.provider_message_id, s.sent_at,
                d.id AS draft_id, d.subject, d.body, l.email::text AS email, l.first_name, l.status::text AS lead_status
           FROM sends s JOIN drafts d ON d.id = s.draft_id JOIN leads l ON l.id = s.lead_id
          WHERE s.id = $1 FOR UPDATE OF s`,
        [parsed.data.send_id],
      );
      const s = found.rows[0];
      if (!s) return { status: 404, body: { error: 'send_not_found' } };
      if (s.status === 'sent') {
        return {
          status: 200,
          body: {
            status: 'sent',
            already_sent: true,
            send_id: s.id,
            provider_message_id: s.provider_message_id,
            inbox_id: s.inbox_id,
            sent_at: s.sent_at,
          },
        };
      }
      if (s.status !== 'scheduled')
        return { status: 409, body: { error: 'send_not_pending', status: s.status } };

      if (config.mode === 'live' && !config.liveSendEnabled)
        return { status: 403, body: { error: 'live_send_disabled' } };
      if (s.mode !== config.mode) return { status: 409, body: { error: 'mode_mismatch' } };

      const kill = await tx.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'kill_switch'");
      if (kill.rows[0]?.value === true) return { status: 423, body: { error: 'kill_switch' } };

      const sup = await tx.query<{ s: boolean }>('SELECT is_suppressed($1::citext) AS s', [s.email]);
      if (sup.rows[0]?.s) {
        await cancelScheduled(tx, s.lead_id, 'suppressed');
        return { status: 409, body: { error: 'suppressed' } };
      }
      if (s.lead_status !== 'queued' && s.lead_status !== 'in_sequence') {
        await cancelScheduled(tx, s.lead_id, `lead_${s.lead_status}`);
        return { status: 409, body: { error: 'lead_not_sendable', lead_status: s.lead_status } };
      }

      const picked = await pickInbox(tx, s.inbox_id, config.mode === 'live' ? 'smartlead' : 'mailpit');
      if (picked.error || !picked.inbox) return picked.error as Outcome;
      const inbox = picked.inbox;

      let thread: { subject: string; message_ids: string[] } | undefined;
      if (s.step > 1) {
        const prev = await tx.query<{ provider_message_id: string; subject: string | null }>(
          `SELECT s2.provider_message_id, d2.subject
             FROM sends s2 JOIN drafts d2 ON d2.id = s2.draft_id
            WHERE s2.lead_id = $1 AND s2.step < $2 AND s2.status = 'sent' AND s2.provider_message_id IS NOT NULL
            ORDER BY s2.step`,
          [s.lead_id, s.step],
        );
        const first = prev.rows[0];
        if (!first) return { status: 409, body: { error: 'previous_step_not_sent' } };
        thread = { subject: first.subject ?? '', message_ids: prev.rows.map((r) => r.provider_message_id) };
      }

      let message;
      try {
        message = buildMessage(
          { send_id: s.id, step: s.step, subject: s.subject, body: s.body, thread },
          { id: s.lead_id, email: s.email, first_name: s.first_name },
          { email: inbox.email, display_name: null },
          config,
        );
      } catch (err) {
        return { status: 422, body: { error: 'cannot_build_message', message: (err as Error).message } };
      }

      try {
        const sent = await sender.send(message);
        await tx.query(
          `UPDATE sends SET status = 'sent', sent_at = now(), inbox_id = $2, provider_message_id = $3,
                            provider_ref = $4, mode = $5, failure = NULL WHERE id = $1`,
          [s.id, inbox.id, sent.provider_message_id, sent.provider_ref ?? null, config.mode],
        );
        await tx.query("UPDATE drafts SET status = 'sent' WHERE id = $1", [s.draft_id]);
        return {
          status: 200,
          body: {
            status: 'sent',
            already_sent: false,
            send_id: s.id,
            provider_message_id: sent.provider_message_id,
            inbox_id: inbox.id,
            sent_at: new Date().toISOString(),
          },
        };
      } catch (err) {
        const message_ = (err as Error).message;
        await tx.query('UPDATE sends SET failure = $2 WHERE id = $1', [s.id, message_.slice(0, 500)]);
        return { status: 502, body: { error: 'provider_error', message: message_ } };
      }
    });
    return reply.code(out.status).send(out.body);
  });
}
