import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { signUnsubscribeToken } from '../../src/lib/tokens.js';
import { testConfig } from '../helpers.js';
import { count, describeDb, insertDraft, insertLead, insertSend, leadWithSend, testPool } from './pg.js';

describeDb('unsubscribe endpoint (database backed)', () => {
  const db = testPool();
  afterAll(() => db.end());
  const cfg = testConfig();
  const server = buildServer({ config: cfg, db });
  const token = (leadId: string) => signUnsubscribeToken(leadId, cfg.unsubscribeSecret);
  const oneClick = (t: string) =>
    server.inject({
      method: 'POST',
      url: `/u/${t}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

  it('a valid token suppresses the email, cancels scheduled sends and suppresses the lead', async () => {
    const { lead, send } = await leadWithSend(db);
    const later = await insertSend(db, lead.id, await insertDraft(db, lead.id, 2), 2, {
      minutesFromNow: 4000,
    });
    const res = await oneClick(token(lead.id));
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('unsubscribed');
    expect(
      await count(
        db,
        "SELECT 1 FROM suppression WHERE kind = 'email' AND value = $1 AND reason = 'unsubscribe'",
        [lead.email],
      ),
    ).toBe(1);
    expect(
      (
        await db.query<{ status: string }>('SELECT status FROM sends WHERE id = ANY($1)', [[send, later]])
      ).rows.map((r) => r.status),
    ).toEqual(['cancelled', 'cancelled']);
    expect(
      (await db.query<{ status: string }>('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0]
        ?.status,
    ).toBe('suppressed');
    expect(
      await count(db, "SELECT 1 FROM events WHERE lead_id = $1 AND type = 'unsubscribe'", [lead.id]),
    ).toBe(1);
    expect(
      await count(db, "SELECT 1 FROM lead_transitions WHERE lead_id = $1 AND to_status = 'suppressed'", [
        lead.id,
      ]),
    ).toBe(1);
  });

  it.each([
    'received',
    'verified',
    'researched',
    'scored',
    'drafted',
    'qa_passed',
    'pending_approval',
    'approved',
    'queued',
    'in_sequence',
    'replied',
    'needs_review',
    'completed',
  ])('wins from any state: %s', async (status) => {
    const lead = await insertLead(db, { status });
    expect((await oneClick(token(lead.id))).statusCode).toBe(200);
    expect(
      (await db.query<{ status: string }>('SELECT status FROM leads WHERE id = $1', [lead.id])).rows[0]
        ?.status,
    ).toBe('suppressed');
  });

  it('still suppresses the email when the lead has already been rejected or failed', async () => {
    const lead = await insertLead(db, { status: 'rejected' });
    expect((await oneClick(token(lead.id))).statusCode).toBe(200);
    expect(
      await count(db, "SELECT 1 FROM suppression WHERE kind = 'email' AND value = $1", [lead.email]),
    ).toBe(1);
  });

  it('is idempotent: a second request changes nothing and adds no second event', async () => {
    const { lead } = await leadWithSend(db);
    expect((await oneClick(token(lead.id))).statusCode).toBe(200);
    expect((await oneClick(token(lead.id))).statusCode).toBe(200);
    expect(await count(db, 'SELECT 1 FROM suppression WHERE value = $1', [lead.email])).toBe(1);
    expect(
      await count(db, "SELECT 1 FROM events WHERE lead_id = $1 AND type = 'unsubscribe'", [lead.id]),
    ).toBe(1);
  });

  it('rejects a tampered token without writing anything', async () => {
    const { lead, send } = await leadWithSend(db);
    const good = token(lead.id);
    const bad = `${good.slice(0, -1)}${good.endsWith('A') ? 'B' : 'A'}`;
    const res = await oneClick(bad);
    expect(res.statusCode).toBe(400);
    expect(await count(db, 'SELECT 1 FROM suppression WHERE value = $1', [lead.email])).toBe(0);
    expect(
      (await db.query<{ status: string }>('SELECT status FROM sends WHERE id = $1', [send])).rows[0]?.status,
    ).toBe('scheduled');
    expect((await oneClick('garbage')).statusCode).toBe(400);
  });

  it('GET shows a confirmation page and does not unsubscribe (link scanners prefetch GETs)', async () => {
    const lead = await insertLead(db);
    const res = await server.inject({ method: 'GET', url: `/u/${token(lead.id)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<form method="post"');
    expect(await count(db, 'SELECT 1 FROM suppression WHERE value = $1', [lead.email])).toBe(0);
    const post = await server.inject({ method: 'POST', url: `/u/${token(lead.id)}` });
    expect(post.statusCode).toBe(200);
    expect(await count(db, 'SELECT 1 FROM suppression WHERE value = $1', [lead.email])).toBe(1);
  });

  it('GET with a bad token is a 400 page', async () => {
    expect((await server.inject({ method: 'GET', url: '/u/nope' })).statusCode).toBe(400);
  });

  it('answers 200 for a valid token whose lead no longer exists (erased)', async () => {
    expect((await oneClick(token(randomUUID()))).statusCode).toBe(200);
  });

  it('needs no API key', async () => {
    const lead = await insertLead(db);
    const res = await server.inject({ method: 'POST', url: `/u/${token(lead.id)}` });
    expect(res.statusCode).toBe(200);
  });
});
