import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, postgres, schedule, telegram } from './lib/nodes.js';
import { createFlow, type N8nWorkflow } from './lib/workflow.js';

export const NAME = 'WF-11 Domain Guardian';
export const HEALTH_EVERY_MINUTES = 15;
export const DNS_EVERY_MINUTES = 1440;

const CHAT = `(SELECT value #>> '{}' FROM settings WHERE key = 'telegram_alert_chat_id')`;

/**
 * Safety workflow. It has no kill-switch gate on purpose: it must keep protecting sender reputation and spend while
 * sending is stopped. Resuming a paused domain stays a human action.
 */
export function buildWf11(): N8nWorkflow {
  const g = loadDefaults().guardian;
  const f = createFlow();

  // Every 15 minutes: domain health and the LLM budget.
  f.add(schedule('Every 15 minutes', HEALTH_EVERY_MINUTES));
  f.add(
    postgres(
      'Check domain health',
      `WITH bad AS (
  SELECT h.domain, h.sends_7d, h.hard_bounce_rate, h.complaint_rate
    FROM v_domain_health_rates h
    JOIN sending_domains d ON d.domain = h.domain
   WHERE h.sends_7d >= ${g.min_sends_for_rate}
     AND (h.hard_bounce_rate > ${g.hard_bounce_rate_pause} OR h.complaint_rate > ${g.complaint_rate_pause})
     AND d.status <> 'paused'),
pd AS (
  UPDATE sending_domains d
     SET status = 'paused', paused_at = now(),
         paused_reason = 'auto: ' || CASE WHEN b.hard_bounce_rate > ${g.hard_bounce_rate_pause}
                                          THEN 'hard bounce rate ' || round(b.hard_bounce_rate * 100, 2) || '%'
                                          ELSE 'complaint rate ' || round(b.complaint_rate * 100, 3) || '%' END
                         || ' over ' || b.sends_7d || ' sends in 7 days'
    FROM bad b WHERE d.domain = b.domain
  RETURNING d.domain, d.paused_reason),
pi AS (
  UPDATE sender_inboxes SET status = 'paused' WHERE domain IN (SELECT domain FROM pd) RETURNING 1)
SELECT pd.domain::text AS domain, pd.paused_reason, (SELECT count(*) FROM pi) AS inboxes_paused, ${CHAT} AS chat_id
  FROM pd`,
    ),
  );
  f.add(
    telegram(
      'Alert domain paused',
      '$json.chat_id',
      '"Sending domain " + $json.domain + " paused (" + $json.paused_reason + "). Its inboxes are paused too and nothing more will go out from it. Check the cause and DNS authentication, then set status back to active in sending_domains to resume."',
    ),
  );
  f.add(
    postgres(
      'Check LLM budget',
      `WITH s AS (SELECT usd FROM v_llm_spend_today),
cap AS (SELECT (value #>> '{}')::numeric AS usd FROM settings WHERE key = 'llm_daily_budget_usd'),
st AS (SELECT COALESCE((SELECT (value #>> '{}')::boolean FROM settings WHERE key = 'llm_paused'), false) AS paused,
              (SELECT value #>> '{}' FROM settings WHERE key = 'llm_paused_reason') AS reason),
pause AS (
  UPDATE settings SET value = 'true'::jsonb, updated_at = now()
   WHERE key = 'llm_paused' AND (SELECT usd FROM s) > (SELECT usd FROM cap) AND NOT (SELECT paused FROM st)
  RETURNING 1),
why AS (
  INSERT INTO settings (key, value) SELECT 'llm_paused_reason', '"budget"'::jsonb WHERE EXISTS (SELECT 1 FROM pause)
  ON CONFLICT (key) DO UPDATE SET value = '"budget"'::jsonb, updated_at = now()
  RETURNING 1),
resume AS (
  UPDATE settings SET value = 'false'::jsonb, updated_at = now()
   WHERE key = 'llm_paused' AND (SELECT paused FROM st) AND (SELECT reason FROM st) = 'budget'
     AND (SELECT usd FROM s) <= (SELECT usd FROM cap)
  RETURNING 1),
clr AS (
  DELETE FROM settings WHERE key = 'llm_paused_reason' AND EXISTS (SELECT 1 FROM resume) RETURNING 1)
SELECT EXISTS (SELECT 1 FROM pause) AS newly_paused, EXISTS (SELECT 1 FROM resume) AS resumed,
       (SELECT usd FROM s) AS spent_usd, (SELECT usd FROM cap) AS cap_usd, ${CHAT} AS chat_id`,
    ),
  );
  f.add(ifNode('Budget state changed?', '$json.newly_paused === true || $json.resumed === true'));
  f.add(
    telegram(
      'Alert LLM budget',
      '$json.chat_id',
      '$json.newly_paused ? "LLM spend today is $" + Number($json.spent_usd).toFixed(2) + ", over the $" + Number($json.cap_usd).toFixed(2) + " daily budget. LLM stages are paused and resume automatically tomorrow, or set llm_paused to false to resume now." : "LLM budget reset for a new day. LLM stages resumed."',
    ),
  );
  f.connect('Every 15 minutes', 'Check domain health');
  f.connect('Every 15 minutes', 'Check LLM budget');
  f.connect('Check domain health', 'Alert domain paused');
  f.chain('Check LLM budget', 'Budget state changed?');
  f.connect('Budget state changed?', 'Alert LLM budget', 0);

  // Daily: SPF, DKIM and DMARC for each sending domain.
  f.add(schedule('Daily DNS check', DNS_EVERY_MINUTES));
  f.add(postgres('List sending domains', `SELECT domain::text AS domain FROM sending_domains WHERE status <> 'paused' ORDER BY domain`));
  f.add(http('DNS auth check', '/v1/hygiene/dns-auth', '{ domain: $json.domain }', { neverError: true }));
  f.add(
    code(
      'Evaluate DNS',
      `// A failed lookup (rg-tools answers 502 on a DNS timeout) is not a failed check: never pause a domain on a blip.
const doms = $('List sending domains').all();
return $input.all().map((r, i) => {
  const ok = r.json.statusCode === 200;
  const b = (ok && r.json.body) || {};
  const failed = ok ? ['spf', 'dkim', 'dmarc'].filter((k) => b[k + '_ok'] !== true) : [];
  return { json: {
    domain: doms[i].json.domain, checked: ok,
    spf_ok: ok ? b.spf_ok === true : null, dkim_ok: ok ? b.dkim_ok === true : null, dmarc_ok: ok ? b.dmarc_ok === true : null,
    failed,
  } };
});`,
    ),
  );
  f.add(
    postgres(
      'Record DNS result',
      `WITH u AS (
  UPDATE sending_domains
     SET spf_ok = COALESCE($2::boolean, spf_ok), dkim_ok = COALESCE($3::boolean, dkim_ok),
         dmarc_ok = COALESCE($4::boolean, dmarc_ok), checked_at = CASE WHEN $6::boolean THEN now() ELSE checked_at END
   WHERE domain = $1::citext RETURNING domain),
p AS (
  UPDATE sending_domains
     SET status = 'paused', paused_at = now(), paused_reason = 'auto: DNS authentication failed (' || $5 || ')'
   WHERE domain = $1::citext AND $7::boolean AND status <> 'paused'
  RETURNING domain),
pi AS (
  UPDATE sender_inboxes SET status = 'paused' WHERE domain IN (SELECT domain FROM p) RETURNING 1)
SELECT $1::text AS domain, $5::text AS failed, (SELECT count(*) FROM p) > 0 AS newly_paused,
       (SELECT count(*) FROM u) AS updated, (SELECT count(*) FROM pi) AS inboxes_paused, ${CHAT} AS chat_id`,
      '[$json.domain, $json.spf_ok, $json.dkim_ok, $json.dmarc_ok, $json.failed.join(", "), $json.checked, $json.checked && $json.failed.length > 0]',
    ),
  );
  f.add(ifNode('DNS newly paused?', '$json.newly_paused === true'));
  f.add(
    telegram(
      'Alert DNS failure',
      '$json.chat_id',
      '"Sending domain " + $json.domain + " failed DNS authentication (" + $json.failed + "). It and its inboxes are paused. Fix the records, then set status back to active in sending_domains."',
    ),
  );
  f.chain('Daily DNS check', 'List sending domains', 'DNS auth check', 'Evaluate DNS', 'Record DNS result', 'DNS newly paused?');
  f.connect('DNS newly paused?', 'Alert DNS failure', 0);

  return f.build(NAME);
}
