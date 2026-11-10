import { describe, expect, it } from 'vitest';
import { loadContracts } from '../src/lib/contracts.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const NAMES = [
  'lead-intake',
  'normalize-output',
  'research-output',
  'scoring-output',
  'copy-output',
  'judge-output',
  'reply-classification',
];

describe('contract registry', () => {
  const registry = loadContracts(testConfig().contractsDir);

  it.each(NAMES)('compiles %s', (name) => {
    expect(registry.has(name)).toBe(true);
  });

  it('validates a good lead intake', () => {
    const r = registry.validate('lead-intake', { campaign: 'c', email: 'a@b.com', company: 'Acme' });
    expect(r).toEqual({ valid: true, errors: [] });
  });

  it('rejects a lead intake without email and reports the path', () => {
    const r = registry.validate('lead-intake', { campaign: 'c', company: 'Acme' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toContain('email');
  });

  it('rejects unknown properties on lead intake', () => {
    const r = registry.validate('lead-intake', {
      campaign: 'c',
      email: 'a@b.com',
      company: 'Acme',
      admin: true,
    });
    expect(r.valid).toBe(false);
  });

  it('accepts a malformed email string at intake (hygiene rejects it later)', () => {
    const r = registry.validate('lead-intake', { campaign: 'c', email: 'not-an-email', company: 'Acme' });
    expect(r.valid).toBe(true);
  });

  it('validates a reply classification and rejects an unknown class', () => {
    const ok = {
      classification: 'interested',
      confidence: 0.9,
      summary: 's',
      unsubscribe_intent: false,
      next_action: 'notify_hot',
    };
    expect(registry.validate('reply-classification', ok).valid).toBe(true);
    expect(registry.validate('reply-classification', { ...ok, classification: 'maybe' }).valid).toBe(false);
  });

  it('requires a uuid for copy claim evidence ids', () => {
    const base = (id: string) => ({
      variant_label: 'direct',
      sequence: [{ step: 1, subject: 's', body: 'b', claims: [{ text: 't', evidence_id: id }] }],
    });
    expect(registry.validate('copy-output', base('3f2b8e5c-1d4a-4c6e-9a7b-0e1f2a3b4c5d')).valid).toBe(true);
    expect(registry.validate('copy-output', base('not-a-uuid')).valid).toBe(false);
  });

  it('returns an error for an unknown contract name', () => {
    const r = registry.validate('nope', {});
    expect(r.valid).toBe(false);
  });
});

describe('POST /v1/contracts/validate', () => {
  const app = buildServer({ config: testConfig() });

  it('accepts valid data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/validate',
      headers: authHeaders,
      payload: { schema: 'lead-intake', data: { campaign: 'c', email: 'a@b.com', company: 'Acme' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
  });

  it('rejects data missing email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/validate',
      headers: authHeaders,
      payload: { schema: 'lead-intake', data: { campaign: 'c', company: 'Acme' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
  });

  it('returns 400 for an unknown schema name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/contracts/validate',
      headers: authHeaders,
      payload: { schema: 'nope', data: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires the API key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/contracts/validate', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
