import { code, http, ifNode, noOp, postgres } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import type { Flow, N8nWorkflow } from './lib/workflow.js';

/** Calendar days after the last send before a quiet sequence is marked completed (leaves room for late replies). */
export const COMPLETE_AFTER_DAYS = 3;

/**
 * First blocking pre-send check, in spec order. Suppression and stop events end the sequence ("cancel"); a kill
 * switch, a paused domain or a daily cap only means "not now" ("defer"), so the approved sequence is kept.
 */
export const PRESEND_FN = `function firstBlock(c) {
  const order = [
    ['kill_switch', 'defer'],
    ['suppressed', 'cancel'],
    ['stop_event', 'cancel'],
    ['domain_inactive', 'defer'],
    ['inbox_capped', 'defer'],
    ['campaign_capped', 'defer'],
  ];
  for (const [reason, action] of order) if (c[reason] === true) return { reason, action };
  return null;
}`;

export function buildWf08a(): N8nWorkflow {
  const name = 'WF-08a Send Scheduler';
  return stageSkeleton({
    name,
    inputStatus: 'approved',
    batch: 5,
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json, decision: null, defer: false } }];`));
      f.add(
        postgres(
          'Load send inputs',
          `SELECT is_suppressed($1::citext) AS suppressed,
  EXISTS (SELECT 1 FROM sender_inboxes i JOIN sending_domains d ON d.domain = i.domain
           WHERE i.status = 'active' AND d.status = 'active') AS sender_available,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('step', q.step, 'delay', q.delay) ORDER BY q.step)
              FROM (SELECT (x->>'step')::int AS step, COALESCE((x->>'delay_business_days')::int, 0) AS delay
                      FROM campaigns c, jsonb_array_elements(c.sequence) AS x WHERE c.id = $2::uuid) q), '[]'::jsonb) AS sequence,
  COALESCE((SELECT jsonb_agg(dr.step ORDER BY dr.step) FROM drafts dr
             WHERE dr.lead_id = $3::uuid AND dr.status = 'approved'
               AND dr.revision = (SELECT max(revision) FROM drafts WHERE lead_id = $3::uuid AND status = 'approved')), '[]'::jsonb) AS draft_steps`,
          '[$json.lead.email, $json.lead.campaign_id, $json.lead.id]',
        ),
      );
      f.add(
        stateCode(
          'Inputs evaluate',
          'Init state',
          `s.suppressed = r.suppressed === true;
s.steps = r.draft_steps || [];
s.delays = s.steps.map((st, i) => i === 0 ? 0 : ((r.sequence || []).find((x) => x.step === st) || { delay: 0 }).delay);
// No usable sender or no approved drafts: leave the lead approved. Its lease expires and it is picked up again.
s.defer = !s.suppressed && (r.sender_available !== true || s.steps.length === 0);`,
        ),
      );
      f.add(ifNode('Suppressed?', '$json.suppressed === true'));
      f.add(
        postgres(
          'Mark suppressed',
          `SELECT transition_lead($1::uuid, 'approved'::lead_status, 'suppressed'::lead_status, 'suppression list at scheduling', 'WF-08a') AS transitioned`,
          '[$json.lead.id]',
        ),
      );
      f.add(ifNode('Ready to plan?', '$json.defer !== true'));
      f.add(noOp('Defer'));
      f.add(
        http(
          'Plan times',
          '/v1/schedule/plan',
          '{ timezone: $json.lead.timezone ?? undefined, country: $json.lead.country ?? undefined, delays: $json.delays }',
        ),
      );
      f.add(
        stateCode(
          'Plan evaluate',
          'Inputs evaluate',
          `s.mode = r.mode;
s.allowed = !(r.mode === 'live' && r.live_send_enabled !== true);
s.plan = s.steps.map((st, i) => ({ step: st, at: r.times[i].at }));`,
        ),
      );
      f.add(ifNode('Plan allowed?', '$json.allowed === true'));
      f.add(
        postgres(
          'Create sends',
          `WITH d AS (
  SELECT id, step FROM drafts
   WHERE lead_id = $1::uuid AND status = 'approved'
     AND revision = (SELECT max(revision) FROM drafts WHERE lead_id = $1::uuid AND status = 'approved')),
