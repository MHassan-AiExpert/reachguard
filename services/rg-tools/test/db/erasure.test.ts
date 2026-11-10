import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { authHeaders, testConfig } from '../helpers.js';
import { count, describeDb, insertDraft, insertLead, insertSend, testPool } from './pg.js';

describeDb('DELETE /v1/leads/:id (database backed)', () => {
  const db = testPool();
  afterAll(() => db.end());
  const server = buildServer({ config: testConfig(), db });
  const del = (id: string, headers: Record<string, string> | undefined = authHeaders) =>
    server.inject({ method: 'DELETE', url: `/v1/leads/${id}`, headers });

  async function richLead() {
    const lead = await insertLead(db, { email: `Erase.Me-${randomUUID()}@Example-Erase.test` });
    const draft = await insertDraft(db, lead.id, 1);
    const send = await insertSend(db, lead.id, draft, 1, { status: 'sent' });
    await db.query(
      "INSERT INTO research_evidence (lead_id, fact_type, claim, source_url, snippet, confidence) VALUES ($1,'other','c','https://x.example/','a long enough snippet text',0.9)",
      [lead.id],
    );
    await db.query(
      "INSERT INTO events (lead_id, send_id, type, payload) VALUES ($1,$2,'reply','{}'::jsonb)",
      [lead.id, send],
    );
    await db.query("INSERT INTO replies (lead_id, send_id, body) VALUES ($1,$2,'hello')", [lead.id, send]);
    await db.query('INSERT INTO approvals (lead_id) VALUES ($1)', [lead.id]);
    await db.query(
      "INSERT INTO verification_results (lead_id, check_name, outcome) VALUES ($1,'syntax','pass')",
      [lead.id],
    );
    await db.query(
      "INSERT INTO dead_letters (lead_id, stage, error, payload) VALUES ($1,'queued','boom', jsonb_build_object('email', $2::text))",
      [lead.id, lead.email],
    );
    const call = (
      await db.query<{ id: string }>(
        "INSERT INTO llm_calls (lead_id, agent, provider, model, prompt_version, status) VALUES ($1,'copywriter','google','m','1.0.0','ok') RETURNING id",
        [lead.id],
      )
    ).rows[0];
    return { lead, call: call?.id as string };
  }

  it('deletes the lead and every dependent row, and keeps only a hashed suppression', async () => {
    const { lead, call } = await richLead();
    const res = await del(lead.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, lead_id: lead.id });
    for (const table of [
      'drafts',
      'sends',
      'research_evidence',
      'events',
      'replies',
      'approvals',
      'verification_results',
      'lead_transitions',
      'dead_letters',
    ]) {
      expect(await count(db, `SELECT 1 FROM ${table} WHERE lead_id = $1`, [lead.id]), table).toBe(0);
    }
    expect(await count(db, 'SELECT 1 FROM leads WHERE id = $1', [lead.id])).toBe(0);
    // llm_calls keep cost accounting but lose the link to the person.
    expect(
      (await db.query<{ lead_id: string | null }>('SELECT lead_id FROM llm_calls WHERE id = $1', [call]))
        .rows[0]?.lead_id,
    ).toBeNull();
    expect(
      await count(
        db,
        "SELECT 1 FROM suppression WHERE kind = 'email_hash' AND reason = 'erasure' AND value = encode(digest(lower($1), 'sha256'), 'hex')",
        [lead.email],
      ),
    ).toBe(1);
    expect(
      (await db.query<{ s: boolean }>('SELECT is_suppressed($1::citext) AS s', [lead.email])).rows[0]?.s,
    ).toBe(true);
    expect(
      (await db.query<{ s: boolean }>('SELECT is_suppressed($1::citext) AS s', [lead.email.toUpperCase()]))
        .rows[0]?.s,
    ).toBe(true);
  });

  it('does not store the plaintext address anywhere in suppression', async () => {
    const { lead } = await richLead();
    await del(lead.id);
    expect(await count(db, 'SELECT 1 FROM suppression WHERE value = $1', [lead.email])).toBe(0);
  });

  it('replaces an earlier plaintext unsubscribe suppression with the hash', async () => {
    const lead = await insertLead(db);
    await db.query("INSERT INTO suppression (kind, value, reason) VALUES ('email', $1, 'unsubscribe')", [
      lead.email,
    ]);
    expect((await del(lead.id)).statusCode).toBe(200);
    expect(
      await count(db, "SELECT 1 FROM suppression WHERE kind = 'email' AND value = $1", [lead.email]),
    ).toBe(0);
    expect(
      (await db.query<{ s: boolean }>('SELECT is_suppressed($1::citext) AS s', [lead.email])).rows[0]?.s,
    ).toBe(true);
  });

  it('blocks the person from being imported again', async () => {
    const lead = await insertLead(db);
    await del(lead.id);
    expect(
      (await db.query<{ s: boolean }>('SELECT is_suppressed($1::citext) AS s', [lead.email])).rows[0]?.s,
    ).toBe(true);
  });

  it('is safe to repeat: 404 the second time, one suppression row', async () => {
    const lead = await insertLead(db);
    expect((await del(lead.id)).statusCode).toBe(200);
    expect((await del(lead.id)).statusCode).toBe(404);
    expect(
      await count(
        db,
        "SELECT 1 FROM suppression WHERE kind = 'email_hash' AND value = encode(digest(lower($1), 'sha256'), 'hex')",
        [lead.email],
      ),
    ).toBe(1);
  });

  it('answers 404 for an unknown lead, 400 for a bad id and 401 without the API key', async () => {
    expect((await del(randomUUID())).statusCode).toBe(404);
    expect((await del('nope')).statusCode).toBe(400);
    expect((await del(randomUUID(), {})).statusCode).toBe(401);
  });

  it('needs the database', async () => {
    const noDb = buildServer({ config: testConfig() });
    expect(
      (await noDb.inject({ method: 'DELETE', url: `/v1/leads/${randomUUID()}`, headers: authHeaders }))
        .statusCode,
    ).toBe(503);
  });
});
