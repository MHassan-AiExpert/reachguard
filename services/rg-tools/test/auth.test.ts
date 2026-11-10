import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhook } from '../src/lib/webhook.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const secret = 'whsec';
const now = new Date('2026-11-10T08:00:00Z');
const nowSec = Math.floor(now.getTime() / 1000);
const sign = (ts: number | string, body: string) =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

describe('verifyWebhook', () => {
  const body = '{"email":"a@b.com"}';

  it('accepts a correct signature with a fresh timestamp', () => {
    expect(verifyWebhook(secret, body, sign(nowSec, body), String(nowSec), now)).toBe(true);
  });

  it('accepts a sha256= prefixed signature', () => {
    expect(verifyWebhook(secret, body, `sha256=${sign(nowSec, body)}`, String(nowSec), now)).toBe(true);
  });

  it('rejects a wrong signature', () => {
    expect(verifyWebhook(secret, body, sign(nowSec, 'other'), String(nowSec), now)).toBe(false);
  });

  it('rejects an empty body even if correctly signed', () => {
    expect(verifyWebhook(secret, '', sign(nowSec, ''), String(nowSec), now)).toBe(false);
  });

  it('rejects a timestamp 6 minutes old', () => {
    const ts = nowSec - 6 * 60;
    expect(verifyWebhook(secret, body, sign(ts, body), String(ts), now)).toBe(false);
  });

  it('rejects a timestamp 6 minutes in the future', () => {
    const ts = nowSec + 6 * 60;
    expect(verifyWebhook(secret, body, sign(ts, body), String(ts), now)).toBe(false);
  });

  it('rejects a non-numeric timestamp and a malformed signature without throwing', () => {
    expect(verifyWebhook(secret, body, sign(nowSec, body), 'abc', now)).toBe(false);
    expect(verifyWebhook(secret, body, 'zz', String(nowSec), now)).toBe(false);
  });
});

describe('API key guard and /v1/auth/verify-webhook', () => {
  const app = buildServer({ config: testConfig() });

  it('serves /healthz without a key', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects other routes without X-RG-Key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/verify-webhook', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong X-RG-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-webhook',
      headers: { 'x-rg-key': 'nope' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('reports valid:true for a good signature using the current time', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const raw = '{"x":1}';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-webhook',
      headers: authHeaders,
      payload: { raw_body: raw, signature: sign(ts, raw), timestamp: String(ts) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true });
  });

  it('reports valid:false for a bad signature', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-webhook',
      headers: authHeaders,
      payload: { raw_body: '{"x":1}', signature: 'deadbeef', timestamp: String(ts) },
    });
    expect(res.json()).toEqual({ valid: false });
  });

  it('returns 400 for a malformed request body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-webhook',
      headers: authHeaders,
      payload: { raw_body: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
