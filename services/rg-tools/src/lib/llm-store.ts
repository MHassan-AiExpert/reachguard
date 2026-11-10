import type { Db } from '../db.js';

export interface LlmCallRow {
  run_id: string | null;
  lead_id: string | null;
  agent: string;
  provider: string;
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  status: 'ok' | 'schema_invalid' | 'error';
  error: string | null;
}

export interface LlmStore {
  getSetting(key: string): Promise<unknown>;
  spendToday(): Promise<number>;
  insertCall(row: LlmCallRow): Promise<string>;
  upsertPromptVersion(agent: string, version: string, hash: string): Promise<void>;
}

export function createPgLlmStore(db: Db): LlmStore {
  return {
    async getSetting(key) {
      const r = await db.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]);
      return r.rows[0]?.value;
    },
    async spendToday() {
      const r = await db.query<{ usd: string }>('SELECT usd FROM v_llm_spend_today');
      return Number(r.rows[0]?.usd ?? 0);
    },
    async insertCall(row) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO llm_calls (run_id, lead_id, agent, provider, model, prompt_version, input_tokens,
                                output_tokens, cost_usd, latency_ms, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          row.run_id,
          row.lead_id,
          row.agent,
          row.provider,
          row.model,
          row.prompt_version,
          row.input_tokens,
          row.output_tokens,
          row.cost_usd,
          row.latency_ms,
          row.status,
          row.error,
        ],
      );
      return (r.rows[0] as { id: string }).id;
    },
    async upsertPromptVersion(agent, version, hash) {
      await db.query(
        `INSERT INTO prompt_versions (agent, version, content_hash) VALUES ($1,$2,$3)
         ON CONFLICT (agent, version) DO UPDATE SET content_hash = EXCLUDED.content_hash`,
        [agent, version, hash],
      );
    },
  };
}
