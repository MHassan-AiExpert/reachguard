import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inProcessApi, repoRoot } from '../lib/inprocess.js';
import type { Ctx, Db, LlmCaller } from '../lib/types.js';
import { runCostLatency } from '../suites/cost_latency.js';
import { countDuplicateSends, runDedup } from '../suites/dedup.js';
import { runFailure } from '../suites/failure.js';
import { runGrounding } from '../suites/grounding.js';
import { ruleVerdict, runHygiene } from '../suites/hygiene.js';
import { runInjection } from '../suites/injection.js';
import { runReplies } from '../suites/replies.js';

const read = (rel: string) => JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
const noLlm: LlmCaller = async () => ({ ok: false, reason: 'no llm in this test' });

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    api: inProcessApi(), db: null, root: repoRoot, mode: 'sandbox', llm: noLlm,
    llmStatus: { available: false, reason: 'no llm in this test' }, ...over,
  };
}
const withLlm = (llm: LlmCaller): Partial<Ctx> => ({ llm, llmStatus: { available: true, model: 'fake-model' } });
const part = (r: { parts: { name: string }[] }, name: string) => r.parts.find((p) => p.name === name) as any;
const metric = (p: any, name: string) => p.metrics.find((m: any) => m.name === name);

describe('hygiene rules', () => {
  const base = { suppressed: false, flags: [] as string[], region_rule: null as string | null, has_mx: true };
  it.each([
    [{ ...base, suppressed: true, flags: ['disposable'] }, { status: 'suppressed', reason: 'suppression_list' }],
    [{ ...base, flags: ['disposable'] }, { status: 'rejected', reason: 'disposable' }],
    [{ ...base, flags: ['role'] }, { status: 'rejected', reason: 'role_based' }],
    [{ ...base, flags: ['free_provider'] }, { status: 'rejected', reason: 'free_provider' }],
    [{ ...base, region_rule: 'blocked' }, { status: 'rejected', reason: 'region_blocked' }],
    [{ ...base, region_rule: 'restricted' }, { status: 'needs_review', reason: 'region_restricted' }],
    [{ ...base, has_mx: false }, { status: 'rejected', reason: 'no_mx' }],
    [{ ...base, region_rule: 'allow_with_note' }, null],
    [base, null],
  ])('applies the checks in the order WF-02 does (%j)', (input, expected) => {
    expect(ruleVerdict(input)).toEqual(expected);
  });

  it('measures recall and false blocks over the real seed data using the real rg-tools code', async () => {
    const leads = read('sandbox/leads.seed.json') as { email: string; expected: { group: string } }[];
    const supp = read('sandbox/suppression.seed.json') as { kind: string; value: string }[];
    const { createHash } = await import('node:crypto');
    const db: Db = {
      async query(text, params) {
        const arg = String(params?.[0] ?? '');
        if (/is_suppressed/.test(text)) {
          const e = arg.trim().toLowerCase();
          const hit = supp.some((s) => (s.kind === 'email' && s.value === e) || (s.kind === 'domain' && s.value === e.split('@')[1]) || (s.kind === 'email_hash' && s.value === createHash('sha256').update(e).digest('hex')));
          return { rows: [{ s: hit }] };
        }
        if (/region_rules/.test(text)) return { rows: [{ DE: { rule: 'blocked' }, CA: { rule: 'restricted' }, GB: { rule: 'allow_with_note' } }[arg.toUpperCase()] ?? null].filter(Boolean) as any };
        return { rows: [] };
      },
    };
    const r = await runHygiene(ctx({ db }));
    const rules = part(r, 'rules');
    expect(rules.status).toBe('run');
    expect(metric(rules, 'planted bad leads caught with the right reason').value).toBe(23);
    expect(metric(rules, 'clean leads blocked by the rules').value).toBe(0);
    expect(rules.cases).toHaveLength(54); // 60 leads minus the 6 exact duplicates, which share an address with an earlier lead
    expect(leads.length).toBe(60);
  });

  it('does not run the end-to-end pipeline part and says what it needs', async () => {
    const r = await runHygiene(ctx());
    expect(part(r, 'pipeline').status).toBe('not_run');
    expect(part(r, 'pipeline').reason).toMatch(/n8n/);
    expect(part(r, 'rules').status).toBe('not_run');
    expect(part(r, 'rules').reason).toMatch(/database/i);
  });
});

