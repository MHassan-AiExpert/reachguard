import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../services/rg-tools/src/config.js';
import { buildServer } from '../../services/rg-tools/src/server.js';
import type { Api } from './types.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The real rg-tools server running inside this process, with no network and no database. Tests use it so the
 * suites are exercised against the actual hygiene, precheck and rule code instead of mocks of it.
 */
export function inProcessApi(env: Record<string, string> = {}): Api {
  const config = loadConfig({
    MODE: 'sandbox',
    LLM_MODE: 'replay',
    RG_TOOLS_API_KEY: 'eval-key',
    RG_WEBHOOK_SECRET: 'eval-secret',
    RG_UNSUBSCRIBE_SECRET: 'eval-unsub',
    SENDER_PHYSICAL_ADDRESS: 'Eval Test Co, Lahore, Pakistan',
    RG_ROOT: repoRoot,
    ...env,
  });
  const app = buildServer({ config });
  return {
    async post(route, body) {
      const res = await app.inject({ method: 'POST', url: route, headers: { 'x-rg-key': 'eval-key' }, payload: body as Record<string, unknown> });
      let json: unknown = null;
      try {
        json = res.json();
      } catch {
        json = res.body;
      }
      return { status: res.statusCode, json };
    },
  };
}
