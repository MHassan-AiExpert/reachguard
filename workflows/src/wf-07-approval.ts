import { loadDefaults } from './lib/config.js';
import { code, http, ifNode, noOp, postgres, switchString, telegram, telegramAnswer, telegramTrigger } from './lib/nodes.js';
import { stageSkeleton } from './lib/skeleton.js';
import { stateCode } from './lib/steps.js';
import { createFlow, type Flow, type N8nWorkflow } from './lib/workflow.js';

const d = loadDefaults();

/** Approval is needed for a configured tier, low judge confidence (or none recorded), or a catch_all address. */
export const APPROVAL_POLICY_FN = `function needsApproval(i) {
  const reasons = [];
  if ((i.require_for_tiers || []).includes(i.tier)) reasons.push('tier_' + i.tier);
  if (!(Number(i.confidence) >= i.below)) reasons.push('low_judge_confidence');
  if ((i.flags || []).includes('catch_all')) reasons.push('catch_all');
  return { require: reasons.length > 0, reasons };
}`;

const SEND_CHAT = `(SELECT value #>> '{}' FROM settings WHERE key = 'telegram_approver_chat_ids')`;

export function buildWf07a(): N8nWorkflow {
  const name = 'WF-07a Approval Dispatcher';
  return stageSkeleton({
    name,
    inputStatus: 'qa_passed',
    batch: 5,
    perLead: (f: Flow) => {
      f.add(code('Init state', `return [{ json: { lead: $json, flags: [...($json.flags || [])] } }];`));
      f.add(
        postgres(
          'Load approval inputs',
          `SELECT c.approval_policy,
  (SELECT dr.qa_report->>'confidence' FROM drafts dr
    WHERE dr.lead_id = $2::uuid AND dr.status = 'qa_pass'
    ORDER BY dr.revision DESC, dr.step LIMIT 1)::numeric AS confidence,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('step', dr.step, 'subject', dr.subject, 'body', dr.body) ORDER BY dr.step)
              FROM drafts dr WHERE dr.lead_id = $2::uuid AND dr.status = 'qa_pass'
               AND dr.revision = (SELECT max(revision) FROM drafts WHERE lead_id = $2::uuid AND status = 'qa_pass')), '[]'::jsonb) AS drafts,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('claim', e.claim, 'url', e.source_url) ORDER BY e.confidence DESC)
              FROM research_evidence e WHERE e.lead_id = $2::uuid), '[]'::jsonb) AS evidence,
  ${SEND_CHAT} AS approver_chat_ids
FROM campaigns c WHERE c.id = $1::uuid`,
          '[$json.lead.campaign_id, $json.lead.id]',
        ),
      );
      f.add(
        stateCode(
          'Policy',
          'Init state',
          `${APPROVAL_POLICY_FN}
const policy = r.approval_policy || {};
const p = needsApproval({
  tier: s.lead.tier,
  flags: s.lead.flags || [],
  confidence: r.confidence,
  require_for_tiers: policy.require_for_tiers || ${JSON.stringify(d.approval.require_for_tiers)},
  below: ${d.approval.require_below_judge_confidence},
});
s.require = p.require;
s.reasons = p.reasons;
s.drafts = r.drafts || [];
s.evidence = r.evidence || [];
s.chat_id = String(r.approver_chat_ids || '').split(',').map((x) => x.trim()).filter(Boolean)[0] || '';`,
        ),
      );
      f.add(ifNode('Approval required?', '$json.require === true'));

      // Auto-approve path
      f.add(
        postgres(
          'Auto approve',
          `WITH a AS (
  INSERT INTO approvals (lead_id, channel, decision, decided_at, decided_by, reason)
  VALUES ($1::uuid, 'policy', 'approved', now(), 'auto_policy', 'auto_policy') RETURNING id),
dr AS (UPDATE drafts SET status = 'approved' WHERE lead_id = $1::uuid AND status = 'qa_pass' RETURNING 1)
SELECT transition_lead($1::uuid, 'qa_passed'::lead_status, 'approved'::lead_status, 'auto_policy', 'WF-07a') AS transitioned,
       (SELECT count(*) FROM dr) AS drafts_approved`,
          '[$json.lead.id]',
        ),
      );

      // Human approval path: sign first, commit the approval and the transition together, then notify (a failed
      // notification cannot leave a half-processed lead).
      f.add(postgres('Mint approval id', 'SELECT gen_random_uuid() AS approval_id'));
      f.add(http('Sign callbacks', '/v1/approvals/sign', '{ approval_id: $json.approval_id }'));
      f.add(
        postgres(
          'Create approval',
          `WITH a AS (
  INSERT INTO approvals (id, lead_id, channel) VALUES ($1::uuid, $2::uuid, 'telegram') RETURNING id)
SELECT transition_lead($2::uuid, 'qa_passed'::lead_status, 'pending_approval'::lead_status, $3, 'WF-07a') AS transitioned,
       (SELECT id FROM a) AS approval_id`,
          '[$("Mint approval id").first().json.approval_id, $("Policy").first().json.lead.id, "approval requested: " + $("Policy").first().json.reasons.join(",")]',
        ),
      );
      f.add(
        code(
          'Compose message',
          `const s = $('Policy').first().json;
const sig = $('Sign callbacks').first().json;
const l = s.lead;
const head = 'Approval needed: tier ' + l.tier + ', score ' + l.score + '\\n' +
  [l.full_name || l.first_name, l.title].filter(Boolean).join(', ') + ' at ' + (l.company_clean || l.company_raw) + '\\n' +
  'Reasons: ' + s.reasons.join(', ') + '\\n\\nEvidence:\\n' +
  s.evidence.slice(0, 5).map((e) => '- ' + e.claim + ' (' + e.url + ')').join('\\n') + '\\n';
const body = s.drafts.map((x) => '\\nStep ' + x.step + (x.subject ? ' | Subject: ' + x.subject : '') + '\\n' + x.body).join('\\n');
const text = (head + body).slice(0, 3900);
return [{ json: { chat_id: s.chat_id, text, approve: sig.approve, edit: sig.edit, reject: sig.reject } }];`,
        ),
      );
      f.add(ifNode('Has recipient?', '!!$json.chat_id'));
      f.add(
        telegram('Send for approval', '$json.chat_id', '$json.text', {}, {
          replyMarkup: 'inlineKeyboard',
          inlineKeyboard: {
            rows: [
              {
                row: {
                  buttons: [
                    { text: 'Approve', additionalFields: { callback_data: '={{ $json.approve }}' } },
                    { text: 'Edit', additionalFields: { callback_data: '={{ $json.edit }}' } },
                    { text: 'Reject', additionalFields: { callback_data: '={{ $json.reject }}' } },
                  ],
                },
              },
            ],
          },
        }),
      );

      f.chain('Init state', 'Load approval inputs', 'Policy', 'Approval required?');
      f.connect('Approval required?', 'Mint approval id', 0);
      f.connect('Approval required?', 'Auto approve', 1);
      f.chain('Mint approval id', 'Sign callbacks', 'Create approval', 'Compose message', 'Has recipient?');
      f.connect('Has recipient?', 'Send for approval', 0);
      f.connect('Has recipient?', 'Lead loop', 1);
      return { entry: 'Init state', exits: ['Auto approve', 'Send for approval'] };
    },
  });
}