ins AS (
  INSERT INTO sends (lead_id, draft_id, step, mode, scheduled_at)
  SELECT $1::uuid, d.id, d.step, $2, t.at
    FROM d JOIN jsonb_to_recordset($3::jsonb) AS t(step int, at timestamptz) ON t.step = d.step
  ON CONFLICT (lead_id, step) DO NOTHING
  RETURNING 1)
SELECT transition_lead($1::uuid, 'approved'::lead_status, 'queued'::lead_status, 'sequence scheduled', 'WF-08a') AS transitioned,
       (SELECT count(*) FROM ins) AS sends_created`,
          '[$json.lead.id, $json.mode, JSON.stringify($json.plan)]',
        ),
      );

      f.chain('Init state', 'Load send inputs', 'Inputs evaluate', 'Suppressed?');
      f.connect('Suppressed?', 'Mark suppressed', 0);
      f.connect('Suppressed?', 'Ready to plan?', 1);
      f.connect('Ready to plan?', 'Plan times', 0);
      f.connect('Ready to plan?', 'Defer', 1);
      f.chain('Plan times', 'Plan evaluate', 'Plan allowed?');
      f.connect('Plan allowed?', 'Create sends', 0);
      f.connect('Plan allowed?', 'Defer', 1);
      return { entry: 'Init state', exits: ['Mark suppressed', 'Create sends', 'Defer'] };
    },
  });
}

/** Due sends, earliest step per lead, locking the lead so two workers never send for it at once. */
const CLAIM_DUE_SENDS = `WITH cand AS (
  SELECT DISTINCT ON (s.lead_id) s.id AS send_id, s.lead_id, s.step, s.scheduled_at
    FROM sends s JOIN leads l ON l.id = s.lead_id
   WHERE s.status = 'scheduled' AND s.scheduled_at <= now()
     AND l.status IN ('queued', 'in_sequence')
     AND (l.locked_at IS NULL OR l.locked_at < now() - interval '10 minutes')
     AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= now())
   ORDER BY s.lead_id, s.step),
due AS (
  SELECT c.send_id, c.lead_id, c.step, c.scheduled_at
    FROM cand c JOIN leads l ON l.id = c.lead_id
   ORDER BY c.scheduled_at
   LIMIT 10
     FOR UPDATE OF l SKIP LOCKED),
lk AS (
  UPDATE leads SET locked_by = $1, locked_at = now(), attempts = attempts + 1 WHERE id IN (SELECT lead_id FROM due) RETURNING id)
SELECT d.lead_id AS id, d.send_id, d.step, l.campaign_id, l.email::text AS email, l.status::text AS lead_status
  FROM due d JOIN leads l ON l.id = d.lead_id
 ORDER BY d.scheduled_at`;

export function buildWf08b(): N8nWorkflow {
  const name = 'WF-08b Send Dispatcher';
  return stageSkeleton({
    name,
    inputStatus: 'queued',
    batch: 10,
    everyMinutes: 2,
    claim: { query: CLAIM_DUE_SENDS },
    prelude: [
      postgres(
        'Complete finished sequences',
        `WITH done AS (
  SELECT l.id FROM leads l
   WHERE l.status = 'in_sequence'
     AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.lead_id = l.id AND s.status = 'scheduled')
     AND (SELECT max(sent_at) FROM sends WHERE lead_id = l.id) < now() - interval '${COMPLETE_AFTER_DAYS} days'),
moved AS (
  SELECT transition_lead(id, 'in_sequence'::lead_status, 'completed'::lead_status, 'sequence finished', 'WF-08b') FROM done)
