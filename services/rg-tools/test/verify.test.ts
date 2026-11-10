import { describe, expect, it } from 'vitest';
import { createVerifier, NotConfigured } from '../src/adapters/verify/index.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

describe('sandbox verifier', () => {
  const v = createVerifier(testConfig({ mode: 'sandbox' }));

  it('returns valid when no tag applies', async () => {
    expect(await v.verify('a@x.com', 'primary', { tags: [] })).toEqual({
      result: 'valid',
      provider: 'sandbox',
      cost_usd: 0,
    });
  });

  it('maps tags to results on the primary tier', async () => {
    expect((await v.verify('a@x.com', 'primary', { tags: ['invalid'] })).result).toBe('invalid');
    expect((await v.verify('a@x.com', 'primary', { tags: ['catch_all'] })).result).toBe('catch_all');
    expect((await v.verify('a@x.com', 'primary', { tags: ['risky'] })).result).toBe('risky');
    expect((await v.verify('a@x.com', 'primary', { tags: ['unknown'] })).result).toBe('unknown');
  });

  it('lets escalation resolve a risky primary result to valid', async () => {
    expect((await v.verify('a@x.com', 'escalation', { tags: ['risky'] })).result).toBe('valid');
  });

  it('keeps catch_all and unknown on escalation', async () => {
    expect((await v.verify('a@x.com', 'escalation', { tags: ['catch_all'] })).result).toBe('catch_all');
    expect((await v.verify('a@x.com', 'escalation', { tags: ['unknown'] })).result).toBe('unknown');
  });
});

describe('live verifier', () => {
  it('throws NotConfigured until a vendor adapter is implemented', async () => {
    const v = createVerifier(testConfig({ mode: 'live' }));
    await expect(v.verify('a@x.com', 'primary')).rejects.toBeInstanceOf(NotConfigured);
  });
});

describe('POST /v1/verify', () => {
  it('returns the sandbox outcome', async () => {
    const app = buildServer({ config: testConfig() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      headers: authHeaders,
      payload: { email: 'a@x.com', tier: 'primary', tags: ['invalid'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ result: 'invalid', provider: 'sandbox' });
  });

  it('returns 501 when the live adapter is not configured', async () => {
    const app = buildServer({ config: testConfig({ mode: 'live' }) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      headers: authHeaders,
      payload: { email: 'a@x.com', tier: 'primary' },
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns 400 for an unknown tier', async () => {
    const app = buildServer({ config: testConfig() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/verify',
      headers: authHeaders,
      payload: { email: 'a@x.com', tier: 'gold' },
    });
    expect(res.statusCode).toBe(400);
  });
});
