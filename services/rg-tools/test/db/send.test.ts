import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { authHeaders, testConfig } from '../helpers.js';
import { fakeSender } from '../helpers-send.js';
import { count, describeDb, insertDraft, insertLead, insertSend, leadWithSend, testPool } from './pg.js';

describeDb('POST /v1/send (database backed)', () => {
  const db = testPool();
  afterAll(() => db.end());

  const make = (cfg: Parameters<typeof testConfig>[0] = {}) => {
    const sender = fakeSender();
    const server = buildServer({ config: testConfig({ databaseUrl: 'x', ...cfg }), db, sender });
    const post = (send_id: string) =>
      server.inject({ method: 'POST', url: '/v1/send', headers: authHeaders, payload: { send_id } });
    return { sender, post };
  };
  const row = async (id: string) =>
    (
      await db.query<{
        status: string;
        inbox_id: string | null;
        provider_message_id: string | null;
        sent_at: string | null;
        failure: string | null;
        mode: string;
      }>('SELECT * FROM sends WHERE id = $1', [id])
    ).rows[0];

  it('delivers once and marks send and draft sent', async () => {
    const { sender, post } = make();
    const { send, draft } = await leadWithSend(db);
    const res = await post(send);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'sent', already_sent: false });
    expect(sender.sent).toHaveLength(1);
    const r = await row(send);
    expect(r).toMatchObject({ status: 'sent', mode: 'sandbox' });
    expect(r?.inbox_id).toBeTruthy();
    expect(r?.sent_at).toBeTruthy();
    expect(r?.provider_message_id).toBe(sender.sent[0]?.headers['Message-ID']);
    expect(
      (await db.query<{ status: string }>('SELECT status FROM drafts WHERE id = $1', [draft])).rows[0]
        ?.status,
    ).toBe('sent');
  });

  it('sending the same send_id twice delivers once', async () => {
    const { sender, post } = make();
    const { send } = await leadWithSend(db);
    const a = await post(send);
    const b = await post(send);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({
      status: 'sent',
      already_sent: true,
      provider_message_id: a.json().provider_message_id,
    });
    expect(sender.sent).toHaveLength(1);
  });

  it('delivers once even when two requests race', async () => {
    const { sender, post } = make();
    sender.delayMs = 150;
    const { send } = await leadWithSend(db);
    const [a, b] = await Promise.all([post(send), post(send)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(sender.sent).toHaveLength(1);
    expect([a.json().already_sent, b.json().already_sent].sort()).toEqual([false, true]);
  });

  it('includes both unsubscribe headers and the physical address', async () => {
    const { sender, post } = make();
    const { send } = await leadWithSend(db);
    await post(send);
    const m = sender.sent[0];
    expect(m?.headers['List-Unsubscribe']).toContain('/u/');
    expect(m?.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(m?.text).toContain('Test Co, 1 Test St, Lahore, Pakistan');
  });

  it('threads step 2 on the step 1 message', async () => {
    const { sender, post } = make();
    const lead = await insertLead(db);
    const s1 = await insertSend(
      db,
      lead.id,
      await insertDraft(db, lead.id, 1, { subject: 'first subject' }),
      1,
    );
    const s2 = await insertSend(db, lead.id, await insertDraft(db, lead.id, 2), 2);
    await post(s1);
    await post(s2);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[1]?.headers['In-Reply-To']).toBe(sender.sent[0]?.headers['Message-ID']);
    expect(sender.sent[1]?.headers.References).toBe(sender.sent[0]?.headers['Message-ID']);
    expect(sender.sent[1]?.headers.Subject).toBe('first subject');
  });

  it('refuses a suppressed address, cancels the lead’s scheduled sends and sends nothing', async () => {
    const { sender, post } = make();
    const { lead, send } = await leadWithSend(db);
    const later = await insertSend(db, lead.id, await insertDraft(db, lead.id, 2), 2, {
      minutesFromNow: 5000,
    });
    await db.query("INSERT INTO suppression (kind, value, reason) VALUES ('email', $1, 'unsubscribe')", [
      lead.email,
    ]);
    const res = await post(send);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('suppressed');
    expect(sender.sent).toHaveLength(0);
    expect((await row(send))?.status).toBe('cancelled');
    expect((await row(later))?.status).toBe('cancelled');
  });

  it('refuses when the domain is suppressed or the email hash is suppressed', async () => {
    const { sender, post } = make();
    const a = await leadWithSend(db, { email: `x-${randomUUID()}@blocked-${randomUUID()}.example` });
    await db.query("INSERT INTO suppression (kind, value, reason) VALUES ('domain', $1, 'manual')", [
      a.lead.email.split('@')[1],
    ]);
    expect((await post(a.send)).statusCode).toBe(409);
    const b = await leadWithSend(db);
    await db.query(
      "INSERT INTO suppression (kind, value, reason) VALUES ('email_hash', encode(digest(lower($1), 'sha256'), 'hex'), 'erasure')",
      [b.lead.email],
    );
    expect((await post(b.send)).statusCode).toBe(409);
    expect(sender.sent).toHaveLength(0);
  });

  it.each(['replied', 'suppressed', 'completed', 'needs_review'])(
    'refuses a lead in status %s',
    async (status) => {
      const { sender, post } = make();
      const { send } = await leadWithSend(db, { status });
      const res = await post(send);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('lead_not_sendable');
      expect(sender.sent).toHaveLength(0);
      expect((await row(send))?.status).toBe('cancelled');
    },
  );

  it('allows in_sequence leads (follow-ups)', async () => {
    const { sender, post } = make();
    const { send } = await leadWithSend(db, { status: 'in_sequence' });
    expect((await post(send)).statusCode).toBe(200);
    expect(sender.sent).toHaveLength(1);
  });

  it('returns 423 and leaves the send scheduled while the kill switch is on', async () => {
    const { sender, post } = make();
    const { send } = await leadWithSend(db);
    await db.query("UPDATE settings SET value = 'true'::jsonb WHERE key = 'kill_switch'");
    try {
      const res = await post(send);
      expect(res.statusCode).toBe(423);
      expect(res.json().error).toBe('kill_switch');
      expect(sender.sent).toHaveLength(0);
      expect((await row(send))?.status).toBe('scheduled');
    } finally {
      await db.query("UPDATE settings SET value = 'false'::jsonb WHERE key = 'kill_switch'");
    }
  });

  it('refuses a paused sending domain without sending', async () => {
    const { sender, post } = make();
    const domain = `paused-${randomUUID().slice(0, 8)}.example`;
    await db.query("INSERT INTO sending_domains (domain, status) VALUES ($1, 'paused')", [domain]);
    const inbox = (
      await db.query<{ id: string }>(
        "INSERT INTO sender_inboxes (email, domain, status) VALUES ($1, $2, 'active') RETURNING id",
        [`a@${domain}`, domain],
      )
    ).rows[0];
    const { send } = await leadWithSend(db, { inbox_id: inbox?.id });
    const res = await post(send);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('inbox_unavailable');
    expect(sender.sent).toHaveLength(0);
    expect((await row(send))?.status).toBe('scheduled');
  });

  it('enforces the inbox daily limit', async () => {
    const { sender, post } = make();
    const domain = `cap-${randomUUID().slice(0, 8)}.example`;
    await db.query("INSERT INTO sending_domains (domain, status) VALUES ($1, 'active')", [domain]);
    const inbox = (
      await db.query<{ id: string }>(
        "INSERT INTO sender_inboxes (email, domain, status, daily_limit) VALUES ($1, $2, 'active', 1) RETURNING id",
        [`a@${domain}`, domain],
      )
    ).rows[0];
    const one = await leadWithSend(db, { inbox_id: inbox?.id });
    const two = await leadWithSend(db, { inbox_id: inbox?.id });
    expect((await post(one.send)).statusCode).toBe(200);
    const res = await post(two.send);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('inbox_capped');
    expect(sender.sent).toHaveLength(1);
    expect((await row(two.send))?.status).toBe('scheduled');
  });

  it('refuses live sends unless LIVE_SEND_ENABLED is true', async () => {
    const { sender, post } = make({ mode: 'live', liveSendEnabled: false });
    const { send } = await leadWithSend(db);
    const res = await post(send);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('live_send_disabled');
    expect(sender.sent).toHaveLength(0);
  });

  it('keeps the send scheduled on provider failure and delivers once on retry', async () => {
    const { sender, post } = make();
    sender.failNext = 1;
    const { send } = await leadWithSend(db);
    const failed = await post(send);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('provider_error');
    const mid = await row(send);
    expect(mid?.status).toBe('scheduled');
    expect(mid?.failure).toContain('smtp unavailable');
    expect((await post(send)).statusCode).toBe(200);
    expect(sender.sent).toHaveLength(1);
    expect((await row(send))?.failure).toBeNull();
  });

  it('answers 404 for an unknown send, 409 for a cancelled one and 400 for a bad id', async () => {
    const { post } = make();
    expect((await post(randomUUID())).statusCode).toBe(404);
    expect((await post('nope')).statusCode).toBe(400);
    const { send } = await leadWithSend(db);
    await db.query("UPDATE sends SET status = 'cancelled' WHERE id = $1", [send]);
    const res = await post(send);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('send_not_pending');
  });

  it('needs the database', async () => {
    const server = buildServer({ config: testConfig(), sender: fakeSender() });
    const res = await server.inject({
      method: 'POST',
      url: '/v1/send',
      headers: authHeaders,
      payload: { send_id: randomUUID() },
    });
    expect(res.statusCode).toBe(503);
  });

  it('counts exactly one sent row per send even after many retries', async () => {
    const { post } = make();
    const { send } = await leadWithSend(db);
    await Promise.all([post(send), post(send), post(send)]);
    expect(await count(db, "SELECT 1 FROM sends WHERE id = $1 AND status = 'sent'", [send])).toBe(1);
  });
});
