import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { classifyEmail } from '../lib/email.js';
import { checkDnsAuth } from '../lib/dns-auth.js';
import { mxLookup } from '../lib/mx.js';
import { normalizeNames } from '../lib/names.js';
import type { ResolvedDeps } from '../server.js';

const EmailBody = z.object({ email: z.string() });
const NormalizeBody = z.object({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company: z.string().min(1),
});
const MxBody = z.object({ domain: z.string().min(1) });

export function registerHygiene(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/hygiene/classify-email', async (req, reply) => {
    const parsed = EmailBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    return classifyEmail(parsed.data.email, deps.lists);
  });

  app.post('/v1/hygiene/normalize', async (req, reply) => {
    const parsed = NormalizeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { first_name, last_name, company } = parsed.data;
    const r = normalizeNames({ first_name, last_name, company_raw: company });
    return { ...r, full_name: [r.first_name, r.last_name].filter(Boolean).join(' ') };
  });

  app.post('/v1/hygiene/dns-mx', async (req, reply) => {
    const parsed = MxBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      return await mxLookup(parsed.data.domain, { resolver: deps.dns, cache: deps.mxCache });
    } catch {
      return reply.code(502).send({ error: 'dns_unavailable' });
    }
  });

  app.post('/v1/hygiene/dns-auth', async (req, reply) => {
    const parsed = MxBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // Sandbox domains are not real, so there is nothing to look up; the answer is fixed and says so.
    if (deps.config.mode === 'sandbox') return { spf_ok: true, dkim_ok: true, dmarc_ok: true, provider: 'sandbox' };
    try {
      const r = await checkDnsAuth(parsed.data.domain, deps.config.dkimSelector, deps.txt);
      return { ...r, provider: 'dns' };
    } catch {
      return reply.code(502).send({ error: 'dns_unavailable' });
    }
  });
}
