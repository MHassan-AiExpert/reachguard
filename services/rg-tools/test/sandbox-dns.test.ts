import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { authHeaders, testConfig } from './helpers.js';

const mx = (domain: string, mode: 'sandbox' | 'live' = 'sandbox') =>
  buildServer({ config: testConfig({ mode }) }).inject({ method: 'POST', url: '/v1/hygiene/dns-mx', headers: authHeaders, payload: { domain } });

describe('sandbox DNS', () => {
  it('gives reserved .example domains a mail server without touching the network', async () => {
    const res = await mx('brightloop.example');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ has_mx: true, hosts: ['mx.brightloop.example'] });
  });

  it('reports no mail server for the nomx- domains the seed uses for bad addresses', async () => {
    expect((await mx('nomx-ledgerly.example')).json()).toEqual({ has_mx: false, hosts: [] });
  });

  it('is not used in live mode', async () => {
    // A reserved .example name has no real MX, so the real resolver must answer "no mail server" (or fail), never the fake one.
    const res = await mx('brightloop.example', 'live');
    if (res.statusCode === 200) expect(res.json().has_mx).toBe(false);
    else expect(res.statusCode).toBe(502);
  });
});
