import { randomUUID } from 'node:crypto';
import { fraction, notRun, type Case, type Ctx, type PartResult, type SuiteResult } from '../lib/types.js';

const SCOPE = 'The claim, lease and release functions in Postgres, driven by concurrent workers. It does not stop containers or break vendors.';
const STACK = 'Provider outage, n8n worker crash mid-run, LLM 429 storm and Redis restart.';

export async function runFailure(ctx: Ctx): Promise<SuiteResult> {
  const stack = notRun('stack_faults', STACK, 'needs the running n8n stack and fault injection (make demo, then stop services); not part of this run');
  if (!ctx.db) return { suite: 'failure', parts: [notRun('claim_and_release', SCOPE, 'needs a database (set DATABASE_URL)'), stack] };
  if (ctx.mode !== 'sandbox') return { suite: 'failure', parts: [notRun('claim_and_release', SCOPE, `writes and deletes rows, so it only runs when rg-tools reports MODE=sandbox (got ${ctx.mode})`), stack] };
  const db = ctx.db;
  const tag = randomUUID().slice(0, 8);
  const cases: Case[] = [];
  const camp = `eval-failure-${tag}`;
  await db.query("INSERT INTO campaigns (name, status) VALUES ($1, 'active')", [camp]);
  const cid = (await db.query('SELECT id FROM campaigns WHERE name = $1', [camp])).rows[0]!.id;
  const mk = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await db.query("INSERT INTO leads (campaign_id, idempotency_key, email, company_raw, status) VALUES ($1, $2, $3, 'Eval Co', 'received') RETURNING id", [cid, `f-${tag}-${randomUUID()}`, `f${i}-${tag}-${randomUUID().slice(0, 4)}@eval.example`]);
      ids.push(r.rows[0]!.id);
    }
    return ids;
  };
  try {
    // Exclusivity: 4 workers each ask for 10 of 20 leads at once; no lead may be handed out twice.
    const ids = await mk(20);
    const claims = await Promise.all(['w1', 'w2', 'w3', 'w4'].map((w) => db.query("SELECT id FROM claim_leads('received', 10, $1) WHERE id = ANY($2::uuid[])", [w, ids])));
    const got = claims.flatMap((c) => c.rows.map((r) => r.id));
    cases.push({ id: 'concurrent claims never overlap', passed: got.length === new Set(got).size && got.length === 20, expected: { claimed: 20, distinct: 20 }, actual: { claimed: got.length, distinct: new Set(got).size } });

    // Lease: a lease that has run out lets another worker take the lead, a live lease does not.
    const [l] = await mk(1);
    await db.query("SELECT 1 FROM claim_leads('received', 1000, 'w-a') WHERE id = $1", [l]);
    const live = (await db.query("SELECT id FROM claim_leads('received', 1000, 'w-b') WHERE id = $1", [l])).rows.length;
    await db.query("UPDATE leads SET locked_at = now() - interval '11 minutes' WHERE id = $1", [l]);
    const expired = (await db.query("SELECT id FROM claim_leads('received', 1000, 'w-b') WHERE id = $1", [l])).rows.length;
    cases.push({ id: 'live lease holds, expired lease is reclaimed', passed: live === 0 && expired === 1, expected: { while_live: 0, after_expiry: 1 }, actual: { while_live: live, after_expiry: expired } });

    // Release: below the cap the lead is retried later, at the cap it goes to failed with a dead letter.
    const [m] = await mk(1);
    await db.query("UPDATE leads SET attempts = 2 WHERE id = $1", [m]);
    const retry = (await db.query("SELECT release_lead($1, 'boom', 5)", [m])).rows[0]!.release_lead;
    const afterRetry = (await db.query('SELECT status::text AS status FROM leads WHERE id = $1', [m])).rows[0]!.status;
    await db.query("UPDATE leads SET attempts = 5 WHERE id = $1", [m]);
    const final = (await db.query("SELECT release_lead($1, 'boom', 5)", [m])).rows[0]!.release_lead;
    const st = (await db.query('SELECT status::text AS status FROM leads WHERE id = $1', [m])).rows[0]!.status;
    const dl = (await db.query('SELECT count(*)::int AS n FROM dead_letters WHERE lead_id = $1', [m])).rows[0]!.n;
    cases.push({ id: 'retry below cap, dead letter at cap', passed: retry === true && afterRetry === 'received' && final === false && st === 'failed' && dl === 1, expected: { retry: true, status_at_cap: 'failed', dead_letters: 1 }, actual: { retry, afterRetry, final, status_at_cap: st, dead_letters: dl } });
  } finally {
    await db.query("DELETE FROM dead_letters WHERE lead_id IN (SELECT id FROM leads WHERE campaign_id = $1)", [cid]);
    await db.query('DELETE FROM leads WHERE campaign_id = $1', [cid]);
    await db.query('DELETE FROM campaigns WHERE id = $1', [cid]);
  }
  const ok = cases.filter((c) => c.passed).length;
  const part: PartResult = {
    name: 'claim_and_release', scope: SCOPE, status: 'run',
    metrics: [{ name: 'claim, lease and release scenarios handled', value: ok, display: fraction(ok, cases.length), target: 'must be 100%', met: ok === cases.length }],
    cases,
  };
  return { suite: 'failure', parts: [part, stack] };
}
