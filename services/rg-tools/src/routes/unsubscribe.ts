import type { FastifyInstance } from 'fastify';
import { verifyUnsubscribeToken } from '../lib/tokens.js';
import type { ResolvedDeps } from '../server.js';

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style>` +
  `</head><body>${body}</body></html>`;

const INVALID = page(
  'Link not valid',
  '<h1>This link is not valid</h1><p>It may have been copied incorrectly. Reply to the email and ask to be removed and it will be done.</p>',
);
const DONE = page(
  'Unsubscribed',
  '<h1>You have been unsubscribed</h1><p>You will not receive further emails from us. This can take a moment to apply everywhere.</p>',
);

export function registerUnsubscribe(app: FastifyInstance, deps: ResolvedDeps): void {
  // RFC 8058 clients POST form data; Fastify has no parser for it by default.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );

  const leadFor = (token: string): string | null =>
    verifyUnsubscribeToken(token, deps.config.unsubscribeSecret);

  // GET only shows a confirmation: mail security scanners prefetch links and must not unsubscribe people by accident.
  app.get<{ Params: { token: string } }>('/u/:token', async (req, reply) => {
    const id = leadFor(req.params.token);
    if (!id) return reply.code(400).type('text/html; charset=utf-8').send(INVALID);
    return reply
      .type('text/html; charset=utf-8')
      .send(
        page(
          'Unsubscribe',
          `<h1>Unsubscribe</h1><p>Stop all emails from us to this address?</p><form method="post" action="/u/${req.params.token}"><button type="submit">Confirm unsubscribe</button></form>`,
        ),
      );
  });

  app.post<{ Params: { token: string } }>('/u/:token', async (req, reply) => {
    const id = leadFor(req.params.token);
    if (!id) return reply.code(400).type('text/html; charset=utf-8').send(INVALID);
    if (!deps.db) return reply.code(503).send({ error: 'db_unavailable' });
    const oneClick = typeof req.body === 'string' && req.body.includes('List-Unsubscribe=One-Click');

    await deps.db.tx(async (tx) => {
      const lead = (
        await tx.query<{ email: string; status: string }>(
          'SELECT email::text AS email, status::text AS status FROM leads WHERE id = $1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!lead) return; // already erased: nothing left to suppress
      const added = await tx.query(
        "INSERT INTO suppression (kind, value, reason, source) VALUES ('email', $1, 'unsubscribe', $2) ON CONFLICT (kind, value) DO NOTHING RETURNING id",
        [lead.email, oneClick ? 'one_click' : 'link'],
      );
      await tx.query(
        "UPDATE sends SET status = 'cancelled', failure = 'unsubscribed' WHERE lead_id = $1 AND status = 'scheduled'",
        [id],
      );
      if (lead.status !== 'suppressed') {
        const legal = await tx.query(
          "SELECT 1 FROM lead_status_transitions WHERE from_status = $1::lead_status AND to_status = 'suppressed'",
          [lead.status],
        );
        if ((legal.rowCount ?? 0) > 0) {
          await tx.query(
            "SELECT transition_lead($1, $2::lead_status, 'suppressed', 'unsubscribe', 'unsubscribe_endpoint')",
            [id, lead.status],
          );
        }
      }
      if ((added.rowCount ?? 0) > 0) {
        await tx.query("INSERT INTO events (lead_id, type, payload) VALUES ($1, 'unsubscribe', $2::jsonb)", [
          id,
          JSON.stringify({ source: oneClick ? 'one_click' : 'link' }),
        ]);
      }
    });
    return reply.type('text/html; charset=utf-8').send(DONE);
  });
}
