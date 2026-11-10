import { describe, expect, it } from 'vitest';
import { checkDnsAuth, type TxtResolver } from '../src/lib/dns-auth.js';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

function txt(records: Record<string, string[][] | Error>): TxtResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolveTxt(name) {
      calls.push(name);
      const r = records[name];
      if (r instanceof Error) throw r;
      if (!r) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
      return r;
    },
  };
}

describe('checkDnsAuth', () => {
  it('passes when SPF, DKIM at the selector and DMARC all exist', async () => {
    const r = txt({
      'send.example.com': [['v=spf1 include:_spf.example.net ~all']],
      'rg._domainkey.send.example.com': [['v=DKIM1; k=rsa; p=MIIB']],
      '_dmarc.send.example.com': [['v=DMARC1; p=quarantine']],
    });
    expect(await checkDnsAuth('Send.Example.com.', 'rg', r)).toEqual({ spf_ok: true, dkim_ok: true, dmarc_ok: true });
    expect(r.calls).toContain('rg._domainkey.send.example.com');
  });

  it('joins TXT chunks and ignores unrelated TXT records', async () => {
    const r = txt({
      'a.com': [['google-site-verification=abc'], ['v=spf1 ', 'include:x.com -all']],
      'rg._domainkey.a.com': [['v=DKIM1; p=', 'AAAA']],
      '_dmarc.a.com': [['v=DMARC1; p=none']],
    });
    expect((await checkDnsAuth('a.com', 'rg', r)).spf_ok).toBe(true);
  });

  it('reports each missing record as false instead of throwing', async () => {
    const r = txt({ 'a.com': [['v=spf1 -all']] });
    expect(await checkDnsAuth('a.com', 'rg', r)).toEqual({ spf_ok: true, dkim_ok: false, dmarc_ok: false });
  });

  it('rejects a DKIM record with an empty key (revoked)', async () => {
    const r = txt({ 'a.com': [['v=spf1 -all']], 'rg._domainkey.a.com': [['v=DKIM1; p=']], '_dmarc.a.com': [['v=DMARC1; p=none']] });
    expect((await checkDnsAuth('a.com', 'rg', r)).dkim_ok).toBe(false);
  });

  it('throws on a transient resolver error so the caller does not pause a domain on a DNS blip', async () => {
    const r = txt({ 'a.com': Object.assign(new Error('x'), { code: 'ESERVFAIL' }) });
    await expect(checkDnsAuth('a.com', 'rg', r)).rejects.toThrow();
  });
});

describe('POST /v1/hygiene/dns-auth', () => {
  it('uses the configured selector in live mode', async () => {
    const r = txt({
      'a.com': [['v=spf1 -all']],
      'sel._domainkey.a.com': [['v=DKIM1; p=KEY']],
      '_dmarc.a.com': [['v=DMARC1; p=reject']],
    });
    const app = buildServer({ config: testConfig({ mode: 'live', dkimSelector: 'sel' }), txt: r });
    const res = await app.inject({ method: 'POST', url: '/v1/hygiene/dns-auth', headers: authHeaders, payload: { domain: 'a.com' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ spf_ok: true, dkim_ok: true, dmarc_ok: true });
  });

  it('passes without touching DNS in sandbox mode (sandbox domains are not real)', async () => {
    const r = txt({});
    const app = buildServer({ config: testConfig({ mode: 'sandbox' }), txt: r });
    const res = await app.inject({ method: 'POST', url: '/v1/hygiene/dns-auth', headers: authHeaders, payload: { domain: 'sandbox.test' } });
    expect(res.json()).toMatchObject({ spf_ok: true, dkim_ok: true, dmarc_ok: true, provider: 'sandbox' });
    expect(r.calls).toEqual([]);
  });

  it('returns 502 on a transient DNS failure and 400 for a missing domain', async () => {
    const bad = txt({ 'a.com': Object.assign(new Error('x'), { code: 'ETIMEOUT' }) });
    const app = buildServer({ config: testConfig({ mode: 'live' }), txt: bad });
    expect((await app.inject({ method: 'POST', url: '/v1/hygiene/dns-auth', headers: authHeaders, payload: { domain: 'a.com' } })).statusCode).toBe(502);
    expect((await app.inject({ method: 'POST', url: '/v1/hygiene/dns-auth', headers: authHeaders, payload: {} })).statusCode).toBe(400);
  });
});
