import { describe, expect, it } from 'vitest';
import { classifyEmail, loadHygieneLists } from '../src/lib/email.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const lists = loadHygieneLists(testConfig().configDir);

describe('classifyEmail', () => {
  it('trims, lower-cases and keeps plus tags in the address but not in the dedupe key', () => {
    const r = classifyEmail('  Jane.Doe+x@Example.COM ', lists);
    expect(r.normalized).toBe('jane.doe+x@example.com');
    expect(r.dedupe_key).toBe('jane.doe@example.com');
    expect(r.syntax_ok).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it.each([
    'a@b',
    'a b@c.com',
    '@x.com',
    'a@',
    'a@@b.com',
    'a..b@x.com',
    '.a@x.com',
    'a.@x.com',
    'plain',
    '',
    '   ',
    `${'a'.repeat(65)}@x.com`,
    'a@-bad.com',
    'a@bad-.com',
    'a@x.c',
  ])('fails syntax for %j', (raw) => {
    expect(classifyEmail(raw, lists).syntax_ok).toBe(false);
  });

  it('flags role addresses, including with a plus tag', () => {
    expect(classifyEmail('info@x.com', lists).flags).toContain('role');
    expect(classifyEmail('Sales+eu@x.com', lists).flags).toContain('role');
    expect(classifyEmail('jane@x.com', lists).flags).not.toContain('role');
  });

  it('flags disposable domains and their subdomains', () => {
    expect(classifyEmail('x@mailinator.com', lists).flags).toContain('disposable');
    expect(classifyEmail('x@sub.mailinator.com', lists).flags).toContain('disposable');
  });

  it('flags free providers', () => {
    expect(classifyEmail('x@gmail.com', lists).flags).toContain('free_provider');
    expect(classifyEmail('x@acme-corp.com', lists).flags).not.toContain('free_provider');
  });

  it('converts an internationalised domain to punycode without throwing', () => {
    const r = classifyEmail('user@bücher.example', lists);
    expect(r.normalized).toBe('user@xn--bcher-kva.example');
    expect(r.syntax_ok).toBe(true);
  });

  it('rejects a non-ASCII local part without throwing', () => {
    expect(classifyEmail('josé@x.com', lists).syntax_ok).toBe(false);
  });
});

describe('POST /v1/hygiene/classify-email', () => {
  const app = buildServer({ config: testConfig() });

  it('classifies an address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/classify-email',
      headers: authHeaders,
      payload: { email: 'Info@Acme.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ normalized: 'info@acme.com', syntax_ok: true, flags: ['role'] });
  });

  it('returns 400 for a non-string email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/classify-email',
      headers: authHeaders,
      payload: { email: 5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
