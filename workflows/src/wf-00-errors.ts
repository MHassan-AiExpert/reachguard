import { loadDefaults } from './lib/config.js';
import { code, errorTrigger, ifNode, postgres, schedule, telegram } from './lib/nodes.js';
import { createFlow, type N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-00 Error Handler and Janitor';

/** Alert thresholds the spec leaves to the Janitor; they live here until they need to be per-campaign. */
export const DEAD_LETTER_ALERT_AT = 5;
export const BACKLOG_ALERT_AT = 50;
export const JANITOR_ALERT_THROTTLE_MINUTES = 60;

const CHAT = `(SELECT value #>> '{}' FROM settings WHERE key = 'telegram_alert_chat_id')`;

export function buildWf00(): N8nWorkflow {
  const d = loadDefaults();
  const f = createFlow();

  // Branch A: failed executions of any other workflow.
  f.add(errorTrigger());
  f.add(
    postgres(
      'Record failure',
      `INSERT INTO runs (workflow, execution_id, status, ended_at, error)
       VALUES ($1, $2, 'failed', now(), $3::jsonb)
       RETURNING id`,
      `[$json.workflow.name, String($json.execution.id), JSON.stringify({ message: String($json.execution.error?.message ?? 'unknown error').slice(0, 500), node: $json.execution.lastNodeExecuted ?? null, url: $json.execution.url ?? null })]`,
    ),
  );
  f.add(
    postgres(
      'Check alert dedupe',
      `SELECT
         (SELECT count(*) FROM runs
           WHERE workflow = $1 AND status = 'failed' AND id <> $3::uuid
             AND error->>'message' = $2 AND started_at > now() - interval '15 minutes') = 0 AS should_alert,
         ${CHAT} AS chat_id`,
      `[$('Error Trigger').first().json.workflow.name, String($('Error Trigger').first().json.execution.error?.message ?? 'unknown error').slice(0, 500), $json.id]`,
    ),
  );
  f.add(ifNode('Alert needed', '$json.should_alert === true && !!$json.chat_id'));
  f.add(
    telegram(
      'Alert workflow error',
      '$json.chat_id',
      '"ReachGuard error in " + $(\'Error Trigger\').first().json.workflow.name + "\\nNode: " + ($(\'Error Trigger\').first().json.execution.lastNodeExecuted ?? "n/a") + "\\n" + String($(\'Error Trigger\').first().json.execution.error?.message ?? "unknown error").slice(0, 300)',
    ),
  );
  f.chain('Error Trigger', 'Record failure', 'Check alert dedupe', 'Alert needed');
  f.connect('Alert needed', 'Alert workflow error', 0);

  // Branch B: the Janitor. Every step is one statement that always returns one row, so the chain never stops early.
  f.add(schedule('Janitor every 5 minutes', 5));
  f.add(
    postgres(
      'Purge raw payloads',
      `WITH x AS (
         UPDATE leads SET raw_payload = NULL
          WHERE raw_payload IS NOT NULL AND created_at < now() - make_interval(days => $1::int)
         RETURNING 1)
       SELECT count(*) AS purged FROM x`,
      `[${d.retention.raw_payload_days}]`,
    ),
  );
  f.add(
    postgres(
      'Close stuck runs',
      `WITH x AS (
         UPDATE runs
            SET status = 'failed', ended_at = now(),
                error = jsonb_build_object('message', 'stuck in started for over 30 minutes; closed by janitor')
          WHERE status = 'started' AND started_at < now() - interval '30 minutes'
         RETURNING 1)
       SELECT count(*) AS closed FROM x`,
    ),
  );
  f.add(
    postgres(
      'Expire approvals',
      `WITH exp AS (
         UPDATE approvals
            SET decision = 'expired', decided_at = now(), decided_by = 'janitor', reason = 'no decision in time'
          WHERE decision IS NULL AND requested_at < now() - make_interval(hours => $1::int)
         RETURNING lead_id),
       moved AS (
         SELECT transition_lead(l.id, 'pending_approval', 'needs_review', 'approval expired', 'janitor')
           FROM leads l
          WHERE l.id IN (SELECT lead_id FROM exp) AND l.status = 'pending_approval')
       SELECT (SELECT count(*) FROM exp) AS expired, (SELECT count(*) FROM moved) AS moved`,
      `[${d.approval.expire_hours}]`,
    ),
  );
  f.add(
    postgres(
      'Remind approvals',
      `WITH x AS (
         UPDATE approvals SET reminded_at = now()
          WHERE decision IS NULL AND reminded_at IS NULL
            AND requested_at < now() - make_interval(hours => $1::int)
         RETURNING 1)
       SELECT count(*) AS reminded FROM x`,
      `[${d.approval.reminder_hours}]`,
    ),
  );
  f.add(
    postgres(
      'Collect health',
      `SELECT
         (SELECT count(*) FROM dead_letters WHERE status = 'open') AS dead_letters_open,
         COALESCE((SELECT jsonb_object_agg(status, n) FROM (
            SELECT status::text AS status, count(*) AS n FROM leads
             WHERE status IN ('received','verified','researched','scored','drafted','qa_passed','approved')
               AND created_at < now() - interval '1 hour'
             GROUP BY status HAVING count(*) > ${BACKLOG_ALERT_AT}) b), '{}'::jsonb) AS backlog,
         COALESCE((SELECT (value #>> '{}')::timestamptz FROM settings WHERE key = 'janitor_last_alert'), 'epoch')
           < now() - interval '${JANITOR_ALERT_THROTTLE_MINUTES} minutes' AS throttle_open,
         ${CHAT} AS chat_id`,
    ),
  );
  f.add(
    code(
      'Build janitor message',
      `const h = $input.first().json;
const closed = $('Close stuck runs').first().json.closed;
const expired = $('Expire approvals').first().json.expired;
const reminded = $('Remind approvals').first().json.reminded;
const lines = [];
if (Number(h.dead_letters_open) >= ${DEAD_LETTER_ALERT_AT}) lines.push('Open dead letters: ' + h.dead_letters_open);
const stages = Object.entries(h.backlog || {});
if (stages.length) lines.push('Backlog over 1h: ' + stages.map(([s, n]) => s + '=' + n).join(', '));
if (Number(reminded) > 0) lines.push('Approvals waiting past the reminder window: ' + reminded);
if (Number(expired) > 0) lines.push('Approvals expired and moved to needs_review: ' + expired);
if (Number(closed) > 0) lines.push('Stuck runs closed: ' + closed);
return [{ json: { send: lines.length > 0 && h.throttle_open === true && !!h.chat_id, chat_id: h.chat_id, text: 'ReachGuard janitor\\n' + lines.join('\\n') } }];`,
    ),
  );
  f.add(ifNode('Janitor alert needed', '$json.send === true'));
  f.add(telegram('Alert janitor', '$json.chat_id', '$json.text'));
  f.add(
    postgres(
      'Mark janitor alerted',
      `INSERT INTO settings (key, value) VALUES ('janitor_last_alert', to_jsonb(now()::text))
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    ),
  );
  f.chain('Janitor every 5 minutes', 'Purge raw payloads', 'Close stuck runs', 'Expire approvals', 'Remind approvals', 'Collect health', 'Build janitor message', 'Janitor alert needed');
  f.connect('Janitor alert needed', 'Alert janitor', 0);
  f.connect('Alert janitor', 'Mark janitor alerted');
  return f.build(NAME);
}
