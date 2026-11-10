import { code, http, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-04 ICP Scoring Agent';

export function buildWf04(): N8nWorkflow {
  return stageSkeleton({
    name: NAME,
    inputStatus: 'researched',
    batch: 5,
    llmGated: true,
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json, flags: [...($json.flags || [])] } }];`));
      f.add(
        postgres(
          'Load inputs',
          `SELECT
  (SELECT icp FROM campaigns WHERE id = $1::uuid) AS icp,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'fact_type', e.fact_type, 'claim', e.claim, 'snippet', e.snippet)
                              ORDER BY e.confidence DESC)
              FROM research_evidence e WHERE e.lead_id = $2::uuid), '[]'::jsonb) AS evidence`,
          '[$json.lead.campaign_id, $json.lead.id]',
        ),
      );
      f.add(stateCode('Inputs ready', 'Init state', `s.icp = r.icp || {}; s.evidence = r.evidence || [];`));
      f.add(
        http(
          'Score ICP',
          '/v1/llm/run',
          '{ agent: "icp-scorer", lead_id: $json.lead.id, variables: { icp_json: JSON.stringify($json.icp), title: $json.lead.title ?? "", company_clean: $json.lead.company_clean ?? $json.lead.company_raw, country: $json.lead.country ?? "", evidence: $json.evidence } }',
        ),
      );
      f.add(
        http(
          'Compute tier',
          '/v1/score/tier',
          '{ dimensions: $json.output.dimensions, flags: $("Init state").first().json.flags }',
        ),
      );
      f.add(
        stateCode(
          'Decide',
          'Inputs ready',
          `s.dimensions = $('Score ICP').first().json.output.dimensions;
s.score = r.score;
s.tier = r.tier;
s.decision = r.tier === 'C'
  ? { to: 'rejected', reason: 'low_fit' }
  : { to: 'scored', reason: 'tier ' + r.tier + ' score ' + r.score };`,
        ),
      );
      f.add(
        postgres(
          'Store score',
          `WITH upd AS (
  UPDATE leads SET score = $4::numeric, tier = $5, score_breakdown = $6::jsonb
   WHERE id = $1::uuid RETURNING id)
SELECT transition_lead(upd.id, 'researched'::lead_status, $2::lead_status, $3, 'WF-04') AS transitioned FROM upd`,
          '[$json.lead.id, $json.decision.to, $json.decision.reason, $json.score, $json.tier, JSON.stringify({ dimensions: $json.dimensions })]',
        ),
      );
      f.chain('Init state', 'Load inputs', 'Inputs ready', 'Score ICP', 'Compute tier', 'Decide', 'Store score');
      return { entry: 'Init state', exits: ['Store score'] };
    },
  });
}
