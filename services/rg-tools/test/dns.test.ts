import { describe, expect, it } from 'vitest';
import { createMemoryCache, mxLookup, type DnsResolver } from '../src/lib/mx.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

function dnsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function fakeResolver(opts: {
  mx?: { exchange: string; priority: number }[] | Error;
  a?: string[] | Error;
}): DnsResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveMx(domain) {
      calls.push(`mx:${domain}`);
      if (opts.mx instanceof Error) throw opts.mx;
      return opts.mx ?? [];
    },
    async resolve4(domain) {
      calls.push(`a:${domain}`);
      if (opts.a instanceof Error) throw opts.a;
      return opts.a ?? [];
    },
  };
}

describe('mxLookup', () => {
  it('returns hosts sorted by priority when MX records exist', async () => {
    const r = fakeResolver({
      mx: [
        { exchange: 'mx2.example.com', priority: 20 },
        { exchange: 'mx1.example.com', priority: 10 },
      ],
    });
    const out = await mxLookup('Example.COM.', { resolver: r, cache: createMemoryCache() });
    expect(out).toEqual({ has_mx: true, hosts: ['mx1.example.com', 'mx2.example.com'] });
    expect(r.calls[0]).toBe('mx:example.com');
  });

  it('treats ENODATA on MX with no A record as no mail server', async () => {
    const r = fakeResolver({ mx: dnsError('ENODATA'), a: dnsError('ENODATA') });
    expect(await mxLookup('x.com', { resolver: r, cache: createMemoryCache() })).toEqual({
      has_mx: false,
      hosts: [],
    });
  });

  it('falls back to the A record when there is no MX', async () => {
    const r = fakeResolver({ mx: dnsError('ENODATA'), a: ['203.0.113.5'] });
    expect(await mxLookup('x.com', { resolver: r, cache: createMemoryCache() })).toEqual({
      has_mx: true,
      hosts: ['x.com'],
    });
  });

  it('treats a nonexistent domain as no mail server', async () => {
    const r = fakeResolver({ mx: dnsError('ENOTFOUND'), a: dnsError('ENOTFOUND') });
    expect((await mxLookup('nope.invalid', { resolver: r, cache: createMemoryCache() })).has_mx).toBe(false);
  });

  it('treats a null MX (RFC 7505) as no mail server', async () => {
    const r = fakeResolver({ mx: [{ exchange: '', priority: 0 }] });
    expect((await mxLookup('x.com', { resolver: r, cache: createMemoryCache() })).has_mx).toBe(false);
  });

  it('caches results so the resolver is called once per domain', async () => {
    const r = fakeResolver({ mx: [{ exchange: 'mx.x.com', priority: 1 }] });
    const cache = createMemoryCache();
    await mxLookup('x.com', { resolver: r, cache });
    await mxLookup('X.com', { resolver: r, cache });
    expect(r.calls.filter((c) => c.startsWith('mx:'))).toHaveLength(1);
  });

  it('throws on a transient resolver error and does not cache it', async () => {
    const bad = fakeResolver({ mx: dnsError('ESERVFAIL') });
    const cache = createMemoryCache();
    await expect(mxLookup('x.com', { resolver: bad, cache })).rejects.toThrow();
    const good = fakeResolver({ mx: [{ exchange: 'mx.x.com', priority: 1 }] });
    expect((await mxLookup('x.com', { resolver: good, cache })).has_mx).toBe(true);
  });
});

describe('POST /v1/hygiene/dns-mx', () => {
  it('returns the lookup result using the injected resolver', async () => {
    const app = buildServer({
      config: testConfig(),
      dns: fakeResolver({ mx: [{ exchange: 'mx.acme.com', priority: 5 }] }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/dns-mx',
      headers: authHeaders,
      payload: { domain: 'acme.com' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ has_mx: true, hosts: ['mx.acme.com'] });
  });

  it('returns 502 on a transient DNS failure so the workflow retries', async () => {
    const app = buildServer({ config: testConfig(), dns: fakeResolver({ mx: dnsError('ETIMEOUT') }) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/dns-mx',
      headers: authHeaders,
      payload: { domain: 'acme.com' },
    });
    expect(res.statusCode).toBe(502);
  });

  it('returns 400 when the domain is missing', async () => {
    const app = buildServer({ config: testConfig() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/hygiene/dns-mx',
      headers: authHeaders,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