/**
 * Classifies a Telegram update. Anything from a chat outside the allowlist is "unauthorized" and never reaches a
 * database write. An edit is a reply to the bot's "Edit approval:<uuid>" message; "Subject: ..." on the first line
 * is optional.
 */
export const CALLBACK_FN = `function classify(u, allowed) {
  const ok = (id) => allowed.map(String).includes(String(id));
  if (u.callback_query) {
    const q = u.callback_query;
    const chat = q.message && q.message.chat ? q.message.chat.id : null;
    if (chat === null || !ok(chat)) return { kind: 'unauthorized' };
    return { kind: 'callback', callback_id: q.id, data: q.data || '', chat_id: String(chat), decided_by: String((q.from && (q.from.username || q.from.id)) || chat) };
  }
  const m = u.message;
  if (!m || !m.chat) return { kind: 'ignore' };
  if (!ok(m.chat.id)) return { kind: 'unauthorized' };
  const replied = m.reply_to_message && m.reply_to_message.text;
  const found = replied ? /approval:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(replied) : null;
  if (!found || typeof m.text !== 'string') return { kind: 'ignore' };
  let subject = null;
  let body = m.text.trim();
  const sm = /^subject:\\s*(.*)\\n+([\\s\\S]*)$/i.exec(body);
  if (sm) { subject = sm[1].trim(); body = sm[2].trim(); }
  return { kind: 'edit_reply', approval_id: found[1].toLowerCase(), subject, body, chat_id: String(m.chat.id), decided_by: String((m.from && (m.from.username || m.from.id)) || m.chat.id) };
}`;

