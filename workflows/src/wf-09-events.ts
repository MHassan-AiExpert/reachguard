import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, noOp, postgres, respond, switchString, telegram, webhook } from './lib/nodes.js';
import { createFlow, type N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-09 Reply and Event Handler';
export const MIN_CLASSIFIER_CONFIDENCE = 0.7;

/**
 * Code overrides the model (spec 9.2): the unsubscribe keyword rule always wins, and so does any reported unsubscribe
 * intent, because a false suppression is cheap and a missed one is not. Otherwise low confidence goes to a human.
 */
export const ROUTE_REPLY_FN = `function routeReply(out, ruleHit) {
  if (ruleHit === true) return { next_action: 'suppress', reason: 'unsubscribe_rule' };
  if (out.unsubscribe_intent === true || out.classification === 'unsubscribe') return { next_action: 'suppress', reason: 'model_unsubscribe' };
  if (!(Number(out.confidence) >= ${MIN_CLASSIFIER_CONFIDENCE})) return { next_action: 'human_review', reason: 'low_confidence' };
  return { next_action: out.next_action, reason: 'model' };
}`;

const ALERT_CHAT = `(SELECT value #>> '{}' FROM settings WHERE key = 'telegram_alert_chat_id')`;

/** Suppress the email, cancel scheduled sends, and move the lead to suppressed (db/migrations/0004). $1 lead id, $2 email, $3 reason. */
const SUPPRESS_SQL = `SELECT suppressed, cancelled, moved FROM suppress_lead($1::uuid, $2, $3)`;

const EVENT = `$('Insert event').first().json`;
const NORM = `$('Unpack event').first().json`;
const suppressParams = (reason: string): string => `[${EVENT}.lead_id, ${EVENT}.email, ${JSON.stringify(reason)}]`;

export function buildWf09(): N8nWorkflow {
  const d = loadDefaults();
  const softLimit = d.guardian.soft_bounce_suppress_after;
  const f = createFlow();

  f.add(webhook('Events webhook', 'rg/events'));
  f.add(
    code(
      'Extract request',
      `const item = $input.first();
const buf = await this.helpers.getBinaryDataBuffer(0, 'data');
const h = item.json.headers || {};
return [{ json: { raw_body: buf.toString('utf8'), signature: h['x-rg-signature'] || '', timestamp: h['x-rg-timestamp'] || '' } }];`,
    ),
  );
  f.add(http('Verify signature', '/v1/auth/verify-webhook', '{ raw_body: $json.raw_body, signature: $json.signature, timestamp: $json.timestamp }'));
  f.add(ifNode('Signature valid', '$json.valid === true'));
  f.add(respond('Respond 401', 401, '{ error: "invalid_signature" }'));
  f.add(
    code(
      'Parse event',
      `const raw = $('Extract request').first().json.raw_body;
let b;
try { b = JSON.parse(raw); } catch { return [{ json: { ok: false, error: 'invalid_json' } }]; }
const wrapped = b && typeof b === 'object' && typeof b.provider === 'string' && b.payload !== undefined;
return [{ json: { ok: true, provider: wrapped ? b.provider : 'smartlead', payload: wrapped ? b.payload : b } }];`,
    ),
  );
  f.add(ifNode('Body parsed', '$json.ok === true'));
  f.add(respond('Respond 400 body', 400, '{ error: $json.error }'));
  f.add(http('Normalize event', '/v1/events/normalize', '{ provider: $json.provider, payload: $json.payload }', { neverError: true }));
  f.add(ifNode('Event normalized', '$json.statusCode === 200'));
  f.add(respond('Respond 400 event', 400, '{ error: "invalid_event" }'));
  f.add(code('Unpack event', `return [{ json: $json.body }];`));

  // The event row goes in first. A conflict on provider_event_id is a replay: answer 200 and stop.
  f.add(
    postgres(
      'Insert event',
      `WITH l AS (
  SELECT id, email::text AS email, status::text AS status FROM leads
   WHERE ($3::uuid IS NOT NULL AND id = $3::uuid)
      OR ($3::uuid IS NULL AND $5::text IS NOT NULL AND email = $5::citext)
   LIMIT 1),
sd AS (
  SELECT COALESCE((SELECT id FROM sends WHERE id = $4::uuid),
                  (SELECT id FROM sends WHERE lead_id = (SELECT id FROM l) AND status = 'sent' ORDER BY sent_at DESC LIMIT 1)) AS id),
ins AS (
  INSERT INTO events (provider_event_id, lead_id, send_id, type, payload, occurred_at)
  SELECT $1, (SELECT id FROM l), (SELECT id FROM sd), $2, $7::jsonb, $6::timestamptz
  ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING
  RETURNING id)
SELECT (SELECT id FROM ins) AS event_id, (SELECT id FROM ins) IS NOT NULL AS is_new,
       (SELECT id FROM l) AS lead_id, (SELECT email FROM l) AS email, (SELECT status FROM l) AS lead_status,
       (SELECT id FROM sd) AS send_id`,
      `[${NORM}.provider_event_id, ${NORM}.type, ${NORM}.lead_id ?? null, ${NORM}.send_id ?? null, ${NORM}.email ?? null, ${NORM}.occurred_at, JSON.stringify({ body: ${NORM}.body ?? null })]`,
    ),
  );
  f.add(ifNode('New event?', '$json.is_new === true'));
  f.add(respond('Respond duplicate', 200, '{ status: "duplicate" }'));
  f.add(ifNode('Lead known?', '!!$json.lead_id'));
  f.add(respond('Respond ignored', 200, '{ status: "ignored", reason: "unknown_lead" }'));
  f.add(respond('Respond accepted', 200, '{ status: "accepted" }'));
  f.add(
    switchString('Route event type', `${NORM}.type`, ['delivered', 'bounce_hard', 'bounce_soft', 'complaint', 'unsubscribe', 'reply', 'meeting_booked']),
  );

  f.add(noOp('Delivered noted'));

  // bounce_hard
  f.add(postgres('Suppress hard bounce', SUPPRESS_SQL, suppressParams('bounce_hard')));

  // bounce_soft: repeated soft bounces are treated as hard
  f.add(
    postgres(
      'Count soft bounces',
      `SELECT count(*) AS n FROM events
        WHERE lead_id = $1::uuid AND type = 'bounce_soft' AND occurred_at > now() - interval '30 days'`,
      `[${EVENT}.lead_id]`,
    ),
  );
  f.add(ifNode('Soft bounces repeated?', `Number($json.n) >= ${softLimit}`));
  f.add(postgres('Suppress soft bounces', SUPPRESS_SQL, suppressParams('bounce_soft_repeated')));

  // complaint: suppress, flag the domain for Guardian review, alert urgently
  f.add(postgres('Suppress complaint', SUPPRESS_SQL, suppressParams('complaint')));
  f.add(
    postgres(
      'Flag domain',
      `WITH u AS (
  UPDATE sending_domains SET paused_reason = 'complaint received: review before sending more'
   WHERE domain = (SELECT i.domain FROM sends s JOIN sender_inboxes i ON i.id = s.inbox_id WHERE s.id = $1::uuid)
  RETURNING domain)
SELECT (SELECT count(*) FROM u) AS flagged, (SELECT domain FROM u LIMIT 1) AS domain, ${ALERT_CHAT} AS chat_id`,
      `[${EVENT}.send_id ?? null]`,
    ),
  );
  f.add(
    telegram(
      'Alert complaint',
      '$json.chat_id',
      '"URGENT: spam complaint from " + ' + `${EVENT}.email` + ' + ($json.domain ? " (sending domain " + $json.domain + " flagged for review)" : "") + ". The address is suppressed and its sequence cancelled."',
    ),
  );

  // unsubscribe
  f.add(postgres('Suppress unsubscribe', SUPPRESS_SQL, suppressParams('unsubscribe')));

  // reply
  f.add(
    postgres(
      'Store reply',
      `INSERT INTO replies (lead_id, send_id, event_id, body)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4)
       RETURNING id AS reply_id,
         COALESCE((SELECT d.subject FROM sends s JOIN drafts d ON d.id = s.draft_id
                    WHERE s.lead_id = $1::uuid AND s.step = 1), '') AS subject`,
      `[${EVENT}.lead_id, ${EVENT}.send_id ?? null, ${EVENT}.event_id, ${NORM}.body ?? ""]`,
    ),
  );
  f.add(ifNode('Rule hit?', `${NORM}.unsubscribe_rule_hit === true`));
  f.add(postgres('Suppress rule hit', SUPPRESS_SQL, suppressParams('unsubscribe_rule')));
  f.add(
    http(
      'Classify reply',
      '/v1/llm/run',
      `{ agent: "reply-classifier", lead_id: ${EVENT}.lead_id, variables: { subject: $('Store reply').first().json.subject, reply_body: ${NORM}.body ?? "" } }`,
      { neverError: true },
    ),
  );
  f.add(
    code(
      'Apply overrides',
      `${ROUTE_REPLY_FN}
// The gateway can answer 429 (budget), 502 (provider) or 422 (invalid output); then there is no model verdict.
const out = ($json.body && $json.body.output) || { classification: 'other', confidence: 0, summary: 'Classifier unavailable (HTTP ' + ($json.statusCode ?? '?') + '); read this reply yourself.', suggested_response: null, unsubscribe_intent: false, next_action: 'human_review' };
const r = routeReply(out, ${NORM}.unsubscribe_rule_hit === true);
return [{ json: { out, next_action: r.next_action, override_reason: r.reason } }];`,
    ),
  );
  f.add(
    postgres(
      'Save classification',
      `UPDATE replies SET classification = $2, confidence = $3::numeric, summary = $4, suggested_response = $5, next_action = $6
        WHERE id = $1::uuid
       RETURNING id, ${ALERT_CHAT} AS chat_id`,
      `[$('Store reply').first().json.reply_id, $json.out.classification, $json.out.confidence, $json.out.summary, $json.out.suggested_response ?? null, $json.next_action]`,
    ),
  );
  f.add(
    switchString('Route reply action', "$('Apply overrides').first().json.next_action", [
      'suppress',
      'notify_hot',
      'draft_reply',
      'wait',
      'human_review',
      'ignore',
    ]),
  );
  f.add(postgres('Suppress reply', SUPPRESS_SQL, suppressParams('unsubscribe')));
  const markReplied = f.add(
    postgres(
      'Mark replied',
      `WITH cx AS (
  UPDATE sends SET status = 'cancelled', failure = 'reply' WHERE lead_id = $1::uuid AND status = 'scheduled' RETURNING 1)
SELECT transition_lead(l.id, 'in_sequence'::lead_status, 'replied'::lead_status, $2, 'WF-09') AS moved,
       (SELECT count(*) FROM cx) AS cancelled
  FROM leads l WHERE l.id = $1::uuid AND l.status = 'in_sequence'`,
      `[${EVENT}.lead_id, "reply: " + $('Apply overrides').first().json.next_action]`,
    ),
  );
  markReplied.alwaysOutputData = true;
  f.add(
    telegram(
      'Alert reply',
      "$('Save classification').first().json.chat_id",
      `({ notify_hot: "HOT reply", draft_reply: "Objection, suggested reply below", human_review: "Reply needs your review" })[$('Apply overrides').first().json.next_action] + " from " + ${EVENT}.email + "\\n" + $('Apply overrides').first().json.out.summary + "\\n\\nSuggested response:\\n" + ($('Apply overrides').first().json.out.suggested_response ?? "(none)") + "\\n\\nNothing was sent. Reply from your own inbox."`,
    ),
  );
  f.add(
    postgres(
      'Pause sequence',
      `WITH cx AS (
  UPDATE sends SET status = 'cancelled', failure = 'not_now' WHERE lead_id = $1::uuid AND status = 'scheduled' RETURNING 1)
SELECT transition_lead(l.id, 'in_sequence'::lead_status, 'completed'::lead_status, $2, 'WF-09') AS moved,
       (SELECT count(*) FROM cx) AS cancelled
  FROM leads l WHERE l.id = $1::uuid AND l.status = 'in_sequence'`,
      `[${EVENT}.lead_id, "not_now" + ($('Apply overrides').first().json.out.return_date ? " return_date=" + $('Apply overrides').first().json.out.return_date : "")]`,
    ),
  );
  f.add(noOp('Ignore reply'));
  f.add(noOp('Meeting booked noted'));

  f.chain('Events webhook', 'Extract request', 'Verify signature', 'Signature valid');
  f.connect('Signature valid', 'Parse event', 0);
  f.connect('Signature valid', 'Respond 401', 1);
  f.connect('Parse event', 'Body parsed');
  f.connect('Body parsed', 'Normalize event', 0);
  f.connect('Body parsed', 'Respond 400 body', 1);
  f.connect('Normalize event', 'Event normalized');
  f.connect('Event normalized', 'Unpack event', 0);
  f.connect('Event normalized', 'Respond 400 event', 1);
  f.chain('Unpack event', 'Insert event', 'New event?');
  f.connect('New event?', 'Lead known?', 0);
  f.connect('New event?', 'Respond duplicate', 1);
  f.connect('Lead known?', 'Respond accepted', 0);
  f.connect('Lead known?', 'Respond ignored', 1);
  f.connect('Respond accepted', 'Route event type');
  f.connect('Route event type', 'Delivered noted', 0);
  f.connect('Route event type', 'Suppress hard bounce', 1);
  f.connect('Route event type', 'Count soft bounces', 2);
  f.connect('Route event type', 'Suppress complaint', 3);
  f.connect('Route event type', 'Suppress unsubscribe', 4);
  f.connect('Route event type', 'Store reply', 5);
  f.connect('Route event type', 'Meeting booked noted', 6);
  f.connect('Count soft bounces', 'Soft bounces repeated?');
  f.connect('Soft bounces repeated?', 'Suppress soft bounces', 0);
  f.chain('Suppress complaint', 'Flag domain', 'Alert complaint');
  f.connect('Store reply', 'Rule hit?');
  f.connect('Rule hit?', 'Suppress rule hit', 0);
  f.connect('Rule hit?', 'Classify reply', 1);
  f.chain('Classify reply', 'Apply overrides', 'Save classification', 'Route reply action');
  f.connect('Route reply action', 'Suppress reply', 0);
  f.connect('Route reply action', 'Mark replied', 1);
  f.connect('Route reply action', 'Mark replied', 2);
  f.connect('Route reply action', 'Pause sequence', 3);
  f.connect('Route reply action', 'Mark replied', 4);
  f.connect('Route reply action', 'Ignore reply', 5);
  f.chain('Mark replied', 'Alert reply');
  return f.build(NAME);
}
