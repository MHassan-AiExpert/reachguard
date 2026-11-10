import type { FastifyInstance } from 'fastify';
import type { ResolvedDeps } from '../server.js';

export function registerHealth(app: FastifyInstance, deps: ResolvedDeps): void {
  app.get('/healthz', async () => {
    if (!deps.db) return { ok: true, db: 'unconfigured' };
    try {
      await deps.db.query('SELECT 1');
      return { ok: true, db: 'up' };
    } catch {
      return { ok: false, db: 'down' };
    }
  });
}
