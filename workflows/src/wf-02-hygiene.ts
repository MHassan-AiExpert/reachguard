import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { continueGate, DECIDE, finalizeNode, stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-02 Hygiene Agent';

export function buildWf02(): N8nWorkflow {
  const d = loadDefaults();
  const h = d.hygiene as {
    allow_role_based: boolean;
    allow_free_providers: boolean;
    company_fuzzy_threshold: number;
    max_contacts_per_company: number;
    company_cooldown_days: number;
  };

  return stageSkeleton({
    name: NAME,
    inputStatus: 'received',
    batch: 5,
    llmGated: false,
    perLead: (f: Flow) => {
      const FIN = 'Finalize lead';
      f.add(
        code(
          'Init state',
          `const lead = $json;
return [{ json: { lead, flags: [...(lead.flags || [])], consent_basis: lead.consent_basis || null, checks: [], decision: null } }];`,
        ),
      );

      // H1 syntax
      f.add(http('H1 Classify email', '/v1/hygiene/classify-email', '{ email: $json.lead.email }'));
      f.add(
        stateCode(
          'H1 Evaluate',
          'Init state',
          `s.cls = r;
s.checks.push({ check_name: 'syntax', outcome: r.syntax_ok ? 'pass' : 'fail', provider: 'rg-tools', detail: { flags: r.flags } });
if (!r.syntax_ok) { ${DECIDE('rejected', 'invalid_syntax')} }`,
        ),
      );
      f.chain('Init state', 'H1 Classify email', 'H1 Evaluate');

      // H2 suppression
      f.add(postgres('H2 Suppression', 'SELECT is_suppressed($1::citext) AS suppressed', '[$json.lead.email]'));
      f.add(
        stateCode(
          'H2 Evaluate',
          'H1 Evaluate',
          `s.checks.push({ check_name: 'suppression', outcome: r.suppressed ? 'fail' : 'pass', provider: 'postgres', detail: {} });
if (r.suppressed) { ${DECIDE('suppressed', 'suppression_list')} }`,
        ),
      );
      continueGate(f, 'H1 Continue?', 'H1 Evaluate', 'H2 Suppression', FIN);
      f.connect('H2 Suppression', 'H2 Evaluate');

      // H3 flags (local, no I/O)
      f.add(
        stateCode(
          'H3 Flags',
          'H2 Evaluate',
          `const fl = s.cls.flags;
const bad = fl.includes('disposable') ? 'disposable'
  : (fl.includes('role') && !${h.allow_role_based}) ? 'role_based'
  : (fl.includes('free_provider') && !${h.allow_free_providers}) ? 'free_provider' : null;
s.checks.push({ check_name: 'email_flags', outcome: bad ? 'fail' : (fl.length ? 'warn' : 'pass'), provider: 'rg-tools', detail: { flags: fl } });
if (bad) { s.decision = { to: 'rejected', reason: bad }; }`,
        ),
      );
      continueGate(f, 'H2 Continue?', 'H2 Evaluate', 'H3 Flags', FIN);

      // H4 region
      const region = f.add(
        postgres(
          'H4 Region rule',
          'SELECT rule FROM region_rules WHERE country = upper($1)',
          `[$json.lead.country ?? '']`,
        ),
      );
      region.alwaysOutputData = true; // no rule row for the country means "allow"
      f.add(
        stateCode(
          'H4 Evaluate',
          'H3 Flags',
          `const rule = r.rule || 'allow';
s.checks.push({ check_name: 'region', outcome: rule === 'allow' ? 'pass' : (rule === 'allow_with_note' ? 'warn' : 'fail'), provider: 'postgres', detail: { rule } });
if (rule === 'blocked') { ${DECIDE('rejected', 'region_blocked')} }
else if (rule === 'restricted') { ${DECIDE('needs_review', 'region_restricted')} }
else if (rule === 'allow_with_note') { s.consent_basis = 'legitimate_interest'; }`,
        ),
      );
      continueGate(f, 'H3 Continue?', 'H3 Flags', 'H4 Region rule', FIN);
      f.connect('H4 Region rule', 'H4 Evaluate');

      // H5 names and company
      f.add(
        http(
          'H5 Normalize',
          '/v1/hygiene/normalize',
          '{ first_name: $json.lead.first_name ?? "", last_name: $json.lead.last_name ?? "", company: $json.lead.company_raw }',
        ),
      );
      f.add(
        stateCode(
          'H5 Normalize eval',
          'H4 Evaluate',
          `s.norm = r;
s.needs_llm = !(Number(r.confidence) >= 0.8);`,
        ),
      );
      f.add(ifNode('H5 Needs LLM?', '$json.needs_llm === true'));
      f.add(
        http(
          'H5 LLM normalize',
          '/v1/llm/run',
          '{ agent: "hygiene-normalizer", lead_id: $json.lead.id, variables: { first_name: $json.lead.first_name ?? "", last_name: $json.lead.last_name ?? "", title: $json.lead.title ?? "", company_raw: $json.lead.company_raw, country: $json.lead.country ?? "" } }',
        ),
      );
      f.add(
        stateCode(
          'H5 Merge names',
          'H5 Normalize eval',
          `const o = r.output;
const n = o && typeof o === 'object' ? o : s.norm;
const llm = !!o;
s.names = { first_name: n.first_name, last_name: n.last_name, company_clean: n.company_clean };
s.checks.push({ check_name: 'normalize', outcome: 'pass', provider: llm ? 'llm' : 'rg-tools', detail: { confidence: n.confidence, llm } });
if (llm && Number(n.confidence) < 0.5) { ${DECIDE('needs_review', 'normalize_uncertain')} }`,
        ),
      );
      continueGate(f, 'H4 Continue?', 'H4 Evaluate', 'H5 Normalize', FIN);
      f.chain('H5 Normalize', 'H5 Normalize eval', 'H5 Needs LLM?');
      f.connect('H5 Needs LLM?', 'H5 LLM normalize', 0);
      f.connect('H5 Needs LLM?', 'H5 Merge names', 1);
      f.connect('H5 LLM normalize', 'H5 Merge names');

      // H6 company resolution (also writes the cleaned names to the lead)
      f.add(
        postgres(
          'H6 Resolve company',
          `WITH n AS (SELECT btrim(regexp_replace(lower($2), '[^a-z0-9]+', ' ', 'g')) AS norm),
by_domain AS (SELECT id FROM companies WHERE $1 <> '' AND domain = $1::citext LIMIT 1),
by_name AS (
  SELECT c.id FROM companies c, n
   WHERE NOT EXISTS (SELECT 1 FROM by_domain)
     AND similarity(c.name_norm, n.norm) >= ${h.company_fuzzy_threshold}
   ORDER BY similarity(c.name_norm, n.norm) DESC LIMIT 1),
ins AS (
  INSERT INTO companies (domain, name_clean, name_norm)
  SELECT NULLIF($1, '')::citext, $2, n.norm FROM n
   WHERE NOT EXISTS (SELECT 1 FROM by_domain) AND NOT EXISTS (SELECT 1 FROM by_name)
  ON CONFLICT (domain) DO NOTHING
  RETURNING id),
picked AS (
  SELECT id FROM by_domain UNION ALL SELECT id FROM by_name UNION ALL SELECT id FROM ins
  UNION ALL SELECT id FROM companies WHERE $1 <> '' AND domain = $1::citext
  LIMIT 1)
UPDATE leads
   SET company_id = (SELECT id FROM picked), company_clean = $2,
       first_name = $3, last_name = $4, full_name = btrim($3 || ' ' || $4)
 WHERE id = $5::uuid
RETURNING company_id`,
          `[ (() => { const l = $json.lead; const w = String(l.website || '').replace(/^https?:\\/\\//i, '').split('/')[0].replace(/^www\\./i, '').toLowerCase(); return w || ($json.cls.flags.includes('free_provider') ? '' : String(l.email_domain || '')); })(), $json.names.company_clean, $json.names.first_name, $json.names.last_name, $json.lead.id ]`,
        ),
      );
      f.add(
        stateCode(
          'H6 Evaluate',
          'H5 Merge names',
          `s.company_id = r.company_id;
s.checks.push({ check_name: 'company', outcome: 'pass', provider: 'postgres', detail: { company_id: r.company_id } });`,
        ),
      );
      continueGate(f, 'H5 Continue?', 'H5 Merge names', 'H6 Resolve company', FIN);
      f.connect('H6 Resolve company', 'H6 Evaluate');

      // H7 company limits
      f.add(
        postgres(
          'H7 Company limits',
          `SELECT
  (SELECT count(*) FROM leads
    WHERE company_id = $1::uuid AND id <> $2::uuid
      AND status IN ('verified','researched','scored','drafted','qa_passed','pending_approval','approved','queued','in_sequence','replied','completed')) AS contacted,
  EXISTS (SELECT 1 FROM sends s JOIN leads l ON l.id = s.lead_id
           WHERE l.company_id = $1::uuid AND l.id <> $2::uuid AND s.status = 'sent'
             AND s.sent_at > now() - make_interval(days => ${h.company_cooldown_days})) AS in_cooldown`,
          '[$json.company_id, $json.lead.id]',
        ),
      );
      f.add(
        stateCode(
          'H7 Evaluate',
          'H6 Evaluate',
          `const over = Number(r.contacted) >= ${h.max_contacts_per_company} || r.in_cooldown === true;
s.checks.push({ check_name: 'company_limits', outcome: over ? 'fail' : 'pass', provider: 'postgres', detail: { contacted: Number(r.contacted), in_cooldown: r.in_cooldown } });
if (over) { ${DECIDE('rejected', 'company_cap')} }`,
        ),
      );
      continueGate(f, 'H6 Continue?', 'H6 Evaluate', 'H7 Company limits', FIN);
      f.connect('H7 Company limits', 'H7 Evaluate');

      // H8 DNS MX
      f.add(http('H8 DNS MX', '/v1/hygiene/dns-mx', '{ domain: $json.lead.email_domain }'));
      f.add(
        stateCode(
          'H8 Evaluate',
          'H7 Evaluate',
          `s.checks.push({ check_name: 'dns_mx', outcome: r.has_mx ? 'pass' : 'fail', provider: 'dns', detail: { hosts: r.hosts } });
if (!r.has_mx) { ${DECIDE('rejected', 'no_mx')} }`,
        ),
      );
      continueGate(f, 'H7 Continue?', 'H7 Evaluate', 'H8 DNS MX', FIN);
      f.connect('H8 DNS MX', 'H8 Evaluate');

      // H9 primary verifier
      f.add(http('H9 Verify primary', '/v1/verify', '{ email: $json.lead.email, tier: "primary", tags: $json.lead.tags ?? [] }'));
      f.add(
        stateCode(
          'H9 Route primary',
          'H8 Evaluate',
          `s.checks.push({ check_name: 'verify_primary', outcome: r.result === 'valid' ? 'pass' : (r.result === 'invalid' ? 'fail' : 'warn'), provider: r.provider, detail: { result: r.result }, cost_usd: r.cost_usd });
s.escalate = false;
if (r.result === 'invalid') { ${DECIDE('rejected', 'invalid_mailbox')} }
else if (r.result !== 'valid') { s.escalate = true; }`,
        ),
      );
      f.add(ifNode('H9 Escalate?', '$json.escalate === true'));
      continueGate(f, 'H8 Continue?', 'H8 Evaluate', 'H9 Verify primary', FIN);
      f.chain('H9 Verify primary', 'H9 Route primary');
      f.connect('H9 Route primary', 'H9 Escalate?');

      // H10 escalation verifier (reached only from H9 Escalate? true)
      f.add(http('H10 Verify escalation', '/v1/verify', '{ email: $json.lead.email, tier: "escalation", tags: $json.lead.tags ?? [] }'));
      f.add(
        stateCode(
          'H10 Evaluate',
          'H9 Route primary',
          `s.checks.push({ check_name: 'verify_escalation', outcome: r.result === 'valid' ? 'pass' : (r.result === 'catch_all' ? 'warn' : 'fail'), provider: r.provider, detail: { result: r.result }, cost_usd: r.cost_usd });
if (r.result === 'catch_all') { if (!s.flags.includes('catch_all')) s.flags.push('catch_all'); }
else if (r.result === 'invalid') { ${DECIDE('rejected', 'invalid_mailbox')} }
else if (r.result !== 'valid') { ${DECIDE('needs_review', 'verifier_inconclusive')} }
s.decision = s.decision || { to: 'verified', reason: 'passed hygiene' };`,
        ),
      );
      f.connect('H9 Escalate?', 'H10 Verify escalation', 0);
      f.chain('H10 Verify escalation', 'H10 Evaluate');

      // No decision means the lead is verified. The escalated path sets this inside H10 Evaluate.
      f.add(stateCode('Verified', 'H9 Route primary', `s.decision = s.decision || { to: 'verified', reason: 'passed hygiene' };`));
      f.connect('H9 Escalate?', 'Verified', 1);
      f.connect('Verified', FIN);
      f.connect('H10 Evaluate', FIN);
      f.add(finalizeNode(FIN, 'received', NAME.slice(0, 5)));
      return { entry: 'Init state', exits: [FIN] };
    },
  });
}
