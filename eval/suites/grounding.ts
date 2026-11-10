import { loadDefaults } from '../../workflows/src/lib/config.js';
import { VERDICT_FN } from '../../workflows/src/wf-06-qa-judge.js';
import { fraction, notRun, type Case, type Ctx, type PartResult, type SuiteResult } from '../lib/types.js';
import { readJson } from '../lib/util.js';

interface Draft {
  id: string;
  category: string;
  detectable_by: 'precheck' | 'judge' | 'none';
  expect_pass: boolean;
  evidence: { id: string; fact_type: string; claim: string; snippet: string }[];
  copy: { sequence: { step: number; claims: unknown[] }[] };
}
interface Pre {
  ok: boolean;
  violations: string[];
}

const verdict = new Function(`${VERDICT_FN}\nreturn verdict;`)() as (j: unknown, pre: Pre, drafts: unknown[], revision: number) => { to: string };
const LEAD = '00000000-0000-4000-8000-000000000001';
const PRE_SCOPE = 'The deterministic /v1/copy/precheck on 30 planted drafts. Faults only the judge can see (unsupported, hidden or exaggerated claims) are out of scope for this part by design.';
const JUDGE_SCOPE = 'The qa-judge agent plus the same code checks WF-06 applies, on the same 30 planted drafts.';

async function precheck(ctx: Ctx, d: Draft): Promise<Pre | string> {
  const res = await ctx.api.post('/v1/copy/precheck', { lead_id: LEAD, copy: d.copy, evidence_ids: d.evidence.map((e) => e.id) });
  if (res.status !== 200) return `rg-tools returned HTTP ${res.status} for ${d.id}`;
  return { ok: res.json.ok === true, violations: res.json.violations ?? [] };
}

export async function runGrounding(ctx: Ctx): Promise<SuiteResult> {
  const drafts = readJson<Draft[]>(ctx.root, 'eval/cases/grounding.json');
  const pre = new Map<string, Pre>();
  for (const d of drafts) {
    const p = await precheck(ctx, d);
    if (typeof p === 'string') return { suite: 'grounding', parts: [notRun('precheck', PRE_SCOPE, p), notRun('judge', JUDGE_SCOPE, p, true)] };
    pre.set(d.id, p);
  }
  const detectable = drafts.filter((d) => d.detectable_by === 'precheck');
  const clean = drafts.filter((d) => d.expect_pass);
  const caught = detectable.filter((d) => !pre.get(d.id)!.ok).length;
  const falseFails = clean.filter((d) => !pre.get(d.id)!.ok).length;
  const precheckPart: PartResult = {
    name: 'precheck', scope: PRE_SCOPE, status: 'run',
    metrics: [
      { name: 'precheck-detectable bad drafts caught', value: caught, display: fraction(caught, detectable.length) },
      { name: 'clean drafts failed by the precheck', value: falseFails, display: fraction(falseFails, clean.length) },
    ],
    // A judge-only fault must pass the precheck, otherwise the case would be testing the wrong layer.
    cases: drafts.map((d) => {
      const ok = pre.get(d.id)!.ok;
      const wantOk = d.detectable_by !== 'precheck';
      return { id: d.id, passed: ok === wantOk, expected: { category: d.category, precheck_ok: wantOk }, actual: { precheck_ok: ok, violations: pre.get(d.id)!.violations } };
    }),
  };

  if (!ctx.llmStatus.available) return { suite: 'grounding', parts: [precheckPart, notRun('judge', JUDGE_SCOPE, ctx.llmStatus.reason ?? 'LLM gateway unavailable', true)] };

  const qa = loadDefaults().qa;
  const rules = JSON.stringify({ step1_words: qa.step1_words, followup_words: qa.followup_words, subject_max_chars: qa.subject_max_chars, spam_risk_max: qa.spam_risk_max });
  const cases: Case[] = [];
  for (const d of drafts) {
    const o = await ctx.llm('qa-judge', {
      spam_risk_max: qa.spam_risk_max, rules_json: rules,
      evidence: d.evidence.map((e) => ({ id: e.id, claim: e.claim, snippet: e.snippet })),
      drafts_json: JSON.stringify(d.copy.sequence),
    });
    const final = o.ok ? verdict(o.output, pre.get(d.id)!, d.copy.sequence, 0).to : 'error';
    const passedQa = final === 'qa_passed';
    cases.push({ id: d.id, passed: passedQa === d.expect_pass, expected: { category: d.category, qa_passed: d.expect_pass }, actual: o.ok ? { final, judge: o.output.verdict } : { error: o.reason } });
  }
  const bad = drafts.filter((d) => !d.expect_pass);
  const badCaught = bad.filter((d) => cases.find((c) => c.id === d.id)!.passed).length;
  const cleanFailed = clean.filter((d) => !cases.find((c) => c.id === d.id)!.passed).length;
  const judgePart: PartResult = {
    name: 'judge', scope: JUDGE_SCOPE, status: 'run', usesLlm: true,
    metrics: [
      { name: 'bad drafts caught (judge plus code checks)', value: badCaught, display: fraction(badCaught, bad.length) },
      { name: 'clean drafts failed', value: cleanFailed, display: fraction(cleanFailed, clean.length) },
    ],
    cases,
  };
  return { suite: 'grounding', parts: [precheckPart, judgePart] };
}
