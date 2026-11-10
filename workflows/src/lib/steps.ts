import { code, ifNode, postgres } from './nodes.js';
import type { Flow, NodeSpec } from './workflow.js';

/**
 * Code node that carries a lead's state through a branching per-lead pipeline. The body sees `s` (a copy of the
 * previous state node's output) and `r` (the output of the node just before it) and mutates `s`.
 */
export function stateCode(name: string, prev: string, body: string): NodeSpec {
  return code(
    name,
    `const s = JSON.parse(JSON.stringify($('${prev}').first().json));
const r = $json;
${body}
return [{ json: s }];`,
  );
}

/**
 * Stage decision, set on state as { to, reason }. The shared Finalize node writes it through transition_lead.
 * `decide(to, reason)` is plain JS that is pasted into code bodies.
 */
export const DECIDE = (to: string, reason: string): string => `s.decision = { to: '${to}', reason: '${reason}' };`;

/** Adds an IF that continues to `next` while no decision was made, and otherwise goes to `finalize`. */
export function continueGate(f: Flow, name: string, from: string, next: string, finalize: string): void {
  f.add(ifNode(name, '!$json.decision'));
  f.connect(from, name);
  f.connect(name, next, 0);
  f.connect(name, finalize, 1);
}

/** Terminal write shared by the WF-02 style stages: lead columns, one verification_results row per check, then the transition. */
export function finalizeNode(name: string, fromStatus: string, actor: string): NodeSpec {
  return postgres(
    name,
    `WITH upd AS (
  UPDATE leads
     SET flags = ARRAY(SELECT jsonb_array_elements_text($4::jsonb)),
         consent_basis = COALESCE($5, consent_basis)
   WHERE id = $1::uuid
   RETURNING id),
chk AS (
  INSERT INTO verification_results (lead_id, check_name, outcome, provider, detail, cost_usd)
  SELECT $1::uuid, x.check_name, x.outcome, x.provider, x.detail, COALESCE(x.cost_usd, 0)
    FROM jsonb_to_recordset($6::jsonb) AS x(check_name text, outcome text, provider text, detail jsonb, cost_usd numeric)
   RETURNING 1)
SELECT transition_lead(upd.id, '${fromStatus}'::lead_status, $2::lead_status, $3, '${actor}') AS transitioned,
       (SELECT count(*) FROM chk) AS checks_written
  FROM upd`,
    `[$json.lead.id, $json.decision.to, $json.decision.reason, JSON.stringify($json.flags), $json.consent_basis ?? null, JSON.stringify($json.checks)]`,
  );
}
