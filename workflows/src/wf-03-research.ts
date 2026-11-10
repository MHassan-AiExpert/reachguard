import { code, http, ifNode, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-03 Research Agent';
const SAVE = 'Insert evidence';

export function buildWf03(): N8nWorkflow {
  return stageSkeleton({
    name: NAME,
    inputStatus: 'verified',
    batch: 5,
    llmGated: true,
    perLead: (f: Flow) => {
      f.add(
        code(
          'Init state',
          `const lead = $json;
return [{ json: { lead, flags: [...(lead.flags || [])], facts: [], dropped: 0, injection: false, company: null, pages: [], decision: null } }];`,
        ),
      );
      // 1. resolve the website: the lead's own, else the company domain (H6 never stores a free-provider domain)
      f.add(
        postgres(
          'Resolve site',
          'SELECT domain, name_clean FROM companies WHERE id = $1::uuid',
          '[$json.lead.company_id]',
        ),
      ).alwaysOutputData = true;
      f.add(
        stateCode(
          'Site evaluate',
          'Init state',
          `s.site = String(s.lead.website || r.domain || '');
s.company_name = r.name_clean || s.lead.company_clean || s.lead.company_raw;
s.company_domain = String(r.domain || '');
if (!s.site) { s.decision = { to: 'needs_review', reason: 'no_evidence' }; }`,
        ),
      );
      f.chain('Init state', 'Resolve site', 'Site evaluate');
      // 2. fetch pages
      f.add(http('Fetch pages', '/v1/research/fetch', '{ website: $json.site }'));
      f.add(
        stateCode(
          'Pages evaluate',
          'Site evaluate',
          `s.pages = Array.isArray(r.pages) ? r.pages : [];
if (s.pages.length === 0) { s.decision = { to: 'needs_review', reason: 'no_evidence' }; }`,
        ),
      );
      // 3. extract with the LLM (untrusted page text is wrapped by the gateway prompt)
      f.add(
        http(
          'Extract facts',
          '/v1/llm/run',
          '{ agent: "research-extractor", lead_id: $json.lead.id, variables: { company_clean: $json.company_name, company_domain: $json.company_domain, today: new Date().toISOString().slice(0, 10), pages: $json.pages } }',
        ),
      );
      // 4. drop every fact whose snippet is not verbatim in the fetched text
      f.add(
        http(
          'Ground facts',
          '/v1/research/ground',
          '{ facts: $json.output.facts, pages: $("Pages evaluate").first().json.pages }',
        ),
      );
      f.add(
        stateCode(
          'Grounding evaluate',
          'Pages evaluate',
          `const out = $('Extract facts').first().json.output;
s.facts = r.kept || [];
s.dropped = r.dropped_count || 0;
s.injection = out.injection_detected === true;
s.company = out.company || null;
if (s.injection && !s.flags.includes('injection_detected')) s.flags.push('injection_detected');
const n = s.facts.length;
s.sufficiency = n === 0 ? 'none' : n < 3 ? 'thin' : n < 5 ? 'adequate' : 'rich';
if (s.sufficiency === 'none') { s.decision = { to: 'needs_review', reason: 'no_evidence' }; }
else {
  if (s.sufficiency === 'thin' && !s.flags.includes('thin_evidence')) s.flags.push('thin_evidence');
  s.decision = { to: 'researched', reason: 'evidence ' + s.sufficiency + (s.dropped ? ' (' + s.dropped + ' ungrounded facts dropped)' : '') };
}`,
        ),
      );
      f.add(ifNode('Has site?', '!$json.decision'));
      f.add(ifNode('Has pages?', '!$json.decision'));
      // 5/6/7. one statement: evidence rows, company enrichment, injection log, flags, then the transition
      f.add(
        postgres(
          SAVE,
          `WITH upd AS (
  UPDATE leads SET flags = ARRAY(SELECT jsonb_array_elements_text($4::jsonb)) WHERE id = $1::uuid RETURNING id, company_id),
ev AS (
  INSERT INTO research_evidence (lead_id, company_id, fact_type, claim, source_url, snippet, confidence, content_hash)
  SELECT $1::uuid, (SELECT company_id FROM upd), x.fact_type, x.claim, x.source_url, x.snippet, x.confidence,
         encode(digest(x.snippet, 'sha256'), 'hex')
    FROM jsonb_to_recordset($5::jsonb) AS x(fact_type text, claim text, source_url text, snippet text, confidence numeric)
  RETURNING 1),
co AS (
  UPDATE companies c
     SET industry = COALESCE(NULLIF($6::jsonb->>'industry', ''), c.industry),
         employee_range = COALESCE(NULLIF($6::jsonb->>'employee_range', ''), c.employee_range)
   WHERE c.id = (SELECT company_id FROM upd) AND $6::jsonb IS NOT NULL
  RETURNING 1),
inj AS (
  INSERT INTO verification_results (lead_id, check_name, outcome, provider, detail)
  SELECT $1::uuid, 'injection_scan', 'warn', 'llm', jsonb_build_object('dropped_facts', $7::int)
   WHERE $8::boolean
  RETURNING 1)
SELECT transition_lead(upd.id, 'verified'::lead_status, $2::lead_status, $3, 'WF-03') AS transitioned,
       (SELECT count(*) FROM ev) AS facts_written
  FROM upd`,
          '[$json.lead.id, $json.decision.to, $json.decision.reason, JSON.stringify($json.flags), JSON.stringify($json.facts), JSON.stringify($json.company ?? {}), $json.dropped, $json.injection]',
        ),
      );
      f.connect('Site evaluate', 'Has site?');
      f.connect('Has site?', 'Fetch pages', 0);
      f.connect('Has site?', SAVE, 1);
      f.connect('Fetch pages', 'Pages evaluate');
      f.connect('Pages evaluate', 'Has pages?');
      f.connect('Has pages?', 'Extract facts', 0);
      f.connect('Has pages?', SAVE, 1);
      f.chain('Extract facts', 'Ground facts', 'Grounding evaluate', SAVE);
      return { entry: 'Init state', exits: [SAVE] };
    },
  });
}
