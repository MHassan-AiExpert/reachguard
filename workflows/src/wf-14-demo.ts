import { code, executeWorkflow, http, ifNode, manualTrigger, postgres, stopAndError, telegram, wait } from './lib/nodes.js';
import { createFlow, workflowId, type N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-14 Sandbox Demo Runner';
/** The stage loop stops at this cap even if work remains, so a stuck lead cannot hold the run forever. */
export const TIME_CAP_MINUTES = 20;
export const PASS_WAIT_SECONDS = 20;
export const REPLY_WAIT_SECONDS = 10;

const CHAT = `(SELECT value #>> '{}' FROM settings WHERE key = 'telegram_alert_chat_id')`;
const STAGES = ['02', '03', '04', '05', '06', '07a'] as const;

const IN_FLIGHT = ['received', 'verified', 'researched', 'scored', 'drafted', 'qa_passed', 'pending_approval', 'approved', 'queued'];

/**
 * One-click demo: reset, seed, run the pipeline stage by stage until it drains, inject the labeled replies and post
 * the funnel. Everything destructive sits behind the mode check, and the reset route refuses outside sandbox as well.
 */
export function buildWf14(): N8nWorkflow {
  const f = createFlow();

  f.add(manualTrigger('Manual trigger'));
  f.add(http('Check mode', '/v1/schedule/plan', '{ delays: [0] }'));
  f.add(ifNode('Sandbox mode?', "$json.mode === 'sandbox'"));
  f.add(stopAndError('Refuse live mode', 'WF-14 refuses to run: MODE is live. The demo runner resets data and only runs in sandbox mode.'));
  f.add(http('Reset sandbox', '/v1/sandbox/reset', '{}'));
  f.add(http('Seed leads', '/v1/sandbox/seed', '{}'));
  f.add(code('Start clock', `return [{ json: { started_at: Date.now(), deadline: Date.now() + ${TIME_CAP_MINUTES * 60_000}, seed: $json } }];`));
  f.chain('Manual trigger', 'Check mode', 'Sandbox mode?');
  f.connect('Sandbox mode?', 'Reset sandbox', 0);
  f.connect('Sandbox mode?', 'Refuse live mode', 1);
  f.chain('Reset sandbox', 'Seed leads', 'Start clock');

  // Stage loop. A stage that finds nothing to claim returns no items, so every step keeps the chain alive.
  for (const s of STAGES) {
    const n = executeWorkflow(`Run WF-${s}`, workflowId(`WF-${s}`));
    n.alwaysOutputData = true;
    f.add(n);
  }
  f.add(
    postgres(
      'Demo auto-approve',
      `WITH pend AS (SELECT id FROM leads WHERE status = 'pending_approval'),
a AS (
  UPDATE approvals SET decision = 'approved', decided_at = now(), decided_by = 'demo-runner', reason = 'sandbox demo auto-approve'
   WHERE lead_id IN (SELECT id FROM pend) AND decision IS NULL RETURNING 1),
dr AS (
  UPDATE drafts SET status = 'approved' WHERE lead_id IN (SELECT id FROM pend) AND status = 'qa_pass' RETURNING 1)
SELECT count(transition_lead(p.id, 'pending_approval'::lead_status, 'approved'::lead_status, 'sandbox demo auto-approve', 'WF-14'))::int AS auto_approved,
       (SELECT count(*) FROM a)::int AS approvals_closed, (SELECT count(*) FROM dr)::int AS drafts_approved
  FROM pend p`,
    ),
  );
  for (const s of ['08a', '08b']) {
    const n = executeWorkflow(`Run WF-${s}`, workflowId(`WF-${s}`));
    n.alwaysOutputData = true;
    f.add(n);
  }
  f.add(
    postgres(
      'Work remaining',
      `SELECT ((SELECT count(*) FROM leads WHERE status IN (${IN_FLIGHT.map((x) => `'${x}'`).join(', ')}))
       + (SELECT count(*) FROM sends WHERE status = 'scheduled'))::int AS in_flight`,
    ),
  );
  f.add(ifNode('Loop done?', "Number($json.in_flight) === 0 || Date.now() > $('Start clock').first().json.deadline"));
  f.add(wait('Wait between passes', PASS_WAIT_SECONDS));
  f.chain('Start clock', 'Run WF-02', 'Run WF-03', 'Run WF-04', 'Run WF-05', 'Run WF-06', 'Run WF-07a', 'Demo auto-approve', 'Run WF-08a', 'Run WF-08b', 'Work remaining', 'Loop done?');
  f.connect('Loop done?', 'Wait between passes', 1);
  f.connect('Wait between passes', 'Run WF-02');

  // Replies: inject, then wait until WF-09 has classified them (or five minutes have passed).
  f.add(http('Inject replies', '/v1/sandbox/replies/batch', '{}'));
  f.add(
    postgres(
      'Replies pending',
      `SELECT count(*)::int AS pending FROM replies
        WHERE next_action IS NULL AND created_at > now() - interval '5 minutes'`,
    ),
  );
  f.add(ifNode('Replies settled?', 'Number($json.pending) === 0'));
  f.add(wait('Wait for replies', REPLY_WAIT_SECONDS));
  f.connect('Loop done?', 'Inject replies', 0);
  f.chain('Inject replies', 'Replies pending', 'Replies settled?');
  f.connect('Replies settled?', 'Funnel summary', 0);
  f.connect('Replies settled?', 'Wait for replies', 1);
  f.connect('Wait for replies', 'Replies pending');

  f.add(
    postgres(
      'Funnel summary',
      `SELECT
  (SELECT string_agg(status || ': ' || n, E'\\n' ORDER BY status)
     FROM (SELECT status::text AS status, count(*) AS n FROM leads GROUP BY status) t) AS by_status,
  (SELECT string_agg(check_name || ' x' || n, ', ' ORDER BY n DESC)
     FROM (SELECT check_name, count(*) AS n FROM verification_results WHERE outcome = 'fail' GROUP BY check_name) t) AS hygiene_blocks,
  (SELECT string_agg(COALESCE(classification, 'unclassified') || ': ' || n, ', ' ORDER BY classification)
     FROM (SELECT classification, count(*) AS n FROM replies GROUP BY classification) t) AS reply_classes,
  (SELECT count(*) FROM sends WHERE status = 'sent')::int AS emails_sent,
  (SELECT count(*) FROM approvals WHERE decided_by = 'demo-runner')::int AS auto_approved,
  (SELECT COALESCE(sum(cost_usd), 0) FROM llm_calls)::numeric(10,4) AS llm_cost_usd,
  ${CHAT} AS chat_id`,
    ),
  );
  f.add(
    telegram(
      'Post summary',
      '$json.chat_id',
      '"ReachGuard sandbox demo finished" + (Date.now() > $(\'Start clock\').first().json.deadline ? " (time cap reached, some leads were still in flight)" : "") + "\\n\\nLeads by status:\\n" + ($json.by_status ?? "none") + "\\n\\nHygiene blocks: " + ($json.hygiene_blocks ?? "none") + "\\nReplies: " + ($json.reply_classes ?? "none") + "\\nEmails sent (sandbox inbox): " + $json.emails_sent + "\\nLLM cost: $" + $json.llm_cost_usd + "\\n\\n" + $json.auto_approved + " lead(s) were auto-approved by the demo runner in place of a human."',
    ),
  );
  f.connect('Funnel summary', 'Post summary');

  return f.build(NAME);
}
