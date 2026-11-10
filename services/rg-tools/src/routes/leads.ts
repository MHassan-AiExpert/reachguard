import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResolvedDeps } from '../server.js';

const Params = z.object({ id: z.string().uuid() });

/** Right to erasure: removes the lead and everything hanging off it, and keeps only a hash so the person is not re-imported. */
export function registerLeads(app: FastifyInstance, deps: ResolvedDeps): void {
  app.delete<{ Params: { id: string } }>('/v1/leads/:id', async (req, reply) => {
    const parsed = Params.safeParse(req.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    const { id } = parsed.data;

    const found = await deps.db.tx(async (tx) => {
      const lead = (
        await tx.query<{ email: string }>('SELECT email::text AS email FROM leads WHERE id = $1 FOR UPDATE', [
          id,
        ])
      ).rows[0];
      if (!lead) return false;
      await tx.query('DELETE FROM dead_letters WHERE lead_id = $1', [id]); // payloads can hold the address
      await tx.query("DELETE FROM suppression WHERE kind = 'email' AND value = $1", [lead.email]); // replaced by the hash below
      await tx.query(
        "INSERT INTO suppression (kind, value, reason, source) VALUES ('email_hash', encode(digest(lower($1), 'sha256'), 'hex'), 'erasure', 'DELETE /v1/leads') ON CONFLICT (kind, value) DO NOTHING",
        [lead.email],
      );
      await tx.query('DELETE FROM leads WHERE id = $1', [id]); // cascades to drafts, sends, evidence, events, replies, approvals, checks, transitions
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'lead_not_found' });
    return { deleted: true, lead_id: id };
  });
}