describe('replies', () => {
  it('measures the unsubscribe keyword rule on the 40 labeled replies with the real rule code', async () => {
    const r = await runReplies(ctx());
    const p = part(r, 'unsubscribe_rules');
    expect(p.status).toBe('run');
    expect(p.cases).toHaveLength(40);
    expect(p.cases.find((c: any) => c.id === 'reply-23').actual.rule_hit).toBe(true); // "stop"
    expect(p.cases.find((c: any) => c.id === 'reply-01').actual.rule_hit).toBe(false); // an interested reply
    expect(metric(p, 'false hits on replies with no unsubscribe intent').value).toBe(0);
  });

  it('does not run the classifier part when the gateway is unavailable and prints no numbers', async () => {
    const p = part(await runReplies(ctx()), 'classifier');
    expect(p.status).toBe('not_run');
    expect(p.reason).toContain('no llm in this test');
    expect(p.metrics).toEqual([]);
  });

  it('scores a classifier that echoes the labels at 100% and combines the rule with the model for unsubscribe recall', async () => {
    const labels = new Map((read('sandbox/replies.labeled.json') as any[]).map((r) => [r.body, r]));
    const echo: LlmCaller = async (_a, v) => {
      const l = labels.get(String(v.reply_body))!;
      return { ok: true, output: { classification: l.expected_classification, confidence: 0.95, summary: 's', unsubscribe_intent: l.unsubscribe_intent, next_action: 'ignore' } };
    };
    const p = part(await runReplies(ctx(withLlm(echo))), 'classifier');
    expect(p.status).toBe('run');
    expect(metric(p, 'accuracy').value).toBe(40);
    expect(metric(p, 'unsubscribe intent recall (rule or model)').value).toBe(5);
    expect(metric(p, 'unsubscribe intent recall (rule or model)').met).toBe(true);
  });

  it('fails the unsubscribe-recall target when the model misses a reply the rule also misses', async () => {
    const dumb: LlmCaller = async () => ({ ok: true, output: { classification: 'other', confidence: 0.9, summary: 's', unsubscribe_intent: false, next_action: 'ignore' } });
    const p = part(await runReplies(ctx(withLlm(dumb))), 'classifier');
    const rule = metric(part(await runReplies(ctx()), 'unsubscribe_rules'), 'unsubscribe intent replies hit by the rule').value;
    expect(metric(p, 'unsubscribe intent recall (rule or model)').value).toBe(rule);
    expect(metric(p, 'unsubscribe intent recall (rule or model)').met).toBe(rule === 5);
    expect(metric(p, 'accuracy').value).toBe(3); // only the three "other" replies are right
  });
});

describe('grounding', () => {
  it('has the 30 planted drafts with the planned category mix', () => {
    const cases = read('eval/cases/grounding.json') as { id: string; category: string }[];
    const count = (c: string) => cases.filter((x) => x.category === c).length;
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((c) => c.id)).size).toBe(30);
    expect([count('hallucinated_foreign_id'), count('hallucinated_unsupported'), count('hidden_claim'), count('exaggeration'), count('spam_wording'), count('deceptive_subject'), count('over_length'), count('clean')])
      .toEqual([2, 3, 5, 4, 4, 3, 3, 6]);
  });

  it('precheck catches every deterministic category and passes the clean controls', async () => {
    const p = part(await runGrounding(ctx()), 'precheck');
    expect(p.status).toBe('run');
    expect(metric(p, 'precheck-detectable bad drafts caught').value).toBe(12);
    expect(metric(p, 'clean drafts failed by the precheck').value).toBe(0);
  });

  it('does not run the judge part without an LLM and prints no numbers', async () => {
    const p = part(await runGrounding(ctx()), 'judge');
    expect(p.status).toBe('not_run');
    expect(p.metrics).toEqual([]);
  });

  it('lets the code layer override a lenient judge: a judge that passes everything still cannot pass precheck failures', async () => {
    const lenient: LlmCaller = async (_a, v) => {
      const drafts = JSON.parse(String(v.drafts_json)) as { step: number; claims: unknown[] }[];
      const claim_checks = drafts.flatMap((d) => d.claims.map((_, i) => ({ step: d.step, claim_index: i, supported: true, reason: 'ok' })));
      return { ok: true, output: { verdict: 'pass', claim_checks, issues: [], spam_risk: 0.1, confidence: 0.9 } };
    };
    const p = part(await runGrounding(ctx(withLlm(lenient))), 'judge');
    expect(p.status).toBe('run');
    expect(metric(p, 'bad drafts caught (judge plus code checks)').value).toBe(12);
    expect(metric(p, 'clean drafts failed').value).toBe(0);
  });
});

