import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { createPool, type Db } from '../../src/db.js';

export const DATABASE_URL = process.env.TEST_DATABASE_URL;
/** Database-backed suites run only under scripts/service-test.sh, which provides a throwaway Postgres. */
export const describeDb = DATABASE_URL ? describe : describe.skip;

export function testPool(): Db & { end(): Promise<void> } {
  // describe.skip still runs its callback, so build the pool without connecting: pg connects on first query only.
  return createPool(DATABASE_URL ?? 'postgres://unused@localhost/unused');
}

export async function campaignId(db: Db): Promise<string> {
  const r = await db.query<{ id: string }>('SELECT id FROM campaigns ORDER BY created_at LIMIT 1');
  return (r.rows[0] as { id: string }).id;
}

export async function insertLead(
  db: Db,
  o: { email?: string; status?: string; first_name?: string } = {},
): Promise<{ id: string; email: string }> {
  const email = o.email ?? `lead-${randomUUID()}@acme-test.example`;
  const r = await db.query<{ id: string }>(
    `INSERT INTO leads (campaign_id, idempotency_key, email, first_name, company_raw, status)
     VALUES ($1, $2, $3, $4, 'Acme Test', $5::lead_status) RETURNING id`,
    [await campaignId(db), randomUUID(), email, o.first_name ?? 'Jane', o.status ?? 'queued'],
  );
  return { id: (r.rows[0] as { id: string }).id, email };
}

export async function insertDraft(
  db: Db,
  leadId: string,
  step: number,
  o: { subject?: string | null; body?: string } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO drafts (lead_id, step, variant, subject, body, status)
     VALUES ($1, $2, 'direct', $3, $4, 'approved') RETURNING id`,
    [
      leadId,
      step,
      o.subject === undefined ? (step === 1 ? 'quick question' : null) : o.subject,
      o.body ?? `Hi Jane, body for step ${step}. Worth a chat?`,
    ],
  );
  return (r.rows[0] as { id: string }).id;
}

export async function insertSend(
  db: Db,
  leadId: string,
  draftId: string,
  step: number,
  o: { status?: string; inbox_id?: string | null; minutesFromNow?: number } = {},
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO sends (lead_id, draft_id, step, inbox_id, mode, scheduled_at, status)
     VALUES ($1, $2, $3, $4, 'sandbox', now() + ($5 || ' minutes')::interval, $6) RETURNING id`,
    [leadId, draftId, step, o.inbox_id ?? null, String(o.minutesFromNow ?? -1), o.status ?? 'scheduled'],
  );
  return (r.rows[0] as { id: string }).id;
}

/** Lead with a step 1 draft and a due scheduled send. */
export async function leadWithSend(
  db: Db,
  o: { status?: string; email?: string; inbox_id?: string | null } = {},
) {
  const lead = await insertLead(db, o);
  const draft = await insertDraft(db, lead.id, 1);
  const send = await insertSend(db, lead.id, draft, 1, { inbox_id: o.inbox_id ?? null });
  return { lead, draft, send };
}

export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM (${sql}) t`, params);
  return Number((r.rows[0] as { n: string }).n);
}
