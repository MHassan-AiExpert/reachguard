import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-06 QA and Compliance Judge';
const d = loadDefaults();

/**
 * The verdict is code, and stricter than the model: a draft passes only if the model said pass AND every claim has
 * a supported claim_check AND no issue is high severity AND spam_risk is within the limit AND the precheck is clean.
 */
export const VERDICT_FN = `function verdict(j, pre, drafts, revision) {
  const issues = [...(j.issues || [])];
  for (const v of (pre.violations || [])) {
    issues.push({ step: 1, type: 'other', severity: 'high', detail: String(v).slice(0, 300), fix: 'Fix: ' + String(v).slice(0, 280) });
  }
  if (!drafts.length) return { to: 'needs_review', reason: 'no_drafts', draft_status: 'qa_reject', issues };
  const checks = j.claim_checks || [];
  let unsupported = checks.some((c) => c.supported === false);
  for (const dr of drafts) {
    (dr.claims || []).forEach((_, i) => {
      const c = checks.find((x) => x.step === dr.step && x.claim_index === i);
      if (!c || c.supported !== true) unsupported = true;
    });
  }
  const high = issues.some((i) => i.severity === 'high');
  const spam = j.spam_risk > ${d.qa.spam_risk_max};
  if (unsupported && !issues.some((i) => i.type === 'ungrounded_claim')) {
    issues.push({ step: 1, type: 'ungrounded_claim', severity: 'high', detail: 'A claim is not supported by the cited evidence', fix: 'Remove or rewrite unsupported claims using only the evidence' });
  }
  if (spam && !issues.some((i) => i.type === 'spam_language')) {
    issues.push({ step: 1, type: 'spam_language', severity: 'high', detail: 'Spam risk above the limit', fix: 'Remove hype, pressure and promotional wording' });
  }
  if (j.verdict === 'pass' && !unsupported && !high && !spam && pre.ok === true) {
    return { to: 'qa_passed', reason: 'passed qa', draft_status: 'qa_pass', issues };
  }
  if (j.verdict === 'reject') return { to: 'needs_review', reason: 'qa_rejected', draft_status: 'qa_reject', issues };
  if (revision < ${d.qa.max_revisions}) return { to: 'scored', reason: 'qa_revise', draft_status: 'qa_revise', issues };
  return { to: 'needs_review', reason: 'qa_exhausted', draft_status: 'qa_reject', issues };
}`;

export function buildWf06(): N8nWorkflow {
  const rules = JSON.stringify({
    step1_words: d.qa.step1_words,
    followup_words: d.qa.followup_words,
    subject_max_chars: d.qa.subject_max_chars,
    spam_risk_max: d.qa.spam_risk_max,
  });
  return stageSkeleton({
    name: NAME,
    inputStatus: 'drafted',
    batch: 3,
    llmGated: true,
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json, flags: [...($json.flags || [])], decision: null } }];`));
      f.add(
        postgres(
          'Load drafts',
          `WITH r AS (SELECT max(revision) AS rev FROM drafts WHERE lead_id = $1::uuid)
SELECT (SELECT rev FROM r) AS revision,
  (SELECT min(variant) FROM drafts WHERE lead_id = $1::uuid AND revision = (SELECT rev FROM r)) AS variant,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('step', dr.step, 'subject', dr.subject, 'body', dr.body, 'claims', dr.claims) ORDER BY dr.step)
              FROM drafts dr WHERE dr.lead_id = $1::uuid AND dr.revision = (SELECT rev FROM r)), '[]'::jsonb) AS drafts,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'claim', e.claim, 'snippet', e.snippet))
              FROM research_evidence e WHERE e.lead_id = $1::uuid), '[]'::jsonb) AS evidence`,
          '[$json.lead.id]',
        ),
      );
      f.add(
        stateCode(
          'Draft copy',
          'Init state',
          `s.revision = Number(r.revision ?? 0);
s.evidence = r.evidence || [];
s.copy = { variant_label: r.variant || 'draft', sequence: r.drafts || [] };
if (s.copy.sequence.length === 0) { s.decision = { to: 'needs_review', reason: 'no_drafts' }; s.draft_status = 'qa_reject'; s.report = {}; }`,
        ),
      );
      f.add(ifNode('Has drafts?', '!$json.decision'));
      f.add(
        http(
          'Precheck',
          '/v1/copy/precheck',
          '{ lead_id: $json.lead.id, copy: $json.copy, evidence_ids: $json.evidence.map((e) => e.id) }',
        ),
      );
      f.add(
        http(
          'QA judge',
          '/v1/llm/run',
          `{ agent: "qa-judge", lead_id: $("Draft copy").first().json.lead.id, variables: { spam_risk_max: ${d.qa.spam_risk_max}, rules_json: ${JSON.stringify(rules)}, evidence: $("Draft copy").first().json.evidence, drafts_json: JSON.stringify($("Draft copy").first().json.copy.sequence) } }`,
        ),
      );
      f.add(
        stateCode(
          'Verdict',
          'Draft copy',
          `${VERDICT_FN}
const j = r.output;
const pre = $('Precheck').first().json;
const v = verdict(j, pre, s.copy.sequence, s.revision);
s.decision = { to: v.to, reason: v.reason };
s.draft_status = v.draft_status;
s.report = { verdict: j.verdict, confidence: j.confidence, spam_risk: j.spam_risk, claim_checks: j.claim_checks, issues: v.issues, precheck_violations: pre.violations || [], revision: s.revision, final: v.to };
s.spam_risk = j.spam_risk;`,
        ),
      );
      f.add(
        postgres(
          'Store verdict',
          `WITH upd AS (
  UPDATE drafts SET status = $4, qa_report = $5::jsonb, spam_risk = $6::numeric
   WHERE lead_id = $1::uuid AND revision = $7::int
  RETURNING 1)
SELECT transition_lead($1::uuid, 'drafted'::lead_status, $2::lead_status, $3, 'WF-06') AS transitioned,
       (SELECT count(*) FROM upd) AS drafts_updated`,
          '[$json.lead.id, $json.decision.to, $json.decision.reason, $json.draft_status ?? "qa_reject", JSON.stringify($json.report ?? {}), $json.spam_risk ?? null, $json.revision ?? 0]',
        ),
      );
      f.chain('Init state', 'Load drafts', 'Draft copy', 'Has drafts?');
      f.connect('Has drafts?', 'Precheck', 0);
      f.connect('Has drafts?', 'Store verdict', 1);
      f.chain('Precheck', 'QA judge', 'Verdict', 'Store verdict');
      return { entry: 'Init state', exits: ['Store verdict'] };
    },
  });
}
