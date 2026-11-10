import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-05 Copywriter Agent';
const SAVE = 'Insert drafts';

export function buildWf05(): N8nWorkflow {
  const d = loadDefaults();
  const avoid = JSON.stringify(d.qa.banned_phrases.join(', '));
  const llmBody = (issues: string): string =>
    `{ agent: "copywriter", lead_id: $json.lead.id, variables: { sender_name: $json.offer.sender_name ?? "", sender_role: $json.offer.sender_role ?? "", offer_json: JSON.stringify($json.offer), variant_style: $json.variant, avoid_list: ${avoid}, steps: $json.steps, revision_issues: JSON.stringify(${issues}), first_name: $json.lead.first_name ?? "", title: $json.lead.title ?? "", company_clean: $json.lead.company_clean ?? $json.lead.company_raw, evidence: $json.evidence } }`;

  return stageSkeleton({
    name: NAME,
    inputStatus: 'scored',
    batch: 3,
    llmGated: true,
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json, flags: [...($json.flags || [])], regenerated: false, decision: null } }];`));
      f.add(
        postgres(
          'Load context',
          `SELECT c.offer, c.sequence,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'fact_type', e.fact_type, 'claim', e.claim, 'snippet', e.snippet)
                              ORDER BY e.confidence DESC)
              FROM research_evidence e WHERE e.lead_id = $2::uuid), '[]'::jsonb) AS evidence,
  (SELECT max(revision) FROM drafts WHERE lead_id = $2::uuid) AS last_revision,
  (SELECT variant FROM drafts WHERE lead_id = $2::uuid ORDER BY revision DESC, created_at DESC LIMIT 1) AS last_variant,
  COALESCE((SELECT jsonb_agg(issue)
              FROM drafts dr, jsonb_array_elements(COALESCE(dr.qa_report->'issues', '[]'::jsonb)) AS issue
             WHERE dr.lead_id = $2::uuid AND dr.status = 'qa_revise'
               AND dr.revision = (SELECT max(revision) FROM drafts WHERE lead_id = $2::uuid)), '[]'::jsonb) AS revision_issues,
  (SELECT count(DISTINCT dr.lead_id) FROM drafts dr JOIN leads l ON l.id = dr.lead_id WHERE l.campaign_id = $1::uuid) AS campaign_draft_leads
FROM campaigns c WHERE c.id = $1::uuid`,
          '[$json.lead.campaign_id, $json.lead.id]',
        ),
      );
      f.add(
        stateCode(
          'Context ready',
          'Init state',
          `const offer = r.offer || {};
const styles = Array.isArray(offer.variant_styles) && offer.variant_styles.length ? offer.variant_styles : ['direct'];
s.offer = offer;
s.evidence = r.evidence || [];
s.steps = Array.isArray(r.sequence) && r.sequence.length ? r.sequence.length : 3;
s.revision = r.last_revision === null || r.last_revision === undefined ? 0 : Number(r.last_revision) + 1;
s.variant = s.revision > 0 && r.last_variant ? r.last_variant : styles[Number(r.campaign_draft_leads) % styles.length];
s.revision_issues = r.revision_issues || [];
if (s.evidence.length === 0) { s.decision = { to: 'needs_review', reason: 'no_evidence' }; }`,
        ),
      );
      f.add(ifNode('Has evidence?', '!$json.decision'));
      f.add(http('Write copy', '/v1/llm/run', llmBody('$json.revision_issues')));
      f.add(stateCode('Copy ready', 'Context ready', `s.copy = r.output;`));
      f.add(code('Precheck input', `return [{ json: $json }];`));
      f.add(
        http(
          'Precheck',
          '/v1/copy/precheck',
          '{ lead_id: $json.lead.id, copy: $json.copy, evidence_ids: $json.evidence.map((e) => e.id) }',
        ),
      );
      f.add(
        http(
          'Similarity',
          '/v1/similarity',
          '{ campaign_id: $("Precheck input").first().json.lead.campaign_id, exclude_lead_id: $("Precheck input").first().json.lead.id, shingle_hashes: $("Precheck").first().json.shingle_hashes ?? [] }',
        ),
      );
      f.add(
        stateCode(
          'Check evaluate',
          'Precheck input',
          `const pre = $('Precheck').first().json;
