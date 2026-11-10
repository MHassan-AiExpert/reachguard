import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { signApprovalCallback, verifyApprovalCallback } from '../lib/approval-token.js';
import type { ResolvedDeps } from '../server.js';

const SignBody = z.object({ approval_id: z.string().uuid() });
const VerifyBody = z.object({ data: z.string() });

export function registerApprovals(app: FastifyInstance, deps: ResolvedDeps): void {
  const secret = deps.config.webhookSecret;
  app.post('/v1/approvals/sign', async (req, reply) => {
    const parsed = SignBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const id = parsed.data.approval_id;
    return {
      approve: signApprovalCallback(id, 'approve', secret),
      edit: signApprovalCallback(id, 'edit', secret),
      reject: signApprovalCallback(id, 'reject', secret),
    };
  });
  app.post('/v1/approvals/verify', async (req, reply) => {
    const parsed = VerifyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const r = verifyApprovalCallback(parsed.data.data, secret);
    return r ? { valid: true, ...r } : { valid: false };
  });
}
