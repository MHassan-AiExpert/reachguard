import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { inProcessApi, repoRoot } from '../lib/inprocess.js';
import type { Ctx } from '../lib/types.js';
import { runDedup } from '../suites/dedup.js';
import { runFailure } from '../suites/failure.js';
import { runHygiene } from '../suites/hygiene.js';

const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 10 }) : null;
afterAll(async () => { await pool?.end(); });

const ctx = (): Ctx => ({
  api: inProcessApi(), db: { query: (t, p) => pool!.query(t, p as unknown[]) as never }, root: repoRoot, mode: 'sandbox',
  llm: async () => ({ ok: false, reason: 'none' }), llmStatus: { available: false, reason: 'none' },
});
const part = (r: { parts: { name: string }[] }, n: string) => r.parts.find((p) => p.name === n) as any;

describe.skipIf(!url)('database-backed suites against real Postgres', () => {
  it('dedup: every concurrent duplicate scenario is absorbed, including same email under different keys', async () => {
    const p = part(await runDedup(ctx()), 'concurrency');
    expect(p.status).toBe('run');
    expect(p.cases.filter((c: any) => !c.passed)).toEqual([]);
    const left = await pool!.query("SELECT count(*)::int AS n FROM leads WHERE email::text LIKE '%@eval.example'");
    expect(left.rows[0].n).toBe(0);
  });

  it('failure: claims never overlap, leases expire, release dead-letters at the cap', async () => {
    const p = part(await runFailure(ctx()), 'claim_and_release');
    expect(p.cases.filter((c: any) => !c.passed)).toEqual([]);
  });

  it('hygiene rules: all 23 planted bad leads caught, no clean lead blocked, suppression seed removed afterwards', async () => {
    const p = part(await runHygiene(ctx()), 'rules');
    expect(p.status).toBe('run');
    expect(p.cases.filter((c: any) => !c.passed)).toEqual([]);
    expect((await pool!.query("SELECT count(*)::int AS n FROM suppression WHERE source = 'eval-seed'")).rows[0].n).toBe(0);
  });
});
