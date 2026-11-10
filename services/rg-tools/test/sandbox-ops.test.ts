import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Db } from '../src/db.js';
import { signWebhook } from '../src/lib/webhook.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

function fakeDb(): Db & { queries: string[] } {
  const queries: string[] = [];
  const db: Db & { queries: string[] } = {
    queries,
    async query(text) {
      queries.push(text);
      return { rows: [], rowCount: 0 } as never;
    },
    tx: (fn) => fn(db),
  };
  return db;
}

describe('POST /v1/sandbox/reset', () => {
  it('refuses in live mode and touches nothing', async () => {
    const db = fakeDb();
    const app = buildServer({ config: testConfig({ mode: 'live' }), db });
    const res = await app.inject({ method: 'POST', url: '/v1/sandbox/reset', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(db.queries).toEqual([]);
  });

  it('clears lead data but keeps campaigns, sending domains and prompt versions', async () => {
    const db = fakeDb();
    const app = buildServer({ config: testConfig(), db });
    const res = await app.inject({ method: 'POST', url: '/v1/sandbox/reset', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    const sql = db.queries.join(';\n');
    expect(sql).toMatch(/TRUNCATE[^;]*\bleads\b/i);
    expect(sql).toMatch(/\bsuppression\b/);
    expect(sql).toMatch(/\bllm_calls\b/);
    expect(sql).not.toMatch(/TRUNCATE[^;]*\b(campaigns|sending_domains|sender_inboxes|prompt_versions|settings)\b/i);
    expect(sql).toMatch(/llm_paused/);
  });
});

describe('POST /v1/sandbox/seed', () => {
  function dataDir(leads: unknown): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rg-sbx-'));
    writeFileSync(path.join(dir, 'leads.json'), JSON.stringify(leads));
    return dir;
  }

  it('posts every seed lead to the intake webhook as one signed bulk request', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const webhookFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ results: [{ status: 'accepted' }, { status: 'accepted' }, { status: 'duplicate' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const leads = [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }];
    const cfg = testConfig({ sandboxDataDir: dataDir(leads), intakeWebhookUrl: 'http://n8n.test/webhook/rg/intake' });
    const app = buildServer({ config: cfg, webhookFetch });
    const res = await app.inject({ method: 'POST', url: '/v1/sandbox/seed', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ submitted: 3, accepted: 2, duplicate: 1, invalid: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('http://n8n.test/webhook/rg/intake');
    const headers = seen[0]!.init.headers as Record<string, string>;
    const body = seen[0]!.init.body as string;
    expect(JSON.parse(body)).toEqual(leads);
    expect(headers['X-RG-Signature']).toBe(signWebhook('whsec', body, headers['X-RG-Timestamp']!));
  });

  it('refuses in live mode and reports a missing seed file clearly', async () => {
    const live = buildServer({ config: testConfig({ mode: 'live' }) });
    expect((await live.inject({ method: 'POST', url: '/v1/sandbox/seed', headers: authHeaders, payload: {} })).statusCode).toBe(403);
    const missing = buildServer({ config: testConfig({ sandboxDataDir: path.join(os.tmpdir(), 'rg-no-such-dir') }) });
    const res = await missing.inject({ method: 'POST', url: '/v1/sandbox/seed', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'seed_file_missing' });
  });

  it('returns 502 when the intake webhook rejects the request', async () => {
    const webhookFetch = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    const app = buildServer({ config: testConfig({ sandboxDataDir: dataDir([{ email: 'a@x.com' }]) }), webhookFetch });
    const res = await app.inject({ method: 'POST', url: '/v1/sandbox/seed', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(502);
  });
});

describe('POST /v1/sandbox/replies/batch', () => {
  function setup(replies: unknown, leads: Record<string, string>) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rg-sbx-'));
    writeFileSync(path.join(dir, 'replies.json'), JSON.stringify(replies));
    const delivered: { provider_event_id: string; type: string; email: string; body?: string }[] = [];
    const db: Db = {
      async query(text, params) {
        if (/FROM leads WHERE email/.test(text)) {
          const id = leads[String(params?.[0])];
          return { rows: id ? [{ id }] : [], rowCount: id ? 1 : 0 } as never;
        }
        if (/FROM leads WHERE id/.test(text)) {
          const email = Object.entries(leads).find(([, id]) => id === params?.[0])?.[0];
          return { rows: [{ email }], rowCount: 1 } as never;
        }
        if (/FROM sends/.test(text)) return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }], rowCount: 1 } as never;
        return { rows: [], rowCount: 0 } as never;
      },
      tx: (fn) => fn(db),
    };
    const webhookFetch = (async (_u: string, init: RequestInit) => {
      delivered.push(JSON.parse(init.body as string).payload);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    return { app: buildServer({ config: testConfig({ sandboxDataDir: dir }), db, webhookFetch }), delivered };
  }

  const L1 = '11111111-1111-4111-8111-111111111111';
  it('delivers each labeled reply for a known lead with a stable event id and skips unknown emails', async () => {
    const { app, delivered } = setup(
      [
        { email: 'a@x.com', body: 'Sounds interesting, call me', label: 'interested' },
        { email: 'ghost@x.com', body: 'hi', label: 'other' },
        { email: 'a@x.com', type: 'bounce_hard', body: '' },
      ],
      { 'a@x.com': L1 },
    );
    const res = await app.inject({ method: 'POST', url: '/v1/sandbox/replies/batch', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ delivered: 2, skipped: 1, failed: 0 });
    expect(delivered.map((d) => d.provider_event_id)).toEqual(['sbx-batch-0', 'sbx-batch-2']);
    expect(delivered[0]).toMatchObject({ type: 'reply', body: 'Sounds interesting, call me', email: 'a@x.com' });
    expect(delivered[1]!.type).toBe('bounce_hard');
  });

  it('refuses in live mode and reports a missing replies file', async () => {
    const live = buildServer({ config: testConfig({ mode: 'live' }) });
    expect((await live.inject({ method: 'POST', url: '/v1/sandbox/replies/batch', headers: authHeaders, payload: {} })).statusCode).toBe(403);
    const none = buildServer({ config: testConfig({ sandboxDataDir: path.join(os.tmpdir(), 'rg-no-such-dir') }), db: fakeDb() });
    const res = await none.inject({ method: 'POST', url: '/v1/sandbox/replies/batch', headers: authHeaders, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'replies_file_missing' });
  });
});
