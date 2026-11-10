import { ROUTE_REPLY_FN } from '../../workflows/src/wf-09-events.js';
import { fraction, notRun, type Case, type Ctx, type PartResult, type SuiteResult } from '../lib/types.js';
import { readJson } from '../lib/util.js';

interface Reply {
  id: string;
  email: string;
  body: string;
  expected_classification: string;
  unsubscribe_intent: boolean;
}

const routeReply = new Function(`${ROUTE_REPLY_FN}\nreturn routeReply;`)() as (out: Record<string, unknown>, ruleHit: boolean) => { next_action: string };

async function ruleHits(ctx: Ctx, replies: Reply[]): Promise<Map<string, boolean> | string> {
  const hits = new Map<string, boolean>();
  for (const [i, r] of replies.entries()) {
    const res = await ctx.api.post('/v1/events/normalize', {
      provider: 'sandbox',
      payload: { provider_event_id: `eval-reply-${i}`, type: 'reply', email: r.email, body: r.body },
    });
    if (res.status !== 200) return `rg-tools returned HTTP ${res.status} for ${r.id}`;
    hits.set(r.id, res.json.unsubscribe_rule_hit === true);
  }
  return hits;
}

const RULE_SCOPE = 'The keyword rule that suppresses an unsubscribe request before any model sees it, run through the real /v1/events/normalize route on the 40 labeled replies.';
const CLASSIFIER_SCOPE = 'The reply-classifier agent on the 40 labeled replies, with the same code override WF-09 applies (rule hit or model intent suppresses).';

export async function runReplies(ctx: Ctx): Promise<SuiteResult> {
  const replies = readJson<Reply[]>(ctx.root, 'sandbox/replies.labeled.json');
  const hits = await ruleHits(ctx, replies);
  if (typeof hits === 'string') {
    return { suite: 'replies', parts: [notRun('unsubscribe_rules', RULE_SCOPE, hits), notRun('classifier', CLASSIFIER_SCOPE, hits, true)] };
  }
  const intent = replies.filter((r) => r.unsubscribe_intent);
  const others = replies.filter((r) => !r.unsubscribe_intent);
  const hit = intent.filter((r) => hits.get(r.id)).length;
  const falseHits = others.filter((r) => hits.get(r.id)).length;
  const rules: PartResult = {
    name: 'unsubscribe_rules', scope: RULE_SCOPE, status: 'run',
    metrics: [
      { name: 'unsubscribe intent replies hit by the rule', value: hit, display: fraction(hit, intent.length) },
      { name: 'false hits on replies with no unsubscribe intent', value: falseHits, display: fraction(falseHits, others.length) },
    ],
    cases: replies.map((r) => ({ id: r.id, passed: hits.get(r.id) === r.unsubscribe_intent, expected: { unsubscribe_intent: r.unsubscribe_intent }, actual: { rule_hit: hits.get(r.id) } })),
  };

  if (!ctx.llmStatus.available) return { suite: 'replies', parts: [rules, notRun('classifier', CLASSIFIER_SCOPE, ctx.llmStatus.reason ?? 'LLM gateway unavailable', true)] };

  const cases: Case[] = [];
  let correct = 0;
  let suppressed = 0;
  const perClass = new Map<string, { n: number; ok: number }>();
  for (const r of replies) {
    const o = await ctx.llm('reply-classifier', { subject: 'Quick question', reply_body: r.body });
    const out = o.ok ? o.output : null;
    const ok = out?.classification === r.expected_classification;
    const eff = out ? routeReply(out, hits.get(r.id) === true).next_action === 'suppress' : hits.get(r.id) === true;
    if (ok) correct++;
    if (r.unsubscribe_intent && eff) suppressed++;
    const c = perClass.get(r.expected_classification) ?? { n: 0, ok: 0 };
    c.n++;
    if (ok) c.ok++;
    perClass.set(r.expected_classification, c);
    cases.push({ id: r.id, passed: ok && (!r.unsubscribe_intent || eff), expected: { classification: r.expected_classification, unsubscribe_intent: r.unsubscribe_intent }, actual: o.ok ? { classification: out.classification, unsubscribe_intent: out.unsubscribe_intent, confidence: out.confidence, suppress: eff } : { error: o.reason } });
  }
  const classifier: PartResult = {
    name: 'classifier', scope: CLASSIFIER_SCOPE, status: 'run', usesLlm: true,
    metrics: [
      { name: 'accuracy', value: correct, display: fraction(correct, replies.length) },
      ...[...perClass.entries()].sort().map(([k, v]) => ({ name: `recall: ${k}`, value: v.ok, display: fraction(v.ok, v.n) })),
      { name: 'unsubscribe intent recall (rule or model)', value: suppressed, display: fraction(suppressed, intent.length), target: 'must be 100%', met: suppressed === intent.length },
    ],
    cases,
  };
  return { suite: 'replies', parts: [rules, classifier] };
}
