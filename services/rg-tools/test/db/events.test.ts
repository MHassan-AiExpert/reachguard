import { randomUUID } from 'node:crypto';
import { afterAll, expect, it } from 'vitest';
import { verifyWebhook } from '../../src/lib/webhook.js';
import { buildServer } from '../../src/server.js';
import { authHeaders, testConfig } from '../helpers.js';
import { describeDb, insertDraft, insertLead, insertSend, leadWithSend, testPool } from './pg.js';

describeDb('POST /v1/sandbox/replies (database backed)', () => {
  const db = testPool();
  afterAll(() => db.end());

  function make(opts: { status?: number; mode?: 'sandbox' | 'live' } = {}) {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const webhookFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok', { status: opts.status ?? 200 });
    }) as unknown as typeof fetch;
    const config = testConfig({ mode: opts.mode ?? 'sandbox' });
    const server = buildServer({ config, db, webhookFetch });
    const post = (payload: object) =>
      server.inject({ method: 'POST', url: '/v1/sandbox/replies', headers: authHeaders, payload });
    return { calls, post, config };
  }

  it('posts a correctly signed event for the lead’s latest sent message', async () => {
    const { calls, post, config } = make();
    const { lead, send } = await leadWithSend(db);
    await db.query(
      "UPDATE sends SET status = 'sent', sent_at = now(), provider_message_id = '<m@d>' WHERE id = $1",
      [send],
    );
    const res = await post({ lead_id: lead.id, type: 'reply', body: 'Interested, send details' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(config.eventsWebhookUrl);
    const body = JSON.parse(calls[0]?.body as string);
    expect(body).toMatchObject({
      provider: 'sandbox',
      payload: { type: 'reply', lead_id: lead.id, send_id: send, body: 'Interested, send details' },
    });
    expect(body.payload.provider_event_id).toBeTruthy();
    const h = calls[0]?.headers as Record<string, string>;
    expect(
      verifyWebhook(
        config.webhookSecret,
        calls[0]?.body as string,
        h['X-RG-Signature'] as string,
        h['X-RG-Timestamp'] as string,
      ),
    ).toBe(true);
  });

  it('uses a caller supplied provider_event_id so a replay can be injected on purpose', async () => {
    const { calls, post } = make();
    const { lead } = await leadWithSend(db);
    await post({ lead_id: lead.id, type: 'bounce_hard', provider_event_id: 'fixed-1' });
    await post({ lead_id: lead.id, type: 'bounce_hard', provider_event_id: 'fixed-1' });
    expect(calls.map((c) => JSON.parse(c.body).payload.provider_event_id)).toEqual(['fixed-1', 'fixed-1']);
  });

  it('works for a lead without any sent message', async () => {
    const { post } = make();
    const lead = await insertLead(db);
    const res = await post({ lead_id: lead.id, type: 'unsubscribe' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses in live mode, for unknown leads and for bad input', async () => {
    const live = make({ mode: 'live' });
    expect((await live.post({ lead_id: randomUUID(), type: 'reply' })).statusCode).toBe(403);
    expect(live.calls).toHaveLength(0);
    const { post } = make();
    expect((await post({ lead_id: randomUUID(), type: 'reply' })).statusCode).toBe(404);
    expect((await post({ lead_id: 'x', type: 'reply' })).statusCode).toBe(400);
    expect((await post({ lead_id: randomUUID(), type: 'opened' })).statusCode).toBe(400);
  });

  it('reports delivered:false with 502 when the workflow endpoint rejects the event', async () => {
    const { post } = make({ status: 500 });
    const { lead } = await leadWithSend(db);
    const res = await post({ lead_id: lead.id, type: 'reply', body: 'x' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ delivered: false, status: 500 });
  });

  it('never needs the second draft to exist', async () => {
    const { post } = make();
    const lead = await insertLead(db);
    const s = await insertSend(db, lead.id, await insertDraft(db, lead.id, 1), 1, { status: 'sent' });
    await db.query('UPDATE sends SET sent_at = now() WHERE id = $1', [s]);
    expect((await post({ lead_id: lead.id, type: 'complaint' })).statusCode).toBe(200);
  });
});
