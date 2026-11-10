import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { precheckCopy, type CopyOutput } from '../lib/precheck.js';
import { jaccard } from '../lib/shingles.js';
import type { ResolvedDeps } from '../server.js';

const PrecheckBody = z.object({
  lead_id: z.string().uuid(),
  copy: z.unknown(),
  evidence_ids: z.array(z.string().uuid()).optional(),
  extra_banned_phrases: z.array(z.string().min(1)).max(100).optional(),
});

const SimilarityBody = z.object({
  campaign_id: z.string().uuid(),
  exclude_lead_id: z.string().uuid().optional(),
  shingle_hashes: z.array(z.string().regex(/^\d{1,16}$/)).max(5000),
});

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function registerCopy(app: FastifyInstance, deps: ResolvedDeps): void {
  app.post('/v1/copy/precheck', async (req, reply) => {
    const parsed = PrecheckBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { lead_id, copy, evidence_ids, extra_banned_phrases } = parsed.data;

    const schema = deps.contracts.validate('copy-output', copy);
    if (!schema.valid) {
      return { ok: false, violations: schema.errors.map((e) => `schema:${e}`), shingle_hashes: [] };
    }

    let ids = evidence_ids;
    if (!ids) {
      if (!deps.copyStore) return reply.code(503).send({ error: 'db_unavailable' });
      ids = await deps.copyStore.evidenceIdsForLead(lead_id);
    }
    const rules = {
      ...deps.qaRules,
      banned_phrases: [
        ...deps.qaRules.banned_phrases,
        ...(extra_banned_phrases ?? []).map((p) => p.toLowerCase()),
      ],
    };
    return precheckCopy(copy as CopyOutput, { lead_id, evidenceIds: new Set(ids), rules });
  });

  app.post('/v1/similarity', async (req, reply) => {
    const parsed = SimilarityBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!deps.copyStore) return reply.code(503).send({ error: 'db_unavailable' });
    const { campaign_id, exclude_lead_id, shingle_hashes } = parsed.data;
    const recent = await deps.copyStore.recentFirstEmailShingles(campaign_id, exclude_lead_id ?? null, 200);
    const max = recent.reduce((m, other) => Math.max(m, jaccard(shingle_hashes, other)), 0);
    return {
      max_similarity: round4(max),
      compared: recent.length,
      threshold: deps.qaRules.similarity_threshold,
      exceeds_threshold: max > deps.qaRules.similarity_threshold,
    };
  });
}
