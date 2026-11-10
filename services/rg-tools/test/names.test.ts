import { describe, expect, it } from 'vitest';
import { normalizeNames } from '../src/lib/names.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const n = (first: string, last: string, company: string) =>
  normalizeNames({ first_name: first, last_name: last, company_raw: company });

describe('normalizeNames', () => {
  it('fixes casing of all-lower and all-upper names and collapses spaces', () => {
    const r = n('  jane   ', 'DOE', 'Acme');
    expect(r.first_name).toBe('Jane');
    expect(r.last_name).toBe('Doe');
  });

  it('handles Mc, apostrophe and hyphenated names', () => {
    expect(n('x', 'mcdonald', 'A').last_name).toBe('McDonald');
    expect(n('x', "o'neil", 'A').last_name).toBe("O'Neil");
    expect(n('anne-marie', 'x', 'A').first_name).toBe('Anne-Marie');
  });

  it('leaves mixed-case names unchanged', () => {
    expect(n('x', 'DeAngelo', 'A').last_name).toBe('DeAngelo');
  });

  it('returns empty strings for missing names', () => {
    const r = normalizeNames({ company_raw: 'Acme' });
    expect(r.first_name).toBe('');
    expect(r.last_name).toBe('');
  });

  it.each([
    ['Acme Inc.', 'Acme'],
    ['Acme Holdings, LLC', 'Acme Holdings'],
    ['ACME HOLDINGS, LLC', 'Acme Holdings'],
    ['Foo GmbH', 'Foo'],
    ['Smith & Sons Ltd.', 'Smith & Sons'],
    ['IBM Corp', 'IBM'],
  ])('cleans company %j to %j with high confidence', (raw, expected) => {
    const r = n('a', 'b', raw);
    expect(r.company_clean).toBe(expected);
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('returns low confidence for an unusual company string', () => {
    expect(n('a', 'b', 'ACME!!! 4 U @@ LLC ***').confidence).toBeLessThan(0.8);
  });

  it('returns low confidence and keeps the original when only a suffix remains', () => {
    const r = n('a', 'b', 'LLC');
    expect(r.company_clean).toBe('LLC');
    expect(r.confidence).toBeLessThan(0.8);
  });

  it('returns low confidence for a company containing a URL or an email', () => {
    expect(n('a', 'b', 'visit http://x.com now').confidence).toBeLessThan(0.8);
    expect(n('a', 'b', 'bob@acme.com').confidence).toBeLessThan(0.8);
  });
});

describe('POST /v1/hygiene/normalize', () => {
  const app = buildServer({ config: testConfig() });

  it('normalizes a lead payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/normalize',
      headers: authHeaders,
      payload: { first_name: 'JANE', last_name: 'doe', company: 'Acme Inc.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      first_name: 'Jane',
      last_name: 'Doe',
      full_name: 'Jane Doe',
      company_clean: 'Acme',
    });
  });

  it('requires a company', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/normalize',
      headers: authHeaders,
      payload: { first_name: 'a' },
    });
    expect(res.statusCode).toBe(400);
  });
});
