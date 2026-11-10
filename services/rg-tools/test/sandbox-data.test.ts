import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { authHeaders, repoRoot, testConfig } from './helpers.js';

type Lead = { email: string; website?: string; expected: { group: string }; [k: string]: unknown };
const leads: Lead[] = JSON.parse(readFileSync(path.join(repoRoot, 'sandbox/leads.seed.json'), 'utf8'));
const app = buildServer({ config: testConfig() });
const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: authHeaders, payload });

describe('sandbox seed data against the real hygiene code', () => {
  it('every seed lead satisfies the intake contract once the eval-only field is removed', async () => {
    for (const { expected: _e, ...intake } of leads) {
      const res = await post('/v1/contracts/validate', { schema: 'lead-intake', data: intake });
      expect(res.json(), intake.email as string).toMatchObject({ valid: true });
    }
  });

  it('the intake contract would reject a lead that still carries `expected`', async () => {
    const res = await post('/v1/contracts/validate', { schema: 'lead-intake', data: leads[0] });
    expect(res.json().valid).toBe(false);
  });

  it.each([
    ['role_based', 'role'],
    ['disposable', 'disposable'],
    ['free_provider', 'free_provider'],
  ])('%s leads carry the %s flag and no clean group does', async (group, flag) => {
    for (const l of leads) {
      const res = await post('/v1/hygiene/classify-email', { email: String(l.email).trim() });
      const flags: string[] = res.json().flags ?? [];
      if (l.expected.group === group) expect(flags, l.email).toContain(flag);
      else if (['ideal_fit', 'catch_all', 'eu_uk', 'weak_icp', 'injection_site', 'thin_site', 'near_duplicate_company'].includes(l.expected.group)) {
        expect(flags, l.email).not.toContain(flag);
      }
    }
  });

  it('only the no_mx group lacks a mail server in the sandbox', async () => {
    for (const l of leads) {
      const domain = String(l.email).trim().split('@')[1]!.toLowerCase();
      const res = await post('/v1/hygiene/dns-mx', { domain });
      expect(res.json().has_mx, l.email).toBe(l.expected.group !== 'no_mx');
    }
  });

  it('fixture sites are served and carry the planted strings for the injection group', async () => {
    for (const l of leads.filter((x) => x.expected.group === 'injection_site')) {
      const slug = new URL(l.website!).hostname.split('.')[0];
      const pages = await Promise.all(['', '/about', '/news'].map((p) => app.inject({ method: 'GET', url: `/sandbox/sites/${slug}${p}`, headers: authHeaders })));
      const body = pages.map((p) => p.body).join('\n');
      for (const s of (l.expected as unknown as { planted_strings: string[] }).planted_strings) expect(body, slug).toContain(s);
    }
  });
});
