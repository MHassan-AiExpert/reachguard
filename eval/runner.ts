import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildContext } from './lib/context.js';
import { repoRoot } from './lib/inprocess.js';
import type { Ctx, Meta, SuiteResult } from './lib/types.js';
import { renderReport } from './report.js';
import { runCostLatency } from './suites/cost_latency.js';
import { runDedup } from './suites/dedup.js';
import { runFailure } from './suites/failure.js';
import { runGrounding } from './suites/grounding.js';
import { runHygiene } from './suites/hygiene.js';
import { runInjection } from './suites/injection.js';
import { runReplies } from './suites/replies.js';

export const SUITES: Record<string, (ctx: Ctx) => Promise<SuiteResult>> = {
  hygiene: runHygiene, dedup: runDedup, grounding: runGrounding, injection: runInjection,
  replies: runReplies, failure: runFailure, cost_latency: runCostLatency,
};

const gitSha = (): string => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim();
  } catch {
    return 'unknown';
  }
};

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const names = only.length ? only : Object.keys(SUITES);
  const unknown = names.filter((n) => !SUITES[n]);
  if (unknown.length) throw new Error(`unknown suite: ${unknown.join(', ')} (have ${Object.keys(SUITES).join(', ')})`);

  const { ctx, models, close } = await buildContext();
  const results: SuiteResult[] = [];
  // cost_latency reads what the other suites wrote, so it goes last.
  for (const n of [...names.filter((x) => x !== 'cost_latency'), ...names.filter((x) => x === 'cost_latency')]) {
    process.stdout.write(`suite ${n} ... `);
    const r = await SUITES[n]!(ctx);
    results.push(r);
    console.log(r.parts.map((p) => `${p.name}:${p.status}`).join(' '));
  }
  const meta: Meta = {
    date: new Date().toISOString().slice(0, 10),
    git_sha: gitSha(),
    llm_mode: process.env.LLM_MODE ?? 'replay',
    models: [...models],
    target: `rg-tools ${process.env.RG_TOOLS_URL ?? 'http://localhost:8080'} (MODE=${ctx.mode})`,
    db: ctx.db ? 'connected' : 'none',
  };
  const file = path.join(repoRoot, 'docs/EVAL_REPORT.md');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, renderReport(results, meta));
  if (ctx.db) {
    const run = (await ctx.db.query('INSERT INTO eval_runs (git_sha, mode, summary) VALUES ($1, $2, $3::jsonb) RETURNING id', [meta.git_sha, ctx.mode, JSON.stringify({ parts: results.flatMap((r) => r.parts.map((p) => ({ suite: r.suite, part: p.name, status: p.status, reason: p.reason ?? null, metrics: p.metrics }))) })])).rows[0].id;
    for (const r of results) for (const p of r.parts) for (const c of p.cases) {
      await ctx.db.query('INSERT INTO eval_results (run_id, suite, case_id, passed, expected, actual) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)', [run, `${r.suite}/${p.name}`, c.id, c.passed, JSON.stringify(c.expected ?? null), JSON.stringify(c.actual ?? null)]);
    }
  }
  await close();
  console.log(`wrote ${path.relative(repoRoot, file)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
