import { randomUUID } from 'node:crypto';
import { fraction, notRun, type Case, type Ctx, type Db, type PartResult, type SuiteResult } from '../lib/types.js';
import { workflowStatement } from '../lib/util.js';

export async function countDuplicateSends(db: Db): Promise<number> {
  const r = await db.query('SELECT count(*)::int AS n FROM (SELECT 1 FROM sends GROUP BY lead_id, step HAVING count(*) > 1) d');
  return r.rows[0]?.n ?? 0;
}

const SCOPE = 'The exact SQL of WF-01 (insert lead), WF-09 (insert event) and WF-08a (create sends) from workflows/dist, fired concurrently against Postgres. It does not run n8n.';
const N = 20;
const CAMPAIGN = 'eval-dedup';

const leadParams = (email: string, key: string, idx: number) => [CAMPAIGN, key, email, 'Eval', 'Lead', 'CTO', 'Eval Co', 'https://eval.example', 'US', 'eval', 'ref', '[]', '{}', true, idx];
const settle = async (jobs: Promise<unknown>[]) => (await Promise.allSettled(jobs));

export async function runDedup(ctx: Ctx): Promise<SuiteResult> {
  if (!ctx.db) return { suite: 'dedup', parts: [notRun('concurrency', SCOPE, 'needs a database (set DATABASE_URL)')] };
  if (ctx.mode !== 'sandbox') return { suite: 'dedup', parts: [notRun('concurrency', SCOPE, `writes and deletes rows, so it only runs when rg-tools reports MODE=sandbox (got ${ctx.mode})`)] };
  const db = ctx.db;
  const insertLead = workflowStatement(ctx.root, 'WF-01', 'Insert lead');
  const insertEvent = workflowStatement(ctx.root, 'WF-09', 'Insert event');
  const createSends = workflowStatement(ctx.root, 'WF-08a', 'Create sends');
  const tag = randomUUID().slice(0, 8);
  const cases: Case[] = [];

  await db.query("INSERT INTO campaigns (name, status) VALUES ($1, 'active') ON CONFLICT (name) DO NOTHING", [CAMPAIGN]);
  try {
    // 1. Same lead delivered N times at once with the same idempotency key.
    const e1 = `dup1-${tag}@eval.example`;
    const r1 = await settle(Array.from({ length: N }, (_, i) => db.query(insertLead, leadParams(e1, `k1-${tag}`, i))));
    const c1 = (await db.query('SELECT count(*)::int AS n FROM leads WHERE email = $1::citext', [e1])).rows[0]!.n;
    cases.push({ id: 'same idempotency key x20', passed: c1 === 1, expected: { rows: 1 }, actual: { rows: c1, errors: r1.filter((r) => r.status === 'rejected').length } });

    // 2. Same email arriving at once under different idempotency keys.
    const e2 = `dup2-${tag}@eval.example`;
    const r2 = await settle(Array.from({ length: N }, (_, i) => db.query(insertLead, leadParams(e2, `k2-${tag}-${i}`, i))));
    const c2 = (await db.query('SELECT count(*)::int AS n FROM leads WHERE email = $1::citext', [e2])).rows[0]!.n;
    const errs2 = r2.filter((r) => r.status === 'rejected').length;
    cases.push({ id: 'same email, different keys x20', passed: c2 === 1 && errs2 === 0, expected: { rows: 1, errors: 0 }, actual: { rows: c2, errors: errs2 } });

    // 3. A provider event replayed N times at once.
    const leadId = (await db.query('SELECT id FROM leads WHERE email = $1::citext', [e1])).rows[0]!.id;
    const pe = `evt-${tag}`;
    await settle(Array.from({ length: N }, () => db.query(insertEvent, [pe, 'delivered', leadId, null, null, new Date().toISOString(), '{}'])));
    const c3 = (await db.query('SELECT count(*)::int AS n FROM events WHERE provider_event_id = $1', [pe])).rows[0]!.n;
    cases.push({ id: 'provider event replayed x20', passed: c3 === 1, expected: { rows: 1 }, actual: { rows: c3 } });

    // 4. The same approved lead scheduled N times at once.
    await db.query("UPDATE leads SET status = 'approved' WHERE id = $1", [leadId]);
    await db.query("INSERT INTO drafts (lead_id, step, variant, revision, subject, body, status) VALUES ($1, 1, 'A', 0, 's', 'b', 'approved')", [leadId]);
    const plan = JSON.stringify([{ step: 1, at: new Date(Date.now() + 3600_000).toISOString() }]);
    await settle(Array.from({ length: N }, () => db.query(createSends, [leadId, 'sandbox', plan])));
    const dupes = await countDuplicateSends(db);
    const c4 = (await db.query('SELECT count(*)::int AS n FROM sends WHERE lead_id = $1', [leadId])).rows[0]!.n;
    cases.push({ id: 'sends scheduled x20', passed: dupes === 0 && c4 === 1, expected: { sends: 1, duplicate_pairs: 0 }, actual: { sends: c4, duplicate_pairs: dupes } });
  } finally {
    await db.query("DELETE FROM events WHERE provider_event_id LIKE $1", [`evt-${tag}`]);
    await db.query("DELETE FROM leads WHERE email::text LIKE $1", [`%-${tag}@eval.example`]);
    await db.query('DELETE FROM campaigns WHERE name = $1', [CAMPAIGN]);
  }
  const ok = cases.filter((c) => c.passed).length;
  const part: PartResult = {
    name: 'concurrency', scope: SCOPE, status: 'run',
    metrics: [
      { name: 'concurrent duplicate scenarios handled', value: ok, display: fraction(ok, cases.length), target: 'must be 100%', met: ok === cases.length },
    ],
    cases,
  };
  return { suite: 'dedup', parts: [part] };
}