describe('injection', () => {
  it('does not run without an LLM', async () => {
    expect(part(await runInjection(ctx()), 'resistance').status).toBe('not_run');
  });

  const researchOut = (extra = '') => ({ facts: [], evidence_sufficiency: 'thin', injection_detected: true, company: { summary: `A company. ${extra}` } });
  const copyOut = (body: string) => ({ variant_label: 'v', sequence: [{ step: 1, subject: 'Hi', body, claims: [] }] });

  it('scores 3 of 3 when no planted string reaches the research or the draft', async () => {
    const safe: LlmCaller = async (agent) => ({ ok: true, output: agent === 'research-extractor' ? researchOut() : copyOut('Hello there. Would a short chat help?') });
    const p = part(await runInjection(ctx(withLlm(safe))), 'resistance');
    expect(metric(p, 'leads with no planted string in the output').value).toBe(3);
    expect(metric(p, 'leads with no planted string in the output').met).toBe(true);
  });

  it('scores 0 of 3 when the model repeats the planted text into the draft', async () => {
    const leads = read('sandbox/leads.seed.json') as any[];
    const planted = leads.filter((l) => l.expected.group === 'injection_site').flatMap((l) => l.expected.planted_strings as string[]);
    const bad: LlmCaller = async (agent) => ({ ok: true, output: agent === 'research-extractor' ? researchOut() : copyOut(planted.join(' ') + ' Would a chat help?') });
    const p = part(await runInjection(ctx(withLlm(bad))), 'resistance');
    expect(metric(p, 'leads with no planted string in the output').value).toBe(0);
    expect(metric(p, 'leads with no planted string in the output').met).toBe(false);
  });
});

describe('dedup, failure and cost_latency need a database', () => {
  it('countDuplicateSends counts lead-step pairs with more than one send, from DB rows', async () => {
    const seen: string[] = [];
    const db: Db = { async query(text) { seen.push(text); return { rows: [{ n: 2 }] }; } };
    expect(await countDuplicateSends(db)).toBe(2);
    expect(seen[0]).toMatch(/FROM sends/i);
    expect(seen[0]).toMatch(/GROUP BY lead_id, step/i);
    expect(seen[0]).toMatch(/HAVING count\(\*\) > 1/i);
  });

  it('dedup and failure do not run without a database, or outside sandbox mode, and print no numbers', async () => {
    for (const run of [runDedup, runFailure]) {
      const none = await run(ctx());
      expect(none.parts.every((p) => p.status === 'not_run' || p.name === 'stack_faults')).toBe(true);
      expect(none.parts.flatMap((p) => p.metrics)).toEqual([]);
      const live = await run(ctx({ db: { async query() { return { rows: [] }; } }, mode: 'live' }));
      expect(live.parts.find((p) => p.name !== 'stack_faults')!.reason).toMatch(/sandbox/);
    }
  });

  it('cost_latency does not run when no LLM calls were recorded', async () => {
    const db: Db = { async query(text) { return { rows: /count\(\*\)/i.test(text) ? [{ n: 0 }] : [] }; } };
    const p = part(await runCostLatency(ctx({ db })), 'aggregate');
    expect(p.status).toBe('not_run');
    expect(p.reason).toMatch(/no LLM calls/i);
  });

  it('cost_latency reports cost per processed lead and per-stage latency from recorded rows', async () => {
    const db: Db = {
      async query(text) {
        if (/count\(\*\)::int AS n FROM llm_calls/i.test(text)) return { rows: [{ n: 8 }] };
        if (/AS cost_usd/i.test(text)) return { rows: [{ cost_usd: '0.0400', leads: 4 }] };
        if (/FROM llm_calls/i.test(text)) return { rows: [{ agent: 'research-extractor', calls: 4, avg_ms: 900, p95_ms: 1400 }] };
        if (/FROM runs/i.test(text)) return { rows: [{ workflow: 'WF-03 Research Agent', runs: 4, avg_ms: 3000, p95_ms: 5000 }] };
        return { rows: [] };
      },
    };
    const p = part(await runCostLatency(ctx({ db })), 'aggregate');
    expect(p.status).toBe('run');
    expect(metric(p, 'LLM cost per processed lead').display).toContain('$0.0100');
    expect(p.metrics.some((m: any) => m.name.includes('WF-03'))).toBe(true);
  });
});
