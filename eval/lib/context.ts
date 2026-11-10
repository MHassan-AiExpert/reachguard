import pg from 'pg';
import { repoRoot } from './inprocess.js';
import type { Api, Ctx, Db, LlmCaller, LlmOutcome } from './types.js';

export function httpApi(baseUrl: string, key: string): Api {
  return {
    async post(route, body) {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rg-key': key },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* keep text */
      }
      return { status: res.status, json };
    },
  };
}

export interface Built {
  ctx: Ctx;
  close(): Promise<void>;
  /** Models that answered at least one call, filled in as LLM parts run. */
  models: Set<string>;
}

/** Builds the context for a run against a live rg-tools service. LLM availability is probed once and remembered. */
export async function buildContext(env: NodeJS.ProcessEnv = process.env): Promise<Built> {
  const baseUrl = env.RG_TOOLS_URL ?? 'http://localhost:8080';
  const key = env.RG_TOOLS_API_KEY ?? '';
  const api = httpApi(baseUrl, key);
  const pool = env.DATABASE_URL ? new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 }) : null;
  const db: Db | null = pool ? { query: (t, p) => pool.query(t, p as unknown[]) as never } : null;
  const models = new Set<string>();

  const plan = await api.post('/v1/schedule/plan', { delays: [0] }).catch((e: Error) => ({ status: 0, json: { error: e.message } }));
  if (plan.status !== 200) throw new Error(`cannot reach rg-tools at ${baseUrl} (HTTP ${plan.status}: ${JSON.stringify(plan.json).slice(0, 120)}). Start it first, or run scripts/eval-local.sh.`);
  const mode = String(plan.json.mode);

  const call: LlmCaller = async (agent, variables): Promise<LlmOutcome> => {
    const res = await api.post('/v1/llm/run', { agent, variables });
    if (res.status !== 200) return { ok: false, reason: `LLM gateway returned HTTP ${res.status}${res.json?.error ? ` (${res.json.error})` : ''}` };
    if (db && res.json.call_id) {
      const m = (await db.query('SELECT model FROM llm_calls WHERE id = $1', [res.json.call_id])).rows[0]?.model;
      if (m) models.add(m);
    }
    return { ok: true, output: res.json.output };
  };

  let probe: Promise<Ctx['llmStatus']> | null = null;
  const ctx: Ctx = {
    api, db, root: repoRoot, mode, llm: call,
    llmStatus: { available: false, reason: 'not probed' },
  };
  // One cheap call decides whether every LLM part runs, so an unavailable gateway yields "not run", never a fake zero.
  probe = (async () => {
    const o = await call('reply-classifier', { subject: 'Quick question', reply_body: 'Thanks, not interested.' });
    return o.ok ? { available: true } : { available: false, reason: o.reason };
  })();
  ctx.llmStatus = await probe;
  return { ctx, models, close: async () => { await pool?.end(); } };
}
