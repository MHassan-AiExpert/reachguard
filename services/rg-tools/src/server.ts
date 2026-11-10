import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { loadContracts, type ContractRegistry } from './lib/contracts.js';
import { registerAuth } from './routes/auth.js';
import { registerContracts } from './routes/contracts.js';
import { registerHealth } from './routes/health.js';

export interface Deps {
  config: Config;
  db?: Db;
  contracts?: ContractRegistry;
}

export interface ResolvedDeps extends Deps {
  contracts: ContractRegistry;
}

const PUBLIC_PREFIXES = ['/healthz', '/u/'];

function keysMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildServer(deps: Deps): FastifyInstance {
  const resolved: ResolvedDeps = {
    ...deps,
    contracts: deps.contracts ?? loadContracts(deps.config.contractsDir),
  };
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (PUBLIC_PREFIXES.some((p) => url === p || url.startsWith(p))) return;
    const header = req.headers['x-rg-key'];
    if (!keysMatch(Array.isArray(header) ? header[0] : header, deps.config.apiKey)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  registerHealth(app, resolved);
  registerAuth(app, resolved);
  registerContracts(app, resolved);
  return app;
}