export function buildWf07b(): N8nWorkflow {
  const f = createFlow();
  f.add(telegramTrigger('Telegram Trigger', ['callback_query', 'message']));
  f.add(postgres('Load allowlist', `SELECT ${SEND_CHAT} AS ids`)).alwaysOutputData = true;
  f.add(
    code(
      'Classify update',
      `${CALLBACK_FN}
const update = $('Telegram Trigger').first().json;
const allowed = String($json.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
return [{ json: classify(update, allowed) }];`,
    ),
  );
  f.add(ifNode('Is callback?', "$json.kind === 'callback'"));
  f.add(ifNode('Is edit reply?', "$json.kind === 'edit_reply'"));
  f.add(noOp('Ignore update'));

  // Callback buttons: the HMAC is verified before anything else happens.
  f.add(http('Verify callback', '/v1/approvals/verify', '{ data: $json.data }'));
  f.add(ifNode('Callback valid?', '$json.valid === true'));
  f.add(telegramAnswer('Answer invalid', "$('Classify update').first().json.callback_id", 'Invalid or expired button'));
  f.add(
    postgres(
      'Load approval',
      `SELECT a.id, a.decision, l.status
  FROM approvals a JOIN leads l ON l.id = a.lead_id WHERE a.id = $1::uuid`,
      '[$json.approval_id]',
    ),
  ).alwaysOutputData = true;
  f.add(ifNode('Still pending?', "$json.decision === null && $json.status === 'pending_approval'"));
  f.add(telegramAnswer('Answer already decided', "$('Classify update').first().json.callback_id", 'Already decided'));
  f.add(switchString('Route action', "$('Verify callback').first().json.action", ['approve', 'edit', 'reject']));
  f.add(
    postgres(
      'Approve',
      `WITH a AS (
  UPDATE approvals SET decision = 'approved', decided_at = now(), decided_by = $2
   WHERE id = $1::uuid AND decision IS NULL RETURNING lead_id),
dr AS (UPDATE drafts SET status = 'approved' WHERE lead_id = (SELECT lead_id FROM a) AND status = 'qa_pass' RETURNING 1)
SELECT transition_lead(a.lead_id, 'pending_approval'::lead_status, 'approved'::lead_status, 'approved by ' || $2, 'WF-07b') AS transitioned,
       (SELECT count(*) FROM dr) AS drafts_approved
  FROM a`,
      "[$('Verify callback').first().json.approval_id, $('Classify update').first().json.decided_by]",
    ),
  );
  f.add(
    postgres(
      'Reject',
      `WITH a AS (
  UPDATE approvals SET decision = 'rejected', decided_at = now(), decided_by = $2
   WHERE id = $1::uuid AND decision IS NULL RETURNING lead_id),
dr AS (UPDATE drafts SET status = 'rejected' WHERE lead_id = (SELECT lead_id FROM a) AND status = 'qa_pass' RETURNING 1)
SELECT transition_lead(a.lead_id, 'pending_approval'::lead_status, 'rejected'::lead_status, 'rejected by ' || $2, 'WF-07b') AS transitioned,
       (SELECT count(*) FROM dr) AS drafts_rejected
  FROM a`,
      "[$('Verify callback').first().json.approval_id, $('Classify update').first().json.decided_by]",
    ),
  );
  f.add(
    telegram(
      'Request edit',
      "$('Classify update').first().json.chat_id",
      '"Edit approval:" + $(\'Verify callback\').first().json.approval_id + "\\nReply to THIS message with the new text for step 1. Optionally start with \\"Subject: ...\\" then a blank line, then the body."',
      {},
      { replyMarkup: 'forceReply', forceReply: { force_reply: true } },
    ),
  );
  f.add(telegramAnswer('Answer approved', "$('Classify update').first().json.callback_id", 'Approved'));
  f.add(telegramAnswer('Answer rejected', "$('Classify update').first().json.callback_id", 'Rejected'));
  f.add(telegramAnswer('Answer edit', "$('Classify update').first().json.callback_id", 'Send the replacement text as a reply'));

  // Edit replies: deterministic precheck only. No model is involved in a human edit.
  f.add(
    postgres(
      'Load edit context',
      `SELECT a.id, a.lead_id, a.decision, l.status,
  COALESCE((SELECT max(dr.revision) FROM drafts dr WHERE dr.lead_id = a.lead_id), 0) AS revision,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('step', dr.step, 'subject', dr.subject, 'body', dr.body, 'claims', dr.claims) ORDER BY dr.step)
              FROM drafts dr WHERE dr.lead_id = a.lead_id AND dr.status = 'qa_pass'
               AND dr.revision = (SELECT max(revision) FROM drafts WHERE lead_id = a.lead_id AND status = 'qa_pass')), '[]'::jsonb) AS drafts
  FROM approvals a JOIN leads l ON l.id = a.lead_id WHERE a.id = $1::uuid`,
      '[$json.approval_id]',
    ),
  ).alwaysOutputData = true;
  f.add(ifNode('Edit pending?', "$json.decision === null && $json.status === 'pending_approval' && Array.isArray($json.drafts) && $json.drafts.length > 0"));
  f.add(telegram('Answer edit closed', "$('Classify update').first().json.chat_id", '"That approval is no longer waiting for an edit."'));
  f.add(
    code(
      'Build edited copy',
      `const u = $('Classify update').first().json;
const c = $json;
const sequence = c.drafts.map((x) => x.step === 1
  ? { step: 1, subject: u.subject !== null ? u.subject : x.subject, body: u.body, claims: [] }
  : { step: x.step, subject: x.subject, body: x.body, claims: x.claims });
return [{ json: { lead_id: c.lead_id, approval_id: c.id, revision: c.revision, copy: { variant_label: 'human-edit', sequence } } }];`,
    ),
  );
  f.add(http('Precheck edit', '/v1/copy/precheck', '{ lead_id: $json.lead_id, copy: $json.copy }'));
  f.add(ifNode('Edit ok?', '$json.ok === true'));
  f.add(
    telegram(
      'Send violations',
      "$('Classify update').first().json.chat_id",
      '"Your edit was not saved:\\n- " + ($json.violations || []).join("\\n- ") + "\\nReply again with a corrected text."',
    ),
  );
  f.add(
    postgres(
      'Save edit',
      `WITH a AS (
  UPDATE approvals SET decision = 'edited_approved', decided_at = now(), decided_by = $2, reason = 'human edit'
   WHERE id = $1::uuid AND decision IS NULL RETURNING lead_id),
ins AS (
  INSERT INTO drafts (lead_id, step, variant, revision, subject, body, claims, evidence_ids, status, word_count, shingle_hashes)
  SELECT a.lead_id, x.step, 'human-edit', $3::int + 1, x.subject, x.body, x.claims,
         ARRAY(SELECT jsonb_array_elements_text(x.evidence_ids))::uuid[], 'approved', x.word_count,
         CASE WHEN x.step = 1 THEN ARRAY(SELECT jsonb_array_elements_text($5::jsonb))::bigint[] ELSE '{}'::bigint[] END
    FROM a, jsonb_to_recordset($4::jsonb) AS x(step int, subject text, body text, claims jsonb, evidence_ids jsonb, word_count int)
  RETURNING 1)
SELECT transition_lead(a.lead_id, 'pending_approval'::lead_status, 'approved'::lead_status, 'edited and approved by ' || $2, 'WF-07b') AS transitioned,
       (SELECT count(*) FROM ins) AS drafts_written
  FROM a`,
      `[$('Build edited copy').first().json.approval_id, $('Classify update').first().json.decided_by, $('Build edited copy').first().json.revision, JSON.stringify($('Build edited copy').first().json.copy.sequence.map((x) => ({ step: x.step, subject: x.subject ?? null, body: x.body, claims: x.claims, evidence_ids: [...new Set(x.claims.map((c) => c.evidence_id))], word_count: x.body.trim().split(/\\s+/).length }))), JSON.stringify($('Precheck edit').first().json.shingle_hashes ?? [])]`,
    ),
  );
  f.add(telegram('Confirm edit', "$('Classify update').first().json.chat_id", '"Edit saved and approved."'));

  f.chain('Telegram Trigger', 'Load allowlist', 'Classify update', 'Is callback?');
  f.connect('Is callback?', 'Verify callback', 0);
  f.connect('Is callback?', 'Is edit reply?', 1);
  f.connect('Is edit reply?', 'Load edit context', 0);
  f.connect('Is edit reply?', 'Ignore update', 1);

  f.connect('Verify callback', 'Callback valid?');
  f.connect('Callback valid?', 'Load approval', 0);
  f.connect('Callback valid?', 'Answer invalid', 1);
  f.connect('Load approval', 'Still pending?');
  f.connect('Still pending?', 'Route action', 0);
  f.connect('Still pending?', 'Answer already decided', 1);
  f.connect('Route action', 'Approve', 0);
  f.connect('Route action', 'Request edit', 1);
  f.connect('Route action', 'Reject', 2);
  f.chain('Approve', 'Answer approved');
  f.chain('Reject', 'Answer rejected');
  f.chain('Request edit', 'Answer edit');

  f.connect('Load edit context', 'Edit pending?');
  f.connect('Edit pending?', 'Build edited copy', 0);
  f.connect('Edit pending?', 'Answer edit closed', 1);
  f.chain('Build edited copy', 'Precheck edit', 'Edit ok?');
  f.connect('Edit ok?', 'Save edit', 0);
  f.connect('Edit ok?', 'Send violations', 1);
  f.chain('Save edit', 'Confirm edit');
  return f.build('WF-07b Approval Callback');
}