s.violations = pre.violations || [];
s.similar = r.exceeds_threshold === true;
s.shingle_hashes = pre.shingle_hashes || [];
const bad = pre.ok !== true || s.similar;
s.needs_regen = bad && !s.regenerated;
if (s.needs_regen) {
  s.revision_issues = [
    ...s.violations.map((v) => ({ step: 1, type: 'other', severity: 'high', detail: String(v).slice(0, 300), fix: 'Fix: ' + String(v).slice(0, 280) })),
    ...(s.similar ? [{ step: 1, type: 'other', severity: 'high', detail: 'Too similar to recent drafts in this campaign', fix: 'Use a different opening, angle and wording' }] : []),
  ];
} else if (bad) {
  s.decision = { to: 'needs_review', reason: s.similar && s.violations.length === 0 ? 'copy_too_similar' : 'copy_precheck_failed' };
} else {
  s.decision = { to: 'drafted', reason: 'revision ' + s.revision + ' variant ' + s.variant };
}`,
        ),
      );
      f.add(ifNode('Needs regeneration?', '$json.needs_regen === true'));
      f.add(http('Regenerate', '/v1/llm/run', llmBody('$json.revision_issues')));
      f.add(stateCode('Copy regenerated', 'Check evaluate', `s.copy = r.output; s.regenerated = true; s.needs_regen = false;`));
      f.add(
        postgres(
          SAVE,
          `WITH ins AS (
  INSERT INTO drafts (lead_id, step, variant, revision, subject, body, claims, evidence_ids, status, word_count, shingle_hashes)
  SELECT $1::uuid, x.step, $4, $5::int, x.subject, x.body, x.claims,
         ARRAY(SELECT jsonb_array_elements_text(x.evidence_ids))::uuid[], 'generated', x.word_count,
         CASE WHEN x.step = 1 THEN ARRAY(SELECT jsonb_array_elements_text($7::jsonb))::bigint[] ELSE '{}'::bigint[] END
    FROM jsonb_to_recordset($6::jsonb) AS x(step int, subject text, body text, claims jsonb, evidence_ids jsonb, word_count int)
   WHERE $2::text = 'drafted'
  RETURNING 1)
SELECT transition_lead($1::uuid, 'scored'::lead_status, $2::lead_status, $3, 'WF-05') AS transitioned,
       (SELECT count(*) FROM ins) AS drafts_written`,
          `[$json.lead.id, $json.decision.to, $json.decision.reason, $json.variant ?? "", $json.revision ?? 0, JSON.stringify(($json.copy?.sequence ?? []).map((x) => ({ step: x.step, subject: x.subject ?? null, body: x.body, claims: x.claims, evidence_ids: [...new Set(x.claims.map((c) => c.evidence_id))], word_count: x.body.trim().split(/\\s+/).length }))), JSON.stringify($json.shingle_hashes ?? [])]`,
        ),
      );

      f.chain('Init state', 'Load context', 'Context ready', 'Has evidence?');
      f.connect('Has evidence?', 'Write copy', 0);
      f.connect('Has evidence?', SAVE, 1);
      f.chain('Write copy', 'Copy ready', 'Precheck input', 'Precheck', 'Similarity', 'Check evaluate', 'Needs regeneration?');
      f.connect('Needs regeneration?', 'Regenerate', 0);
      f.connect('Needs regeneration?', SAVE, 1);
      f.chain('Regenerate', 'Copy regenerated', 'Precheck input');
      return { entry: 'Init state', exits: [SAVE] };
    },
  });
}