SELECT count(*) AS completed FROM moved`,
      ),
    ],
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json } }];`));
      f.add(
        postgres(
          'Pre-send checks',
          `SELECT
  COALESCE((SELECT value FROM settings WHERE key = 'kill_switch'), 'false'::jsonb) = 'true'::jsonb AS kill_switch,
  is_suppressed($2::citext) AS suppressed,
  EXISTS (SELECT 1 FROM events WHERE lead_id = $1::uuid AND type IN ('reply', 'unsubscribe', 'bounce_hard', 'complaint')) AS stop_event,
  NOT EXISTS (SELECT 1 FROM sender_inboxes i JOIN sending_domains d ON d.domain = i.domain
               WHERE i.status = 'active' AND d.status = 'active') AS domain_inactive,
  NOT EXISTS (SELECT 1 FROM sender_inboxes i JOIN sending_domains d ON d.domain = i.domain
               WHERE i.status = 'active' AND d.status = 'active'
                 AND (SELECT count(*) FROM sends x WHERE x.inbox_id = i.id AND x.status = 'sent'
                         AND x.sent_at >= date_trunc('day', now())) < i.daily_limit) AS inbox_capped,
  (SELECT count(*) FROM sends x JOIN leads l ON l.id = x.lead_id
    WHERE l.campaign_id = $3::uuid AND x.status = 'sent' AND x.sent_at >= date_trunc('day', now()))
    >= COALESCE((SELECT daily_send_cap FROM campaigns WHERE id = $3::uuid), 0) AS campaign_capped`,
          '[$json.lead.id, $json.lead.email, $json.lead.campaign_id]',
        ),
      );
      f.add(
        stateCode(
          'Block evaluate',
          'Init state',
          `${PRESEND_FN}
s.block = firstBlock(r);`,
        ),
      );
      f.add(ifNode('Blocked?', '!!$json.block'));
      f.add(ifNode('Cancel sequence?', "$json.block.action === 'cancel'"));
      f.add(
        postgres(
          'Cancel sequence',
          `WITH cx AS (
  UPDATE sends SET status = 'cancelled', failure = $2 WHERE lead_id = $1::uuid AND status = 'scheduled' RETURNING 1),
mv AS (
  SELECT transition_lead(l.id, l.status, 'suppressed'::lead_status, $2, 'WF-08b')
    FROM leads l WHERE l.id = $1::uuid AND $2 = 'suppressed' AND l.status IN ('queued', 'in_sequence'))
SELECT (SELECT count(*) FROM cx) AS cancelled, (SELECT count(*) FROM mv) AS suppressed`,
          '[$json.lead.id, $json.block.reason]',
        ),
      );
      f.add(
        http('Send email', '/v1/send', '{ send_id: $json.lead.send_id }', { neverError: true }),
      );
      f.add(
        stateCode(
          'Send evaluate',
          'Init state',
          `const code = Number(r.statusCode);
const body = r.body || {};
s.send_status = code;
s.sent = code === 200 && body.status === 'sent';
// 409 and 423 are refusals the send route has already handled (suppressed, not sendable, kill switch, capped).
if (!s.sent && code >= 500) throw new Error('send failed: ' + code + ' ' + JSON.stringify(body).slice(0, 300));`,
        ),
      );
      f.add(ifNode('First step sent?', "$json.sent === true && Number($json.lead.step) === 1 && $json.lead.lead_status === 'queued'"));
      f.add(
        postgres(
          'Mark in sequence',
          `SELECT transition_lead($1::uuid, 'queued'::lead_status, 'in_sequence'::lead_status, 'first step sent', 'WF-08b') AS transitioned`,
          '[$json.lead.id]',
        ),
      );
      f.add(
        postgres(
          'Unlock lead',
          `UPDATE leads SET locked_by = NULL, locked_at = NULL, attempts = 0, next_attempt_at = NULL WHERE id = $1::uuid RETURNING id`,
          '[$("Init state").first().json.lead.id]',
        ),
      );

      f.chain('Init state', 'Pre-send checks', 'Block evaluate', 'Blocked?');
      f.connect('Blocked?', 'Cancel sequence?', 0);
      f.connect('Blocked?', 'Send email', 1);
      f.connect('Cancel sequence?', 'Cancel sequence', 0);
      f.connect('Cancel sequence?', 'Unlock lead', 1);
      f.connect('Cancel sequence', 'Unlock lead');
      f.chain('Send email', 'Send evaluate', 'First step sent?');
      f.connect('First step sent?', 'Mark in sequence', 0);
      f.connect('First step sent?', 'Unlock lead', 1);
      return { entry: 'Init state', exits: ['Unlock lead', 'Mark in sequence'] };
    },
  });
}
