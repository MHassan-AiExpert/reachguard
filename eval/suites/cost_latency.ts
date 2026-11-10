import { notRun, type Ctx, type Metric, type SuiteResult } from '../lib/types.js';

const SCOPE = 'Cost and latency read back from llm_calls and runs rows written by whatever run filled the database. It measures nothing itself.';

export async function runCostLatency(ctx: Ctx): Promise<SuiteResult> {
  if (!ctx.db) return { suite: 'cost_latency', parts: [notRun('aggregate', SCOPE, 'needs a database (set DATABASE_URL)')] };
  const db = ctx.db;
  const n = (await db.query("SELECT count(*)::int AS n FROM llm_calls WHERE status IN ('ok','schema_invalid')")).rows[0]?.n ?? 0;
  if (n === 0) return { suite: 'cost_latency', parts: [notRun('aggregate', SCOPE, 'no LLM calls recorded in this database, so there is no cost or latency to report')] };
  const tot = (await db.query("SELECT COALESCE(sum(cost_usd), 0) AS cost_usd, count(DISTINCT lead_id)::int AS leads FROM llm_calls WHERE lead_id IS NOT NULL")).rows[0]!;
  const cost = Number(tot.cost_usd);
  const metrics: Metric[] = [
    { name: 'LLM calls recorded', value: n, display: String(n) },
    { name: 'LLM cost per processed lead', value: tot.leads ? cost / tot.leads : 0, display: tot.leads ? `$${(cost / tot.leads).toFixed(4)} (${tot.leads} leads, $${cost.toFixed(4)} total)` : 'n/a (no call tied to a lead)' },
  ];
  const agents = await db.query("SELECT agent, count(*)::int AS calls, round(avg(latency_ms))::int AS avg_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_ms FROM llm_calls WHERE latency_ms IS NOT NULL GROUP BY agent ORDER BY agent");
  for (const a of agents.rows) metrics.push({ name: `${a.agent} LLM latency (avg / p95, ${a.calls} calls)`, value: a.avg_ms, display: `${a.avg_ms} ms / ${a.p95_ms} ms` });
  const wfs = await db.query("SELECT workflow, count(*)::int AS runs, round(avg(latency_ms))::int AS avg_ms, round(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms))::int AS p95_ms FROM runs WHERE latency_ms IS NOT NULL GROUP BY workflow ORDER BY workflow");
  for (const w of wfs.rows) metrics.push({ name: `${w.workflow} run time (avg / p95, ${w.runs} runs)`, value: w.avg_ms, display: `${w.avg_ms} ms / ${w.p95_ms} ms` });
  return { suite: 'cost_latency', parts: [{ name: 'aggregate', scope: SCOPE, status: 'run', metrics, cases: [] }] };
}
